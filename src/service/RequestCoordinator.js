/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import logger from '../logger.js'

export const WorkClass = Object.freeze({
	QUICK_MUTATION: 'quick-mutation',
	ACTIVE_CONTENT: 'active-content',
	EXPLICIT_HEAVY: 'explicit-heavy',
	VISIBLE_REVALIDATION: 'visible-revalidation',
	SPECULATIVE: 'speculative',
	MAINTENANCE: 'maintenance',
})

const PRIORITY = Object.freeze({
	[WorkClass.QUICK_MUTATION]: 0,
	[WorkClass.ACTIVE_CONTENT]: 1,
	[WorkClass.EXPLICIT_HEAVY]: 2,
	[WorkClass.VISIBLE_REVALIDATION]: 3,
	[WorkClass.SPECULATIVE]: 4,
	[WorkClass.MAINTENANCE]: 5,
})
const HTTP_PRIORITY = Object.freeze({
	[WorkClass.QUICK_MUTATION]: 'u=0',
	[WorkClass.ACTIVE_CONTENT]: 'u=1',
	[WorkClass.EXPLICIT_HEAVY]: 'u=2',
	[WorkClass.VISIBLE_REVALIDATION]: 'u=3',
	[WorkClass.SPECULATIVE]: 'u=6, i',
	[WorkClass.MAINTENANCE]: 'u=7, i',
})
const FOREGROUND_CLASSES = new Set([
	WorkClass.QUICK_MUTATION,
	WorkClass.ACTIVE_CONTENT,
	WorkClass.EXPLICIT_HEAVY,
])
const LOW_PRIORITY_CLASSES = new Set([
	WorkClass.SPECULATIVE,
	WorkClass.MAINTENANCE,
])
const GLOBAL_CONCURRENCY = 4
const PER_ACCOUNT_CONCURRENCY = 3
const AGING_INTERVAL_MS = 30_000
const FAIRNESS_AFTER_FOREGROUND_STARTS = 8
const FAIRNESS_MIN_WAIT_MS = 30_000

function cancellationError(message) {
	const error = new Error(message)
	error.name = 'CanceledError'
	error.code = 'ERR_CANCELED'
	return error
}

export function isMailRequest(config) {
	// A request interceptor may reject before Axios attaches a config (for
	// example when the coordinator intentionally drops speculative work).
	// Response-error interceptors still see that cancellation, so this guard
	// must accept an absent config instead of masking the original error.
	return typeof config?.url === 'string' && config.url.includes('/apps/mail/')
}

function normalizedMethod(config) {
	return (config.method ?? 'get').toLowerCase()
}

function inferWorkClass(config) {
	if (Object.values(WorkClass).includes(config.mailWorkClass)) {
		return config.mailWorkClass
	}

	const method = normalizedMethod(config)
	const url = config.url ?? ''
	if (url.includes('/deep-search')) {
		return WorkClass.MAINTENANCE
	}
	if (url.includes('/sync')) {
		return WorkClass.VISIBLE_REVALIDATION
	}
	if (
		(method !== 'get' && method !== 'head')
		&& (
			url.includes('/flags')
			|| url.includes('/tags/')
			|| url.includes('/move')
			|| /\/api\/(?:messages|thread)\/[^/]+$/.test(url)
		)
	) {
		return WorkClass.QUICK_MUTATION
	}
	if (
		url.includes('/body')
		|| url.includes('/html')
		|| url.includes('/thread')
		|| url.includes('/attachment')
		|| url.includes('/attachments')
		|| url.includes('/itineraries')
		|| url.includes('/dkim')
		|| /\/api\/messages(?:\/[^/]+)?$/.test(url)
	) {
		return WorkClass.ACTIVE_CONTENT
	}
	return WorkClass.VISIBLE_REVALIDATION
}

function accountKey(config) {
	return String(config.mailAccountId
		?? config.params?.accountId
		?? config.data?.accountId
		?? 'global')
}

export class RequestCoordinator {
	constructor() {
		this.queue = []
		this.running = 0
		this.runningByClass = new Map()
		this.runningByAccount = new Map()
		this.listeners = new Set()
		this.networkState = typeof navigator !== 'undefined' && navigator.onLine === false
			? 'offline'
			: 'healthy'
		this.foregroundStartsSinceLowPriority = 0
		this.nextId = 1
	}

	acquire({ workClass, accountId, signal }) {
		if (this.networkState === 'offline') {
			return Promise.reject(cancellationError('Mail request skipped while offline'))
		}
		if (
			this.networkState !== 'healthy'
			&& LOW_PRIORITY_CLASSES.has(workClass)
		) {
			return Promise.reject(cancellationError('Background mail request skipped while connectivity is recovering'))
		}
		if (
			workClass === WorkClass.SPECULATIVE
			&& (
				(typeof document !== 'undefined' && document.visibilityState === 'hidden')
				|| this.hasForegroundPressure()
			)
		) {
			return Promise.reject(cancellationError('Speculative mail request dropped under foreground pressure'))
		}

		return new Promise((resolve, reject) => {
			const item = {
				id: this.nextId++,
				workClass,
				accountId,
				signal,
				queuedAt: Date.now(),
				resolve,
				reject,
			}
			if (signal?.aborted) {
				reject(cancellationError('Mail request aborted before it was queued'))
				return
			}
			if (signal) {
				item.onAbort = () => {
					const index = this.queue.indexOf(item)
					if (index !== -1) {
						this.queue.splice(index, 1)
						reject(cancellationError('Mail request aborted while queued'))
						this.emit()
					}
				}
				signal.addEventListener('abort', item.onAbort, { once: true })
			}
			this.queue.push(item)
			this.drain()
			this.emit()
		})
	}

	hasForegroundPressure() {
		return this.queue.some((item) => FOREGROUND_CLASSES.has(item.workClass))
			|| [...FOREGROUND_CLASSES].some((workClass) => (this.runningByClass.get(workClass) ?? 0) > 0)
	}

	effectivePriority(item, now) {
		const basePriority = PRIORITY[item.workClass]
		if (basePriority <= PRIORITY[WorkClass.EXPLICIT_HEAVY]) {
			return basePriority
		}
		const ageBoost = Math.floor((now - item.queuedAt) / AGING_INTERVAL_MS)
		// Maintenance may age ahead of speculative/visible revalidation, but
		// never ahead of an explicit user action.
		return Math.max(basePriority - ageBoost, PRIORITY[WorkClass.EXPLICIT_HEAVY])
	}

	nextRunnableItem() {
		const now = Date.now()
		const ordered = [...this.queue].sort((left, right) => {
			const priorityDelta = this.effectivePriority(left, now) - this.effectivePriority(right, now)
			if (priorityDelta !== 0) {
				return priorityDelta
			}
			const leftIsLow = LOW_PRIORITY_CLASSES.has(left.workClass)
			const rightIsLow = LOW_PRIORITY_CLASSES.has(right.workClass)
			if (leftIsLow !== rightIsLow) {
				return leftIsLow ? 1 : -1
			}
			return left.id - right.id
		})

		const agedLowPriority = ordered.find((item) => (
			LOW_PRIORITY_CLASSES.has(item.workClass)
			&& now - item.queuedAt >= FAIRNESS_MIN_WAIT_MS
			&& this.canStart(item)
		))
		if (
			agedLowPriority
			&& this.foregroundStartsSinceLowPriority >= FAIRNESS_AFTER_FOREGROUND_STARTS
		) {
			return agedLowPriority
		}
		return ordered.find((item) => this.canStart(item))
	}

	canStart(item) {
		if (this.running >= GLOBAL_CONCURRENCY) {
			return false
		}
		const accountRunning = this.runningByAccount.get(item.accountId) ?? 0
		if (accountRunning >= PER_ACCOUNT_CONCURRENCY) {
			return false
		}
		// Keep one global and one per-account browser slot available for a
		// quick mutation. This mirrors the server/FPM reserved capacity.
		if (
			item.workClass !== WorkClass.QUICK_MUTATION
			&& (
				this.running >= GLOBAL_CONCURRENCY - 1
				|| accountRunning >= PER_ACCOUNT_CONCURRENCY - 1
			)
		) {
			return false
		}
		if (
			LOW_PRIORITY_CLASSES.has(item.workClass)
			&& [...LOW_PRIORITY_CLASSES].reduce(
				(total, workClass) => total + (this.runningByClass.get(workClass) ?? 0),
				0,
			) >= 1
		) {
			return false
		}
		return true
	}

	drain() {
		let item = this.nextRunnableItem()
		while (item !== undefined) {
			const startedItem = item
			this.queue.splice(this.queue.indexOf(item), 1)
			startedItem.signal?.removeEventListener('abort', startedItem.onAbort)
			this.running++
			this.runningByClass.set(startedItem.workClass, (this.runningByClass.get(startedItem.workClass) ?? 0) + 1)
			this.runningByAccount.set(startedItem.accountId, (this.runningByAccount.get(startedItem.accountId) ?? 0) + 1)
			if (LOW_PRIORITY_CLASSES.has(startedItem.workClass)) {
				this.foregroundStartsSinceLowPriority = 0
			} else if (FOREGROUND_CLASSES.has(startedItem.workClass)) {
				this.foregroundStartsSinceLowPriority++
			}

			let released = false
			startedItem.resolve(() => {
				if (released) {
					return
				}
				released = true
				this.running--
				this.decrement(this.runningByClass, startedItem.workClass)
				this.decrement(this.runningByAccount, startedItem.accountId)
				this.drain()
				this.emit()
			})
			item = this.nextRunnableItem()
		}
	}

	decrement(map, key) {
		const next = (map.get(key) ?? 1) - 1
		if (next === 0) {
			map.delete(key)
		} else {
			map.set(key, next)
		}
	}

	cancelQueued(workClasses, reason) {
		const cancelled = this.queue.filter((item) => workClasses.has(item.workClass))
		this.queue = this.queue.filter((item) => !workClasses.has(item.workClass))
		cancelled.forEach((item) => {
			item.signal?.removeEventListener('abort', item.onAbort)
			item.reject(cancellationError(reason))
		})
		this.emit()
	}

	setNetworkState(networkState) {
		if (networkState === this.networkState) {
			return
		}
		this.networkState = networkState
		if (networkState === 'offline') {
			this.cancelQueued(
				new Set([
					WorkClass.VISIBLE_REVALIDATION,
					WorkClass.SPECULATIVE,
					WorkClass.MAINTENANCE,
				]),
				'Mail request cancelled because the browser is offline',
			)
		} else if (networkState !== 'healthy') {
			this.cancelQueued(
				LOW_PRIORITY_CLASSES,
				'Background mail request cancelled while connectivity is recovering',
			)
		}
		this.emit()
	}

	reportSuccess() {
		// Recovery is an ordered transaction: authenticated probe, mutation
		// replay, then active-view revalidation. An intermediate 200 must not
		// reopen background traffic before the sequence completes.
		if (this.networkState !== 'recovering') {
			this.setNetworkState('healthy')
		}
	}

	reportFailure(error) {
		if (error?.code === 'ERR_CANCELED') {
			return
		}
		this.setNetworkState(typeof navigator !== 'undefined' && navigator.onLine === false
			? 'offline'
			: 'degraded')
	}

	snapshot() {
		return {
			networkState: this.networkState,
			running: this.running,
			queued: this.queue.length,
			queuedByClass: Object.fromEntries(Object.values(WorkClass).map((workClass) => [
				workClass,
				this.queue.filter((item) => item.workClass === workClass).length,
			])),
		}
	}

	subscribe(listener) {
		this.listeners.add(listener)
		listener(this.snapshot())
		return () => this.listeners.delete(listener)
	}

	emit() {
		const snapshot = this.snapshot()
		this.listeners.forEach((listener) => listener(snapshot))
	}
}

export const requestCoordinator = new RequestCoordinator()

let installed = false

export function installRequestCoordinator() {
	if (installed) {
		return
	}
	installed = true

	axios.interceptors.request.use(async (config) => {
		if (!isMailRequest(config) || config.mailPriorityBypass === true) {
			return config
		}
		const workClass = inferWorkClass(config)
		const release = await requestCoordinator.acquire({
			workClass,
			accountId: accountKey(config),
			signal: config.signal,
		})
		config.mailCoordinatorRelease = release
		config.headers = config.headers ?? {}
		if (typeof config.headers.set === 'function') {
			config.headers.set('X-Mail-Request-Class', workClass)
			config.headers.set('Priority', HTTP_PRIORITY[workClass])
		} else {
			config.headers['X-Mail-Request-Class'] = workClass
			config.headers.Priority = HTTP_PRIORITY[workClass]
		}
		return config
	})

	const release = (config) => {
		config?.mailCoordinatorRelease?.()
		delete config?.mailCoordinatorRelease
	}
	axios.interceptors.response.use(
		(response) => {
			release(response.config)
			if (isMailRequest(response.config)) {
				requestCoordinator.reportSuccess()
			}
			return response
		},
		(error) => {
			release(error.config)
			const status = error.response?.status
			if (
				isMailRequest(error.config)
				&& (
					!error.response
					|| status === 408
					|| status === 425
					|| status === 429
					|| status >= 500
				)
			) {
				requestCoordinator.reportFailure(error)
			}
			return Promise.reject(error)
		},
	)

	if (typeof window !== 'undefined') {
		window.addEventListener('offline', () => requestCoordinator.setNetworkState('offline'))
		window.addEventListener('online', () => requestCoordinator.setNetworkState('recovering'))
	}
	if (typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				requestCoordinator.cancelQueued(
					new Set([WorkClass.SPECULATIVE]),
					'Speculative mail request cancelled while the tab is hidden',
				)
			}
		})
	}

	logger.info('Mail request coordinator installed', requestCoordinator.snapshot())
}

export async function runCrossTabExclusive(name, task, wait = false) {
	if (typeof navigator === 'undefined' || navigator.locks?.request === undefined) {
		return task()
	}
	const options = wait ? {} : { ifAvailable: true }
	return navigator.locks.request(`nextcloud-mail:${name}`, options, (lock) => {
		return lock === null ? undefined : task()
	})
}

const syncChannel = typeof BroadcastChannel === 'undefined'
	? null
	: new BroadcastChannel('nextcloud-mail-sync-v1')

export function broadcastMailEvent(event) {
	syncChannel?.postMessage(event)
}

export function onMailBroadcast(listener) {
	if (syncChannel === null) {
		return () => {}
	}
	const handler = ({ data }) => listener(data)
	syncChannel.addEventListener('message', handler)
	return () => syncChannel.removeEventListener('message', handler)
}
