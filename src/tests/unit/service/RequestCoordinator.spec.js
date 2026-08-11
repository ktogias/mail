/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
	AGING_INTERVAL_MS,
	coordinateMailRequest,
	isConnectivityFailure,
	isMailRequest,
	PRIORITY,
	releaseCrossTabLeadership,
	RequestCoordinator,
	runCrossTabLeader,
	WorkClass,
} from '../../../service/RequestCoordinator.js'

describe('RequestCoordinator', () => {
	it('does not mistake a config-less interceptor cancellation for a mail request', () => {
		expect(isMailRequest(undefined)).toBe(false)
		expect(isMailRequest({})).toBe(false)
		expect(isMailRequest({ url: '/apps/mail/api/messages' })).toBe(true)
	})

	it('treats capacity backpressure as reachable, not a connectivity failure', () => {
		for (const status of [425, 429]) {
			expect(isConnectivityFailure({
				config: {
					url: '/apps/mail/api/messages/123/body',
					mailWorkClass: WorkClass.ACTIVE_CONTENT,
				},
				response: { status },
			})).toBe(false)
		}
	})

	it('does not let a background sync failure degrade global connectivity', () => {
		expect(isConnectivityFailure({
			config: {
				url: '/apps/mail/api/mailboxes/11/sync',
				mailWorkClass: WorkClass.MAINTENANCE,
			},
			response: { status: 502 },
		})).toBe(false)
	})

	it('still recovers connectivity after network and foreground failures', () => {
		expect(isConnectivityFailure({
			config: {
				url: '/apps/mail/api/messages/123/body',
				mailWorkClass: WorkClass.ACTIVE_CONTENT,
			},
		})).toBe(true)
		expect(isConnectivityFailure({
			config: {
				url: '/apps/mail/api/messages/123/body',
				mailWorkClass: WorkClass.ACTIVE_CONTENT,
			},
			response: { status: 503 },
		})).toBe(true)
	})

	it('reports foreground pressure for the complete queued and running lifetime', async () => {
		const coordinator = new RequestCoordinator()
		const release = await coordinator.acquire({
			workClass: WorkClass.ACTIVE_CONTENT,
			accountId: 'account-1',
		})
		expect(coordinator.snapshot().activeUserRequests).toBe(1)

		const queued = coordinator.acquire({
			workClass: WorkClass.ACTIVE_CONTENT,
			accountId: 'account-1',
		})
		await Promise.resolve()
		expect(coordinator.snapshot().activeUserRequests).toBe(2)

		release()
		const releaseQueued = await queued
		expect(coordinator.snapshot().activeUserRequests).toBe(1)
		releaseQueued()
		expect(coordinator.snapshot().activeUserRequests).toBe(0)
	})

	it('keeps background work single-file and starts a quick mutation ahead of it', async () => {
		const coordinator = new RequestCoordinator()
		const releaseBackground = await coordinator.acquire({
			workClass: WorkClass.MAINTENANCE,
			accountId: 'account-1',
		})
		let secondBackgroundStarted = false
		const secondBackground = coordinator.acquire({
			workClass: WorkClass.MAINTENANCE,
			accountId: 'account-2',
		}).then((release) => {
			secondBackgroundStarted = true
			return release
		})
		await Promise.resolve()

		const releaseMutation = await coordinator.acquire({
			workClass: WorkClass.QUICK_MUTATION,
			accountId: 'account-1',
		})

		expect(secondBackgroundStarted).toBe(false)
		expect(coordinator.snapshot().running).toBe(2)

		releaseMutation()
		releaseBackground()
		const releaseSecondBackground = await secondBackground
		releaseSecondBackground()
	})

	it('keeps quick mutations single-file like the global server mutation worker', async () => {
		const coordinator = new RequestCoordinator()
		const releaseFirst = await coordinator.acquire({
			workClass: WorkClass.QUICK_MUTATION,
			accountId: 'account-1',
		})
		let secondStarted = false
		const second = coordinator.acquire({
			workClass: WorkClass.QUICK_MUTATION,
			accountId: 'account-1',
		}).then((release) => {
			secondStarted = true
			return release
		})
		const releaseContent = await coordinator.acquire({
			workClass: WorkClass.ACTIVE_CONTENT,
			accountId: 'account-1',
		})

		await Promise.resolve()

		expect(secondStarted).toBe(false)
		expect(coordinator.snapshot().running).toBe(2)

		releaseFirst()
		const releaseSecond = await second
		expect(secondStarted).toBe(true)

		releaseSecond()
		releaseContent()
	})

	it('serializes quick mutations globally because the server lane is global', async () => {
		const coordinator = new RequestCoordinator()
		const releaseFirst = await coordinator.acquire({
			workClass: WorkClass.QUICK_MUTATION,
			accountId: 'account-1',
		})
		let otherAccountStarted = false
		const otherAccount = coordinator.acquire({
			workClass: WorkClass.QUICK_MUTATION,
			accountId: 'account-2',
		}).then((release) => {
			otherAccountStarted = true
			return release
		})

		await Promise.resolve()
		expect(otherAccountStarted).toBe(false)

		releaseFirst()
		const releaseOtherAccount = await otherAccount
		expect(otherAccountStarted).toBe(true)
		releaseOtherAccount()
	})

	it('promotes a queued speculative request when it becomes the active user open', async () => {
		const coordinator = new RequestCoordinator()
		const releaseBackground = await coordinator.acquire({
			workClass: WorkClass.MAINTENANCE,
			accountId: 'account-1',
		})
		const config = {
			url: '/apps/mail/api/messages/123/body',
			headers: {},
			mailWorkClass: WorkClass.SPECULATIVE,
			mailRequestKey: 'message-body:123',
		}
		const coordinated = coordinateMailRequest(config, coordinator)

		expect(coordinator.snapshot().queuedByClass[WorkClass.SPECULATIVE]).toBe(1)
		expect(coordinator.promoteQueued(
			'message-body:123',
			WorkClass.ACTIVE_CONTENT,
		)).toBe(true)

		const promotedConfig = await coordinated
		expect(promotedConfig.mailWorkClass).toBe(WorkClass.ACTIVE_CONTENT)
		expect(promotedConfig.headers['X-Mail-Request-Class']).toBe(WorkClass.ACTIVE_CONTENT)
		expect(promotedConfig.headers.Priority).toBe('u=1')
		expect(coordinator.snapshot().queuedByClass[WorkClass.SPECULATIVE]).toBe(0)
		expect(coordinator.snapshot().running).toBe(2)

		promotedConfig.mailCoordinatorRelease()
		releaseBackground()
	})

	it('drops speculative work while a foreground action is active', async () => {
		const coordinator = new RequestCoordinator()
		const releaseMutation = await coordinator.acquire({
			workClass: WorkClass.QUICK_MUTATION,
			accountId: 'account-1',
		})

		await expect(coordinator.acquire({
			workClass: WorkClass.SPECULATIVE,
			accountId: 'account-1',
		})).rejects.toMatchObject({ code: 'ERR_CANCELED' })

		releaseMutation()
	})

	it('queues prefetch under foreground pressure instead of dropping it', async () => {
		// THE .95 contract, and the reason .95 exists. .94 gave body
		// prefetching the SPECULATIVE class, and the test directly above
		// documents what that means: dropped whenever a foreground action is
		// active. While working through a backlog something always is, so the
		// feature made zero calls in its first hour live.
		//
		// If prefetch is ever put back on SPECULATIVE, this rejects and says so.
		const coordinator = new RequestCoordinator()
		const releaseMutation = await coordinator.acquire({
			workClass: WorkClass.QUICK_MUTATION,
			accountId: 'account-1',
		})

		// Both asked for under identical conditions. Speculative is refused,
		// prefetch is not: that difference IS the fix, and asserting them
		// together is what makes the test fail if prefetch goes back to
		// SPECULATIVE rather than merely testing that some class works.
		await expect(coordinator.acquire({
			workClass: WorkClass.SPECULATIVE,
			accountId: 'account-1',
		})).rejects.toMatchObject({ code: 'ERR_CANCELED' })

		const releasePrefetch = await coordinator.acquire({
			workClass: WorkClass.PREFETCH,
			accountId: 'account-1',
		})

		releasePrefetch()
		releaseMutation()
	})

	it('still prefetches while connectivity is degraded', async () => {
		// The live condition, encoded. A throttled Gmail body fetch returns
		// 503, that request is ACTIVE_CONTENT, and isConnectivityFailure()
		// counts a 5xx on a foreground class as a connectivity failure -- so
		// the whole app goes 'degraded' every time the throttle bites.
		//
		// .95 first put PREFETCH in LOW_PRIORITY_CLASSES, which is skipped
		// while degraded. That is a loop with the sign backwards: the throttle
		// disables the one mechanism that reduces the logins causing it.
		// Prefetch is not extra load, it is the same work in fewer
		// connections, so degraded is exactly when it should keep running.
		const coordinator = new RequestCoordinator()
		coordinator.setNetworkState('degraded')

		// Maintenance still stands down -- that part was never wrong.
		await expect(coordinator.acquire({
			workClass: WorkClass.MAINTENANCE,
			accountId: 'account-1',
		})).rejects.toMatchObject({ code: 'ERR_CANCELED' })

		const release = await coordinator.acquire({
			workClass: WorkClass.PREFETCH,
			accountId: 'account-1',
		})
		release()
	})

	it('abandons prefetch when the browser goes offline', async () => {
		// Degraded is not offline. With no network at all there is nothing to
		// warm and the request must not sit in a queue holding state.
		const coordinator = new RequestCoordinator()
		coordinator.setNetworkState('offline')

		await expect(coordinator.acquire({
			workClass: WorkClass.PREFETCH,
			accountId: 'account-1',
		})).rejects.toMatchObject({ code: 'ERR_CANCELED' })
	})

	it('never lets an aged prefetch outrank anything the user can see', async () => {
		// Prefetch has to age or sustained activity starves it forever -- the
		// .94 failure by a slower route. But it warms a body nobody asked for,
		// so it must not climb past speculative and start displacing work for
		// content that is actually on screen.
		const coordinator = new RequestCoordinator()
		const now = Date.now()
		const aged = {
			workClass: WorkClass.PREFETCH,
			queuedAt: now - (60 * AGING_INTERVAL_MS),
		}

		expect(coordinator.effectivePriority(aged, now))
			.toBe(PRIORITY[WorkClass.SPECULATIVE])
		expect(coordinator.effectivePriority(aged, now))
			.toBeGreaterThan(PRIORITY[WorkClass.VISIBLE_REVALIDATION])
	})

	it('does not start prefetch for a tab nobody is looking at', async () => {
		const coordinator = new RequestCoordinator()
		const original = Object.getOwnPropertyDescriptor(document, 'visibilityState')
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			get: () => 'hidden',
		})

		try {
			await expect(coordinator.acquire({
				workClass: WorkClass.PREFETCH,
				accountId: 'account-1',
			})).rejects.toMatchObject({ code: 'ERR_CANCELED' })
		} finally {
			if (original) {
				Object.defineProperty(document, 'visibilityState', original)
			} else {
				delete document.visibilityState
			}
		}
	})

	it('cancels queued maintenance when the browser goes offline', async () => {
		const coordinator = new RequestCoordinator()
		const releaseBackground = await coordinator.acquire({
			workClass: WorkClass.MAINTENANCE,
			accountId: 'account-1',
		})
		const queued = coordinator.acquire({
			workClass: WorkClass.MAINTENANCE,
			accountId: 'account-2',
		})

		coordinator.setNetworkState('offline')

		await expect(queued).rejects.toMatchObject({ code: 'ERR_CANCELED' })
		releaseBackground()
	})

	it('pauses background work while connectivity is degraded', async () => {
		const coordinator = new RequestCoordinator()
		coordinator.setNetworkState('degraded')

		await expect(coordinator.acquire({
			workClass: WorkClass.MAINTENANCE,
			accountId: 'account-1',
		})).rejects.toMatchObject({ code: 'ERR_CANCELED' })

		const releaseMutation = await coordinator.acquire({
			workClass: WorkClass.QUICK_MUTATION,
			accountId: 'account-1',
		})
		releaseMutation()
	})

	it('reuses one permit when @nextcloud/axios retries a CSRF failure', async () => {
		const coordinator = new RequestCoordinator()
		const originalConfig = {
			url: '/apps/mail/api/messages/123/body',
			headers: {},
		}
		await coordinateMailRequest(originalConfig, coordinator)
		expect(coordinator.snapshot().running).toBe(1)

		// onCsrfTokenError() clones the entire config, including unknown
		// fields, before submitting it through request interceptors again.
		const retryConfig = {
			...originalConfig,
			headers: {
				...originalConfig.headers,
				requesttoken: 'fresh-token',
			},
			_nextcloudCsrfTokenReloaded: true,
		}
		await coordinateMailRequest(retryConfig, coordinator)

		expect(coordinator.snapshot().running).toBe(1)
		expect(retryConfig.mailCoordinatorRelease)
			.toBe(originalConfig.mailCoordinatorRelease)

		retryConfig.mailCoordinatorRelease()
		expect(coordinator.snapshot().running).toBe(0)
	})

	it('cancels an active background permit when a tab is hidden', async () => {
		const coordinator = new RequestCoordinator()
		const cancel = vi.fn()
		const release = await coordinator.acquire({
			workClass: WorkClass.VISIBLE_REVALIDATION,
			accountId: 'account-1',
			cancel,
		})

		expect(coordinator.cancelRunning(
			new Set([WorkClass.VISIBLE_REVALIDATION]),
			'Tab hidden',
		)).toBe(1)
		expect(cancel).toHaveBeenCalledWith('Tab hidden')
		expect(coordinator.snapshot().running).toBe(0)

		// A later Axios cancellation response may try to release it again.
		release()
		expect(coordinator.snapshot().running).toBe(0)
	})

	it('expires a permit orphaned while the mobile tab was frozen', async () => {
		const coordinator = new RequestCoordinator()
		const cancel = vi.fn()
		await coordinator.acquire({
			workClass: WorkClass.ACTIVE_CONTENT,
			accountId: 'account-1',
			cancel,
		})
		const active = [...coordinator.active.values()][0]

		expect(coordinator.cancelStaleRunning(
			150_000,
			active.startedAt + 150_001,
		)).toBe(1)
		expect(cancel).toHaveBeenCalled()
		expect(coordinator.snapshot().running).toBe(0)
	})

	it('keeps one periodic leader across staggered tab ticks and fails over after expiry', async () => {
		const values = new Map()
		const storage = {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => values.set(key, value),
			removeItem: (key) => values.delete(key),
		}
		let timestamp = 1_000
		const firstTask = vi.fn().mockResolvedValue('first')
		const secondTask = vi.fn().mockResolvedValue('second')

		await expect(runCrossTabLeader('poll', firstTask, {
			storage,
			tabId: 'tab-a',
			now: () => timestamp,
			leaseMs: 100,
		})).resolves.toEqual({ leader: true, result: 'first' })
		await expect(runCrossTabLeader('poll', secondTask, {
			storage,
			tabId: 'tab-b',
			now: () => timestamp + 50,
			leaseMs: 100,
		})).resolves.toEqual({ leader: false })
		expect(secondTask).not.toHaveBeenCalled()

		timestamp += 101
		await expect(runCrossTabLeader('poll', secondTask, {
			storage,
			tabId: 'tab-b',
			now: () => timestamp,
			leaseMs: 100,
		})).resolves.toEqual({ leader: true, result: 'second' })
	})

	it('only lets the owning tab release a leadership lease', async () => {
		const values = new Map()
		const storage = {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => values.set(key, value),
			removeItem: (key) => values.delete(key),
		}
		await runCrossTabLeader('poll', vi.fn(), {
			storage,
			tabId: 'tab-a',
			now: () => 1_000,
		})

		releaseCrossTabLeadership('poll', { storage, tabId: 'tab-b' })
		expect(values.size).toBe(1)
		releaseCrossTabLeadership('poll', { storage, tabId: 'tab-a' })
		expect(values.size).toBe(0)
	})
})
