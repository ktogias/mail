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
	PREFETCH: 'prefetch',
	MAINTENANCE: 'maintenance',
})

export const PRIORITY = Object.freeze({
	[WorkClass.QUICK_MUTATION]: 0,
	[WorkClass.ACTIVE_CONTENT]: 1,
	[WorkClass.EXPLICIT_HEAVY]: 2,
	[WorkClass.VISIBLE_REVALIDATION]: 3,
	[WorkClass.SPECULATIVE]: 4,
	[WorkClass.PREFETCH]: 5,
	[WorkClass.MAINTENANCE]: 6,
})
const HTTP_PRIORITY = Object.freeze({
	[WorkClass.QUICK_MUTATION]: 'u=0',
	[WorkClass.ACTIVE_CONTENT]: 'u=1',
	[WorkClass.EXPLICIT_HEAVY]: 'u=2',
	[WorkClass.VISIBLE_REVALIDATION]: 'u=3',
	[WorkClass.SPECULATIVE]: 'u=6, i',
	[WorkClass.PREFETCH]: 'u=6, i',
	[WorkClass.MAINTENANCE]: 'u=7, i',
})
const FOREGROUND_CLASSES = new Set([
	WorkClass.QUICK_MUTATION,
	WorkClass.ACTIVE_CONTENT,
	WorkClass.EXPLICIT_HEAVY,
])
// Skipped while connectivity is recovering. PREFETCH is deliberately NOT here.
//
// A throttled Gmail body fetch returns 503; that request is ACTIVE_CONTENT,
// and isConnectivityFailure() counts a 5xx on a foreground class as a
// connectivity failure -- so the app goes 'degraded' every time the throttle
// bites. Standing prefetch down there is a loop with the sign backwards: the
// throttle would disable the one mechanism that reduces the logins causing it.
// Prefetch is not additional load; it is the same bodies over fewer
// connections. 'offline' still cancels it, via the check that precedes this
// one and via HIDDEN_CANCEL_CLASSES.
const LOW_PRIORITY_CLASSES = new Set([
	WorkClass.SPECULATIVE,
	WorkClass.MAINTENANCE,
])
const HIDDEN_CANCEL_CLASSES = new Set([
	WorkClass.VISIBLE_REVALIDATION,
	WorkClass.SPECULATIVE,
	WorkClass.PREFETCH,
	WorkClass.MAINTENANCE,
])
const GLOBAL_CONCURRENCY = 4
const PER_ACCOUNT_CONCURRENCY = 3
export const AGING_INTERVAL_MS = 30_000
const FAIRNESS_AFTER_FOREGROUND_STARTS = 8
const FAIRNESS_MIN_WAIT_MS = 30_000
const MAX_PERMIT_HOLD_MS = 150_000

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

/**
 * Decide whether one request failure is evidence that Mail connectivity as a
 * whole is unhealthy.
 *
 * Capacity responses are deliberately excluded: 425/429 mean that the server
 * is reachable and applying backpressure. Likewise, a background sync timing
 * out or receiving a 5xx must not freeze unrelated user actions behind a
 * global recovery transaction. Network failures, the dedicated health probe,
 * and failures of a direct user request still drive connectivity recovery.
 *
 * @param {object} error Axios-style error
 * @param {boolean} online browser connectivity hint
 * @return {boolean}
 */
export function isConnectivityFailure(error, online = typeof navigator === 'undefined' || navigator.onLine !== false) {
	if (error?.code === 'ERR_CANCELED') {
		return false
	}
	if (!online) {
		return true
	}
	if (error?.config?.mailConnectivityProbe === true) {
		return true
	}
	if (!error?.response) {
		return true
	}

	const status = error.response.status
	if (status === 425 || status === 429) {
		return false
	}
	const workClass = inferWorkClass(error.config ?? {})
	return FOREGROUND_CLASSES.has(workClass)
		&& (status === 408 || status >= 500)
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
		this.active = new Map()
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

	acquire({ workClass, accountId, signal, cancel, onRelease, requestKey, onPromote }) {
		// Mobile browsers may freeze a tab after the server has completed a
		// request but before Axios can run its response interceptor. Never let
		// such an orphaned browser-side permit block every future request.
		this.cancelStaleRunning()
		if (this.networkState === 'offline') {
			return Promise.reject(cancellationError('Mail request skipped while offline'))
		}
		if (
			this.networkState !== 'healthy'
			&& LOW_PRIORITY_CLASSES.has(workClass)
		) {
			return Promise.reject(cancellationError('Background mail request skipped while connectivity is recovering'))
		}
		// Neither speculative nor prefetch work is worth starting for a tab
		// nobody is looking at.
		if (
			(workClass === WorkClass.SPECULATIVE || workClass === WorkClass.PREFETCH)
			&& typeof document !== 'undefined'
			&& document.visibilityState === 'hidden'
		) {
			return Promise.reject(cancellationError('Off-screen mail request dropped while the tab is hidden'))
		}
		// Speculative work is dropped outright under foreground pressure --
		// it is a guess about something on screen, and a guess that has to
		// queue is worthless by the time it arrives.
		//
		// Prefetch is NOT. It queues. This distinction is the whole of .95:
		// .94 gave body prefetching the SPECULATIVE class, and
		// hasForegroundPressure() is true whenever a single ACTIVE_CONTENT or
		// QUICK_MUTATION request is in flight or queued -- which, while
		// someone works through a backlog, is essentially always. The feature
		// was rejected before it ever became an HTTP request, so it did
		// nothing in exactly the situation it was built for: zero prefetch
		// calls reached the server in the first hour after deployment.
		//
		// Queuing is right because prefetch is not competing for the user's
		// attention, only for a spare connection. It sits at the bottom of
		// the queue, runs in the pauses between actions, and is cancelled if
		// the tab is hidden or connectivity degrades.
		if (workClass === WorkClass.SPECULATIVE && this.hasForegroundPressure()) {
			return Promise.reject(cancellationError('Speculative mail request dropped under foreground pressure'))
		}

		return new Promise((resolve, reject) => {
			const item = {
				id: this.nextId++,
				workClass,
				accountId,
				signal,
				cancel,
				onRelease,
				requestKey,
				onPromote,
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

	/**
	 * Upgrade a request which was speculative when queued after the user
	 * explicitly opens that same message. The existing promise and network
	 * request remain deduplicated; only its place in this not-yet-started
	 * queue and the eventual HTTP/server priority change.
	 *
	 * @param {string} requestKey stable body/thread identity
	 * @param {string} workClass higher-priority class
	 * @return {boolean} whether a queued request was promoted
	 */
	promoteQueued(requestKey, workClass) {
		if (typeof requestKey !== 'string' || PRIORITY[workClass] === undefined) {
			return false
		}

		const item = this.queue.find((candidate) => candidate.requestKey === requestKey)
		if (item === undefined || PRIORITY[workClass] >= PRIORITY[item.workClass]) {
			return false
		}

		item.workClass = workClass
		item.onPromote?.(workClass)
		this.drain()
		this.emit()
		return true
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
		if (item.workClass === WorkClass.PREFETCH) {
			// Prefetch ages -- otherwise sustained activity would starve it
			// forever, which is the .94 failure by a slower route -- but never
			// past speculative. Warming a body the user has not asked for must
			// not outrank anything they can see.
			return Math.max(basePriority - ageBoost, PRIORITY[WorkClass.SPECULATIVE])
		}
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
		if (this.networkState === 'offline') {
			return false
		}
		if (
			this.networkState !== 'healthy'
			&& LOW_PRIORITY_CLASSES.has(item.workClass)
		) {
			return false
		}
		if (this.running >= GLOBAL_CONCURRENCY) {
			return false
		}
		const accountRunning = this.runningByAccount.get(item.accountId) ?? 0
		if (accountRunning >= PER_ACCOUNT_CONCURRENCY) {
			return false
		}
		// The server deliberately has one global mailmutation FPM worker.
		// Starting several undo-window-deferred mutations at once only moves
		// their queue into FastCGI, where every request's 75-second timeout is
		// already running. Keep that queue in the browser instead: the next
		// mutation starts only after the previous response releases its
		// permit, while active content continues through its separate lane.
		if (
			item.workClass === WorkClass.QUICK_MUTATION
			&& (this.runningByClass.get(WorkClass.QUICK_MUTATION) ?? 0) > 0
		) {
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
			const release = () => {
				if (released) {
					return
				}
				released = true
				this.active.delete(startedItem.id)
				this.running--
				this.decrement(this.runningByClass, startedItem.workClass)
				this.decrement(this.runningByAccount, startedItem.accountId)
				startedItem.onRelease?.()
				this.drain()
				this.emit()
			}
			this.active.set(startedItem.id, {
				...startedItem,
				startedAt: Date.now(),
				release,
			})
			startedItem.resolve(release)
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

	cancelRunning(workClasses, reason) {
		const cancelled = [...this.active.values()]
			.filter((item) => workClasses.has(item.workClass))
		cancelled.forEach((item) => {
			item.cancel?.(reason)
			item.release()
		})
		return cancelled.length
	}

	cancelStaleRunning(
		maxAge = MAX_PERMIT_HOLD_MS,
		now = Date.now(),
		reason = 'Stale mail request cancelled after its coordinator permit expired',
	) {
		const stale = [...this.active.values()]
			.filter((item) => now - item.startedAt >= maxAge)
		stale.forEach((item) => {
			item.cancel?.(reason)
			item.release()
		})
		return stale.length
	}

	setNetworkState(networkState) {
		if (networkState === this.networkState) {
			return
		}
		this.networkState = networkState
		if (networkState === 'offline') {
			this.cancelQueued(
				HIDDEN_CANCEL_CLASSES,
				'Mail request cancelled because the browser is offline',
			)
			this.cancelRunning(
				HIDDEN_CANCEL_CLASSES,
				'Background mail request cancelled because the browser is offline',
			)
		} else if (networkState !== 'healthy') {
			this.cancelQueued(
				LOW_PRIORITY_CLASSES,
				'Background mail request cancelled while connectivity is recovering',
			)
		}
		this.drain()
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
		if (!isConnectivityFailure(error)) {
			return
		}
		this.setNetworkState(typeof navigator !== 'undefined' && navigator.onLine === false
			? 'offline'
			: 'degraded')
	}

	snapshot() {
		const activeUserRequests = this.queue.filter((item) => FOREGROUND_CLASSES.has(item.workClass)).length
			+ [...FOREGROUND_CLASSES].reduce(
				(total, workClass) => total + (this.runningByClass.get(workClass) ?? 0),
				0,
			)
		return {
			networkState: this.networkState,
			running: this.running,
			queued: this.queue.length,
			activeUserRequests,
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

export function promoteMailRequest(requestKey, workClass = WorkClass.ACTIVE_CONTENT) {
	return requestCoordinator.promoteQueued(requestKey, workClass)
}

let installed = false

function createLifecycleAbort(config) {
	const controller = new AbortController()
	const originalSignal = config.signal
	const forwardOriginalAbort = () => controller.abort(originalSignal.reason)
	if (originalSignal?.aborted) {
		forwardOriginalAbort()
	} else {
		originalSignal?.addEventListener('abort', forwardOriginalAbort, { once: true })
	}
	config.signal = controller.signal

	return {
		cancel(reason) {
			if (!controller.signal.aborted) {
				controller.abort(cancellationError(reason))
			}
		},
		cleanup() {
			originalSignal?.removeEventListener('abort', forwardOriginalAbort)
		},
	}
}

export async function coordinateMailRequest(config, coordinator = requestCoordinator) {
	if (!isMailRequest(config) || config.mailPriorityBypass === true) {
		return config
	}

	// @nextcloud/axios transparently retries a 412 CSRF response by cloning
	// the original config and submitting it through the request interceptors
	// again. The clone deliberately retains unknown config fields. Reacquiring
	// here would hold the first permit while the retry waits for a second one,
	// then overwrite the only reference to the first release function. That
	// permanently leaks capacity and can deadlock tab-resume recovery.
	if (typeof config.mailCoordinatorRelease === 'function') {
		return config
	}

	const workClass = inferWorkClass(config)
	let grantedWorkClass = workClass
	const lifecycleAbort = createLifecycleAbort(config)
	let release
	try {
		release = await coordinator.acquire({
			workClass,
			accountId: accountKey(config),
			signal: config.signal,
			cancel: lifecycleAbort.cancel,
			onRelease: lifecycleAbort.cleanup,
			requestKey: config.mailRequestKey,
			onPromote: (promotedWorkClass) => {
				grantedWorkClass = promotedWorkClass
			},
		})
	} catch (error) {
		lifecycleAbort.cleanup()
		throw error
	}
	config.mailCoordinatorRelease = release
	config.mailWorkClass = grantedWorkClass
	config.headers = config.headers ?? {}
	if (typeof config.headers.set === 'function') {
		config.headers.set('X-Mail-Request-Class', grantedWorkClass)
		config.headers.set('Priority', HTTP_PRIORITY[grantedWorkClass])
	} else {
		config.headers['X-Mail-Request-Class'] = grantedWorkClass
		config.headers.Priority = HTTP_PRIORITY[grantedWorkClass]
	}
	return config
}

export function installRequestCoordinator() {
	if (installed) {
		return
	}
	installed = true

	axios.interceptors.request.use((config) => coordinateMailRequest(config))

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
			if (isMailRequest(error.config)) {
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
					HIDDEN_CANCEL_CLASSES,
					'Background mail request cancelled while the tab is hidden',
				)
				requestCoordinator.cancelRunning(
					HIDDEN_CANCEL_CLASSES,
					'Background mail request cancelled while the tab is hidden',
				)
			} else {
				requestCoordinator.cancelStaleRunning()
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

const MAIL_TAB_ID = globalThis.crypto?.randomUUID?.()
	?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const LEASE_PREFIX = 'nextcloud-mail:leader:'

function browserStorage() {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage
	} catch {
		return null
	}
}

function readLease(storage, key) {
	try {
		const parsed = JSON.parse(storage.getItem(key))
		return typeof parsed?.owner === 'string' && Number.isFinite(parsed.expiresAt)
			? parsed
			: null
	} catch {
		return null
	}
}

/**
 * Run a periodic task from one browser tab only.
 *
 * Web Locks prevents simultaneous execution, while the short localStorage
 * lease prevents independently-jittered tabs from taking turns and each
 * running the same sweep a few seconds apart. The lease expires by itself if
 * a tab crashes; server-side freshness/mutexes remain the cross-device guard.
 *
 * @param {string} name Lease namespace.
 * @param {Function} task Periodic task to run as leader.
 * @param {object} options Injectable lease settings.
 * @param {number} options.leaseMs Lease lifetime.
 * @param {Function} options.now Clock used for expiry.
 * @param {Storage|null} options.storage Shared browser storage.
 * @param {string} options.tabId Stable owner id for this tab.
 */
export async function runCrossTabLeader(
	name,
	task,
	{
		leaseMs = 45_000,
		now = Date.now,
		storage = browserStorage(),
		tabId = MAIL_TAB_ID,
	} = {},
) {
	const electAndRun = async () => {
		if (storage !== null) {
			const key = `${LEASE_PREFIX}${name}`
			const timestamp = now()
			const current = readLease(storage, key)
			if (current !== null && current.owner !== tabId && current.expiresAt > timestamp) {
				return { leader: false }
			}
			try {
				storage.setItem(key, JSON.stringify({
					owner: tabId,
					expiresAt: timestamp + leaseMs,
				}))
				if (readLease(storage, key)?.owner !== tabId) {
					return { leader: false }
				}
			} catch {
				// Web Locks still gives simultaneous-execution safety when
				// storage is disabled; fall through to the task.
			}
		}
		return { leader: true, result: await task() }
	}

	const result = await runCrossTabExclusive(`leader:${name}`, electAndRun)
	return result ?? { leader: false }
}

export function releaseCrossTabLeadership(name, {
	storage = browserStorage(),
	tabId = MAIL_TAB_ID,
} = {}) {
	if (storage === null) {
		return
	}
	const key = `${LEASE_PREFIX}${name}`
	if (readLease(storage, key)?.owner === tabId) {
		try {
			storage.removeItem(key)
		} catch {
			// A lease is advisory and self-expiring.
		}
	}
}

const syncChannel = typeof BroadcastChannel === 'undefined'
	? null
	: new BroadcastChannel('nextcloud-mail-sync-v1')

export function broadcastMailEvent(event) {
	syncChannel?.postMessage({
		...event,
		sourceTabId: MAIL_TAB_ID,
	})
}

export function onMailBroadcast(listener) {
	if (syncChannel === null) {
		return () => {}
	}
	const handler = ({ data }) => listener(data)
	syncChannel.addEventListener('message', handler)
	return () => syncChannel.removeEventListener('message', handler)
}
