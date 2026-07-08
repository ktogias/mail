/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Mailbox from '../../../components/Mailbox.vue'
import MailboxLockedError from '../../../errors/MailboxLockedError.js'
import MailboxNotCachedError from '../../../errors/MailboxNotCachedError.js'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

describe('Mailbox', () => {
	let store

	let account
	let mailbox

	beforeEach(() => {
		setActivePinia(createPinia())
		store = useMainStore()
		// Skip mounted()'s own auto-load/sync flow so each test can drive
		// initializeCache()/loadEnvelopes() directly and in isolation.
		store.hasFetchedInitialEnvelopes = true

		account = { id: 4 }
		store.addAccountMutation(account)
		store.addMailboxMutation({
			account,
			mailbox: {
				name: 'Junk',
				databaseId: 38,
				specialUse: ['junk'],
			},
		})
		mailbox = store.mailboxes[38]
	})

	function mountMailbox() {
		return shallowMount(Mailbox, {
			propsData: {
				account,
				mailbox,
				bus: { on: vi.fn(), off: vi.fn() },
			},
			store,
			localVue,
		})
	}

	it('resets loadingCacheInitialization when the forced init sync fails, instead of hanging forever', async () => {
		// Regression: a missing `return`/`.catch()` meant that if the forced
		// sync() a not-yet-cached mailbox needs failed for ANY reason -- a
		// 409 lock conflict from a second query bucket racing the same
		// mailbox's initial sync is entirely ordinary, not an edge case --
		// nothing ever cleared loadingCacheInitialization, and the "Loading
		// messages…" screen stayed up forever even after the mailbox got
		// cached moments later by the winning caller. Confirmed live on
		// ktogias@isi.gr's Junk folder.
		store.syncEnvelopes = vi.fn().mockRejectedValue(new MailboxLockedError('mailbox 38 is locked'))

		const view = mountMailbox()

		await expect(view.vm.initializeCache()).rejects.toThrow(MailboxLockedError)
		expect(view.vm.loadingCacheInitialization).toBe(false)
	})

	it('surfaces an error instead of hanging when cache initialization fails after a not-cached response', async () => {
		store.fetchEnvelopes = vi.fn().mockRejectedValueOnce(new MailboxNotCachedError('mailbox 38 is not cached'))
		store.syncEnvelopes = vi.fn().mockRejectedValue(new MailboxLockedError('mailbox 38 is locked'))

		const view = mountMailbox()

		await view.vm.loadEnvelopes()

		expect(view.vm.loadingCacheInitialization).toBe(false)
		expect(view.vm.error).toBeInstanceOf(MailboxLockedError)
	})

	it('still loads envelopes normally when the forced init sync succeeds', async () => {
		store.fetchEnvelopes = vi.fn()
			.mockRejectedValueOnce(new MailboxNotCachedError('mailbox 38 is not cached'))
			.mockResolvedValueOnce([])
		store.syncEnvelopes = vi.fn().mockResolvedValue({})

		const view = mountMailbox()

		await view.vm.loadEnvelopes()

		expect(view.vm.loadingCacheInitialization).toBe(false)
		expect(view.vm.error).toBe(false)
		expect(store.fetchEnvelopes).toHaveBeenCalledTimes(2)
	})

	it('gives a cold boot into a specific thread a head start before this folder\'s own initial listing fetch', async () => {
		// Regression: a hard refresh landing directly on a thread URL
		// mounts this component and Thread.vue at roughly the same
		// moment, both firing their own fetches at once -- confirmed
		// live to queue behind each other on the small mail FPM pool
		// and 504 the thread's own /html fetch. See Mailbox.vue's
		// mounted().
		store.hasFetchedInitialEnvelopes = false
		store.fetchEnvelopes = vi.fn().mockResolvedValue([])
		store.syncEnvelopes = vi.fn().mockResolvedValue({})

		vi.useFakeTimers()
		try {
			shallowMount(Mailbox, {
				propsData: {
					account,
					mailbox,
					bus: { on: vi.fn(), off: vi.fn() },
				},
				mocks: {
					$route: { params: { threadId: '113097' } },
				},
				store,
				localVue,
			})

			await vi.advanceTimersByTimeAsync(0)
			expect(store.isInteractionPriorityActive()).toBe(true)
			expect(store.fetchEnvelopes).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(300)

			expect(store.fetchEnvelopes).toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it('does not delay the initial listing fetch when there is no thread in the route', async () => {
		store.hasFetchedInitialEnvelopes = false
		store.fetchEnvelopes = vi.fn().mockResolvedValue([])
		store.syncEnvelopes = vi.fn().mockResolvedValue({})

		vi.useFakeTimers()
		try {
			shallowMount(Mailbox, {
				propsData: {
					account,
					mailbox,
					bus: { on: vi.fn(), off: vi.fn() },
				},
				mocks: {
					$route: { params: {} },
				},
				store,
				localVue,
			})

			// No threadId in the route -- fetchEnvelopes should already be
			// reachable without waiting out the 300ms head-start delay.
			await vi.advanceTimersByTimeAsync(0)

			expect(store.fetchEnvelopes).toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
})
