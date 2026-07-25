/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
	coordinateMailRequest,
	isMailRequest,
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
