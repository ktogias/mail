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

	function mountMailbox(propsOverride = {}) {
		return shallowMount(Mailbox, {
			propsData: {
				account,
				mailbox,
				bus: { on: vi.fn(), off: vi.fn() },
				...propsOverride,
			},
			store,
			localVue,
		})
	}

	describe('empty state wording', () => {
		// isPriorityInbox already forced the "No messages" copy
		// (EmptyMailboxSection) unconditionally. A plain mailbox with an
		// active search term used to fall through to EmptyMailbox's "No
		// messages in this folder" instead -- misleading, since the
		// folder itself can easily have plenty of messages that simply
		// don't match the search (reported live: searching a mailbox for
		// a term with no matches showed folder-is-empty wording).
		it('shows "No messages" (not "folder is empty") when a search query is active and nothing matches', () => {
			const view = mountMailbox({ searchQuery: 'subject:nothing-matches' })

			expect(view.findComponent({ name: 'EmptyMailboxSection' }).exists()).toBe(true)
			expect(view.findComponent({ name: 'EmptyMailbox' }).exists()).toBe(false)
		})

		it('keeps "folder is empty" wording for the plain, unfiltered view', () => {
			const view = mountMailbox()

			expect(view.findComponent({ name: 'EmptyMailbox' }).exists()).toBe(true)
			expect(view.findComponent({ name: 'EmptyMailboxSection' }).exists()).toBe(false)
		})
	})

	describe('body-search timeout messaging', () => {
		// Search-in-body is the one search mode that isn't a local
		// database query -- it makes a live IMAP round-trip to the mail
		// server, an order of magnitude slower than everything else
		// search does, and prone to hitting the server's 504 timeout on
		// a large mailbox. The generic "Could not open folder" gave no
		// way to tell that apart from a genuine failure (confirmed
		// live).
		function error504() {
			const error = new Error('Gateway Timeout')
			error.response = { status: 504 }
			return error
		}

		it('shows a distinct message for a 504 while a body search is active', async () => {
			store.fetchEnvelopes = vi.fn().mockRejectedValue(error504())

			const view = mountMailbox({ searchQuery: 'body:euseful' })
			await view.vm.loadEnvelopes()

			expect(view.vm.errorTitle).toBe('Message body search is taking too long')
			expect(view.vm.errorMessage).not.toBe('')
		})

		it('keeps the generic message for a 504 with no body search active', async () => {
			store.fetchEnvelopes = vi.fn().mockRejectedValue(error504())

			const view = mountMailbox({ searchQuery: 'subject:euseful' })
			await view.vm.loadEnvelopes()

			expect(view.vm.errorTitle).toBe('Could not open folder')
			expect(view.vm.errorMessage).toBe('')
		})

		it('keeps the generic message for a non-504 error even with a body search active', async () => {
			store.fetchEnvelopes = vi.fn().mockRejectedValue(new Error('boom'))

			const view = mountMailbox({ searchQuery: 'body:euseful' })
			await view.vm.loadEnvelopes()

			expect(view.vm.errorTitle).toBe('Could not open folder')
			expect(view.vm.errorMessage).toBe('')
		})
	})

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

	it('cleans up its event bus listeners and background-refresh interval on destroy', () => {
		// Regression: this cleanup lived in an unmounted() hook -- the
		// Vue-3-style Composition API name, which Vue 2.7 only aliases
		// for onUnmounted() *functions*, not Options API object keys.
		// unmounted() as a plain method was silently never called at
		// all, on any component in this codebase that used it -- every
		// mailbox ever opened during a session left its own 60s
		// background-refresh interval running forever, alongside four
		// permanently-registered event bus listeners. Confirmed live
		// against the installed Vue source (createLifeCycle() in
		// vue.runtime.esm.js) before fixing it. Renamed to destroyed(),
		// the name Vue 2's Options API actually recognizes.
		vi.useFakeTimers()
		try {
			const bus = { on: vi.fn(), off: vi.fn() }
			const view = shallowMount(Mailbox, {
				propsData: { account, mailbox, bus },
				store,
				localVue,
			})

			const loadMailboxSpy = vi.spyOn(view.vm, 'loadMailbox')

			view.destroy()

			expect(bus.off).toHaveBeenCalledWith('load-more', expect.any(Function))
			expect(bus.off).toHaveBeenCalledWith('delete', expect.any(Function))
			// Not asserted as a Function: onArchive isn't actually a
			// defined method on this component (a separate, pre-existing,
			// unrelated quirk) -- bus.on()/bus.off() are called with the
			// same (undefined) value both times either way.
			expect(bus.off).toHaveBeenCalledWith('archive', view.vm.onArchive)
			expect(bus.off).toHaveBeenCalledWith('shortcut', expect.any(Function))

			// If the interval survived destroy(), advancing well past its
			// 60s period would have called loadMailbox() again.
			vi.advanceTimersByTime(120 * 1000)
			expect(loadMailboxSpy).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
})
