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
})
