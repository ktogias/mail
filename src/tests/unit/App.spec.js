/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import App, {
	connectivityRecoveryDelay,
	shouldRetryConnectivityRecovery,
} from '../../App.vue'
import Nextcloud from '../../mixins/Nextcloud.js'
import useMainStore from '../../store/mainStore.js'

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

vi.mock('../../service/AutoConfigService.js')

describe('App', () => {
	let store
	let view

	beforeEach(() => {
		setActivePinia(createPinia())

		store = useMainStore()
		store.isExpiredSession = false

		view = shallowMount(App, {
			store,
			localVue,
		})
	})

	it('handles session expiry', async () => {
		// Stub and prevent the actual reload
		view.vm.reload = vi.fn()

		expect(view.vm.isExpiredSession).toBe(false)
		store.isExpiredSession = true
		expect(view.vm.isExpiredSession).toBe(true)
	})

	it('ticks the watched-mailbox poller every 20-30s, not 10-15s', async () => {
		// Widened 2026-07-08: a second independently-jittered poller (e.g. a
		// phone alongside a desktop tab) only rides the freshness gate when
		// its own tick happens to land inside the first poller's still-fresh
		// window -- with the old 10-15s period, opening a second device
		// roughly doubled the real (non-gated) sync rate for the same
		// watched mailboxes, measurably loading a resource-constrained host.
		vi.useFakeTimers()
		store.syncWatchedMailboxes = vi.fn().mockResolvedValue()

		view.vm.startWatchedMailboxSync()

		// Nothing fires before the new floor.
		vi.advanceTimersByTime(19_999)
		expect(store.syncWatchedMailboxes).not.toHaveBeenCalled()

		// Everything fires by the new ceiling (floor + jitter span).
		vi.advanceTimersByTime(10_001)
		expect(store.syncWatchedMailboxes).toHaveBeenCalledTimes(1)

		vi.useRealTimers()
	})

	describe('attention-aware polling', () => {
		// Page Visibility API best practice (and React Query's default
		// model): no full-rate background refetching in hidden tabs,
		// revalidate on focus. Measured before this change: 1599 sync
		// POSTs per 10 minutes across the household's open tabs.
		function setVisibility(state) {
			Object.defineProperty(document, 'visibilityState', {
				value: state,
				configurable: true,
			})
		}

		afterEach(() => {
			setVisibility('visible')
			vi.useRealTimers()
		})

		it('hidden tab: slows to 60-120s and syncs lightweight', () => {
			vi.useFakeTimers()
			store.syncWatchedMailboxes = vi.fn().mockResolvedValue()
			setVisibility('hidden')

			view.vm.startWatchedMailboxSync()

			vi.advanceTimersByTime(59_999)
			expect(store.syncWatchedMailboxes).not.toHaveBeenCalled()

			vi.advanceTimersByTime(60_002)
			expect(store.syncWatchedMailboxes).toHaveBeenCalledTimes(1)
			expect(store.syncWatchedMailboxes).toHaveBeenCalledWith({ lightweight: true })
		})

		it('visible tab: keeps the full-sync cadence and passes lightweight: false', () => {
			vi.useFakeTimers()
			store.syncWatchedMailboxes = vi.fn().mockResolvedValue()

			view.vm.startWatchedMailboxSync()
			vi.advanceTimersByTime(30_001)

			expect(store.syncWatchedMailboxes).toHaveBeenCalledWith({ lightweight: false })
		})

		it('visible but idle: slows to 60-90s while staying on full syncs', () => {
			vi.useFakeTimers()
			// Deterministic jitter: every delay collapses to its base
			// (visibleActive: 20s, visibleIdle: 60s), so the timeline is
			// exact instead of a range.
			const random = vi.spyOn(Math, 'random').mockReturnValue(0)
			store.syncWatchedMailboxes = vi.fn().mockResolvedValue()

			view.vm.startWatchedMailboxSync()
			// Simulate 10 minutes without input: the first tick fires on
			// the visibleActive schedule it was drawn with (t=20s); its
			// follow-up must be drawn from the idle range (t=20s+60s=80s).
			view.vm.lastActivity = Date.now() - 10 * 60_000

			vi.advanceTimersByTime(20_001)
			expect(store.syncWatchedMailboxes).toHaveBeenCalledTimes(1)
			expect(store.syncWatchedMailboxes).toHaveBeenLastCalledWith({ lightweight: false })
			view.vm.lastActivity = Date.now() - 10 * 60_000

			vi.advanceTimersByTime(59_998) // t=79_999
			expect(store.syncWatchedMailboxes).toHaveBeenCalledTimes(1)
			vi.advanceTimersByTime(2) // t=80_001
			expect(store.syncWatchedMailboxes).toHaveBeenCalledTimes(2)

			random.mockRestore()
		})

		it('unengaged notification bursts widen the hidden delay (engagement decay)', () => {
			vi.useFakeTimers()
			store.syncWatchedMailboxes = vi.fn().mockResolvedValue()
			setVisibility('hidden')
			// min(1.5^3, 4) = 3.375 -> hidden range becomes 202.5-405s.
			store.unengagedNotificationBursts = 3

			view.vm.startWatchedMailboxSync()

			vi.advanceTimersByTime(202_499)
			expect(store.syncWatchedMailboxes).not.toHaveBeenCalled()
			vi.advanceTimersByTime(202_506)
			expect(store.syncWatchedMailboxes).toHaveBeenCalledTimes(1)
		})

		it('becoming visible fires an immediate full tick and resets the engagement decay', () => {
			vi.useFakeTimers()
			store.syncWatchedMailboxes = vi.fn().mockResolvedValue()
			setVisibility('hidden')
			store.unengagedNotificationBursts = 3

			view.vm.startWatchedMailboxSync()
			expect(store.syncWatchedMailboxes).not.toHaveBeenCalled()

			setVisibility('visible')
			document.dispatchEvent(new Event('visibilitychange'))
			vi.advanceTimersByTime(1)

			expect(store.syncWatchedMailboxes).toHaveBeenCalledTimes(1)
			expect(store.syncWatchedMailboxes).toHaveBeenCalledWith({ lightweight: false })
			expect(store.unengagedNotificationBursts).toBe(0)
		})

		it('probes and replays before syncing after a long hidden interval', async () => {
			vi.useFakeTimers()
			store.syncWatchedMailboxes = vi.fn().mockResolvedValue()
			view.vm.recoverConnectivity = vi.fn().mockResolvedValue()
			view.vm.startWatchedMailboxSync()
			view.vm.hiddenAt = Date.now() - 60_001

			setVisibility('visible')
			document.dispatchEvent(new Event('visibilitychange'))
			await Promise.resolve()
			vi.advanceTimersByTime(1)

			expect(view.vm.recoverConnectivity).toHaveBeenCalledTimes(1)
			expect(store.syncWatchedMailboxes).toHaveBeenCalledTimes(1)
		})
	})

	it('doubles the tick period when the server reports itself busy', async () => {
		// this.mainStore.serverBusy reflects the serverBusy field riding
		// the most recent sync response (see SyncService::isServerBusy()) --
		// not a separate request. Only the automatic background poller
		// reads it; user-initiated syncs are never slowed by this.
		vi.useFakeTimers()
		store.syncWatchedMailboxes = vi.fn().mockResolvedValue()
		store.serverBusy = true

		view.vm.startWatchedMailboxSync()

		// Nothing fires before the new (busy) floor -- well past the
		// normal, not-busy ceiling of 30s.
		vi.advanceTimersByTime(39_999)
		expect(store.syncWatchedMailboxes).not.toHaveBeenCalled()

		// Everything fires by the busy ceiling (60s).
		vi.advanceTimersByTime(20_001)
		expect(store.syncWatchedMailboxes).toHaveBeenCalledTimes(1)

		vi.useRealTimers()
	})

	it('honors Retry-After when calculating staged recovery backoff', () => {
		const delay = connectivityRecoveryDelay({
			response: {
				status: 429,
				headers: { 'retry-after': '3' },
			},
		}, 0, 0, 0)

		expect(delay).toBe(3_000)
	})

	it('does not retry a definitive authentication failure', () => {
		expect(shouldRetryConnectivityRecovery({
			response: {
				status: 401,
				headers: {},
			},
		}, true)).toBe(false)
	})
})
