/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
	RequestCoordinator,
	WorkClass,
} from '../../../service/RequestCoordinator.js'

describe('RequestCoordinator', () => {
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
})
