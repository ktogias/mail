/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import App from '../../App.vue'
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
})
