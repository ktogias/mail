/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { showError, showUndo } from '@nextcloud/dialogs'
import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Mailbox from '../../../components/Mailbox.vue'
import MailboxLockedError from '../../../errors/MailboxLockedError.js'
import MailboxNotCachedError from '../../../errors/MailboxNotCachedError.js'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'

vi.mock('@nextcloud/dialogs', async (importOriginal) => ({
	...(await importOriginal()),
	showUndo: vi.fn(),
	showError: vi.fn(),
}))

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

describe('Mailbox', () => {
	let store

	let account
	let mailbox

	beforeEach(() => {
		setActivePinia(createPinia())
		store = useMainStore()

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

	function mountMailbox(propsOverride = {}, mocksOverride = {}) {
		return shallowMount(Mailbox, {
			propsData: {
				account,
				mailbox,
				bus: { on: vi.fn(), off: vi.fn() },
				// Skip mounted()'s own auto-load/sync flow so each test can
				// drive initializeCache()/loadEnvelopes() directly and in
				// isolation, same as before -- now via an explicit prop
				// rather than the app-wide hasFetchedInitialEnvelopes flag,
				// which real instances must no longer be able to skip this
				// way (see Mailbox.vue's mounted()).
				skipInitialLoad: true,
				...propsOverride,
			},
			mocks: {
				$route: { params: {} },
				$router: { push: vi.fn() },
				...mocksOverride,
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

	describe('backfill-progress banner ("still importing older messages")', () => {
		// Shown only for a real, non-priority mailbox that's genuinely still
		// backfilling (backfillComplete === false) and has a list to sit
		// above, until dismissed. Drives showBackfillBanner directly (the
		// computed), the same pragmatic level the rest of this file uses.
		function seedBackfilling(view, { complete = false, total = 98000, cached = 5000 } = {}) {
			store.getEnvelopes = vi.fn().mockReturnValue([{ databaseId: 1 }])
			mailbox.backfillComplete = complete
			mailbox.total = total
			mailbox.cached = cached
			return view
		}

		it('shows while the mailbox is incomplete and has messages', () => {
			const view = mountMailbox()
			seedBackfilling(view)

			expect(view.vm.showBackfillBanner).toBe(true)
			// Text is produced (exact number formatting depends on locale/t());
			// the count-carrying branch is exercised (cached present, not null).
			expect(typeof view.vm.backfillBannerText).toBe('string')
			expect(view.vm.backfillBannerText.length).toBeGreaterThan(0)
		})

		it('falls back to the count-less text when cached is unknown', () => {
			const view = mountMailbox()
			seedBackfilling(view, { cached: null })

			expect(view.vm.showBackfillBanner).toBe(true)
			expect(typeof view.vm.backfillBannerText).toBe('string')
		})

		it('hides once the backfill is complete', () => {
			const view = mountMailbox()
			seedBackfilling(view, { complete: true })

			expect(view.vm.showBackfillBanner).toBe(false)
		})

		it('hides in the Priority Inbox (virtual mailbox -- an X-of-Y figure is meaningless there)', () => {
			const view = mountMailbox({ isPriorityInbox: true })
			seedBackfilling(view)

			expect(view.vm.showBackfillBanner).toBe(false)
		})

		it('hides when the mailbox never reported progress (backfillComplete undefined, not false)', () => {
			const view = mountMailbox()
			store.getEnvelopes = vi.fn().mockReturnValue([{ databaseId: 1 }])
			// no backfillComplete set at all

			expect(view.vm.showBackfillBanner).toBe(false)
		})

		it('hides after the user dismisses it for the session', () => {
			const view = mountMailbox()
			seedBackfilling(view)
			expect(view.vm.showBackfillBanner).toBe(true)

			view.vm.dismissBackfillBanner()

			expect(store.backfillBannerDismissed[mailbox.databaseId]).toBe(true)
			expect(view.vm.showBackfillBanner).toBe(false)
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

	it('a second simultaneously-mounted Mailbox instance still fetches its own data after the first one finishes first', async () => {
		// Regression: hasFetchedInitialEnvelopes used to gate the WHOLE
		// mounted() body, app-wide, not just prefetchOtherMailboxes()
		// (see mounted()'s own comment). Priority Inbox mounts up to 4
		// sibling Mailbox instances at once (Favorites/Follow-up/
		// Important/Other); confirmed live that whichever section's
		// chain happened to settle first flipped the flag before a
		// slower sibling's own mounted() got there, permanently skipping
		// that sibling's initial fetch -- an entire section (confirmed:
		// "Other") silently never loaded after a hard refresh.
		store.fetchEnvelopes = vi.fn().mockResolvedValue([])
		store.syncEnvelopes = vi.fn().mockResolvedValue({})
		store.getRecursiveMailboxIterator = vi.fn().mockReturnValue([])

		const instanceA = shallowMount(Mailbox, {
			propsData: { account, mailbox, bus: { on: vi.fn(), off: vi.fn() } },
			mocks: { $route: { params: {} } },
			store,
			localVue,
		})

		// Let instance A's whole mounted() chain (loadEnvelopes -> sync ->
		// prefetchOtherMailboxes -> setHasFetchedInitialEnvelopesMutation)
		// run all the way to completion before B ever mounts -- modeling A
		// simply being faster (e.g. an empty/cached result) than B.
		await new Promise((resolve) => setTimeout(resolve, 0))
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()

		expect(store.hasFetchedInitialEnvelopes).toBe(true)
		store.fetchEnvelopes.mockClear()

		const instanceB = shallowMount(Mailbox, {
			propsData: { account, mailbox, bus: { on: vi.fn(), off: vi.fn() } },
			mocks: { $route: { params: {} } },
			store,
			localVue,
		})

		await new Promise((resolve) => setTimeout(resolve, 0))
		await Promise.resolve()

		expect(store.fetchEnvelopes).toHaveBeenCalled()

		instanceA.destroy()
		instanceB.destroy()
	})

	describe('loadMore() pacing guards', () => {
		// Neither guard existed before, in this fork or upstream (confirmed
		// identical): onScroll()/loadMore() relied entirely on network
		// latency to naturally pace repeated scroll-triggered calls. That
		// stopped holding once other fixes made real fetches noticeably
		// faster -- confirmed live, Priority Inbox appended pages with no
		// visible limit while scrolling.
		it('does not start a new page fetch while one is already in flight', async () => {
			let resolveFetch
			store.fetchNextEnvelopePage = vi.fn().mockReturnValue(new Promise((resolve) => {
				resolveFetch = resolve
			}))

			const view = mountMailbox()
			const firstCall = view.vm.loadMore()
			await view.vm.loadMore()

			expect(store.fetchNextEnvelopePage).toHaveBeenCalledTimes(1)

			resolveFetch([])
			await firstCall
		})

		it('does not fetch again once the end of the list has already been reached', async () => {
			store.fetchNextEnvelopePage = vi.fn().mockResolvedValue([])

			const view = mountMailbox()
			await view.vm.loadMore()
			expect(view.vm.endReached).toBe(true)

			await view.vm.loadMore()

			expect(store.fetchNextEnvelopePage).toHaveBeenCalledTimes(1)
		})

		it('still fetches normally when nothing is in flight and the end has not been reached', async () => {
			store.fetchNextEnvelopePage = vi.fn().mockResolvedValue([{ databaseId: 1 }])

			const view = mountMailbox()
			await view.vm.loadMore()

			expect(store.fetchNextEnvelopePage).toHaveBeenCalledTimes(1)
			expect(view.vm.endReached).toBe(false)
		})

		// endReached remembers "the PREVIOUS query's list had no more
		// pages" -- reported live: searching "unread only" inside a
		// mailbox until scrolling reached the end (correctly setting
		// endReached), then clearing the search left scroll-triggered
		// pagination permanently doing nothing for the rest of the
		// session, even though the unfiltered mailbox had plenty more
		// older messages to load. A different query/mailbox/sort order is
		// a different result set that may well have its own further
		// pages, so switching any of them must clear the stale flag.
		describe('endReached resets when the query set changes underneath it', () => {
			beforeEach(() => {
				store.fetchEnvelopes = vi.fn().mockResolvedValue([])
				// The mailbox() watcher's loadEnvelopes().then() chain also
				// calls this.sync(false) -- unmocked, it fires a real axios
				// request that rejects unhandled in jsdom.
				store.syncEnvelopes = vi.fn().mockResolvedValue({})
			})

			it('resets on a search query change', async () => {
				const view = mountMailbox()
				view.vm.endReached = true

				await view.setProps({ searchQuery: 'unread:true' })

				expect(view.vm.endReached).toBe(false)
			})

			it('resets on a mailbox (folder) change', async () => {
				store.addMailboxMutation({
					account,
					mailbox: {
						name: 'Sent',
						databaseId: 39,
						specialUse: ['sent'],
					},
				})
				const view = mountMailbox()
				view.vm.endReached = true

				await view.setProps({ mailbox: store.mailboxes[39] })

				expect(view.vm.endReached).toBe(false)
			})

			it('resets on a sort-order change', async () => {
				const view = mountMailbox()
				view.vm.endReached = true

				store.savePreferenceMutation({ key: 'sort-order', value: 'oldest' })
				await view.vm.$nextTick()

				expect(view.vm.endReached).toBe(false)
			})
		})
	})

	describe('records list context when auto-navigating to a neighboring message', () => {
		// Thread.vue::prefetchListNeighborhood() reads
		// mainStore.lastOpenedFromList to prefetch this list's neighbors.
		// handleShortcut()'s j/k-style next/prev navigation and onDelete()'s
		// auto-jump-to-the-next-message both land on 'message' the same way
		// a click does, but without going through Envelope.vue's onClick()
		// -- so without their own recording, opening a message this way
		// would prefetch stale (or no) neighbors.
		beforeEach(() => {
			store.getEnvelopes = vi.fn().mockReturnValue([
				{ databaseId: 1 },
				{ databaseId: 2 },
				{ databaseId: 3 },
			])
		})

		it('records the mailbox and search query before jumping to the next message via keyboard shortcut', () => {
			const view = mountMailbox({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 1 } } })

			view.vm.handleShortcut({ srcKey: 'next' })

			expect(store.lastOpenedFromList).toEqual({ mailboxId: mailbox.databaseId, query: 'is:starred', databaseId: 2 })
			expect(view.vm.$router.push).toHaveBeenCalledWith(expect.objectContaining({
				params: expect.objectContaining({ threadId: 2 }),
			}))
		})

		it('records the mailbox and search query before jumping to the previous message via keyboard shortcut', () => {
			const view = mountMailbox({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 2 } } })

			view.vm.handleShortcut({ srcKey: 'prev' })

			expect(store.lastOpenedFromList).toEqual({ mailboxId: mailbox.databaseId, query: 'is:starred', databaseId: 1 })
			expect(view.vm.$router.push).toHaveBeenCalledWith(expect.objectContaining({
				params: expect.objectContaining({ threadId: 1 }),
			}))
		})

		it('does not record anything when a shortcut has no next/previous message to jump to', () => {
			const view = mountMailbox({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 3 } } })

			view.vm.handleShortcut({ srcKey: 'next' })

			expect(store.lastOpenedFromList).toBeNull()
			expect(view.vm.$router.push).not.toHaveBeenCalled()
		})

		it('records the mailbox and search query before onDelete() auto-navigates to the next message', () => {
			const view = mountMailbox({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 1 } } })
			store.fetchNextEnvelopes = vi.fn().mockResolvedValue([])

			view.vm.onDelete(1)

			expect(store.lastOpenedFromList).toEqual({ mailboxId: mailbox.databaseId, query: 'is:starred', databaseId: 2 })
			expect(view.vm.$router.push).toHaveBeenCalledWith(expect.objectContaining({
				params: expect.objectContaining({ threadId: 2 }),
			}))
		})

		it('does not record anything when onDelete() deletes a message other than the currently open one', () => {
			const view = mountMailbox({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 1 } } })
			store.fetchNextEnvelopes = vi.fn().mockResolvedValue([])

			view.vm.onDelete(2)

			expect(store.lastOpenedFromList).toBeNull()
			expect(view.vm.$router.push).not.toHaveBeenCalled()
		})
	})

	describe('ReturnScrollAnchorMixin: re-anchoring scroll to the opened row on return from a thread', () => {
		// Confirmed live: returning from an open thread does NOT reliably
		// preserve the list's scroll position -- it lands back at the top
		// every time. So this always restores position to the previously
		// opened row on a genuine "thread just closed" transition; it does
		// not try to detect whether restoring is "needed" first.
		function appendFakeRow(view, databaseId) {
			const row = document.createElement('div')
			row.setAttribute('data-envelope-id', String(databaseId))
			row.scrollIntoView = vi.fn()
			view.vm.$el.appendChild(row)
			return row
		}

		it('scrolls the opened row into view when mailboxId/query match', () => {
			const view = mountMailbox({ searchQuery: 'is:starred' })
			const row = appendFakeRow(view, 70)
			store.setLastOpenedFromListMutation({ mailboxId: mailbox.databaseId, query: 'is:starred', databaseId: 70 })

			view.vm.reanchorScrollToLastOpenedEnvelope()

			expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
		})

		it('does nothing when the row is no longer in the list (deleted/moved/paginated away)', () => {
			const view = mountMailbox({ searchQuery: 'is:starred' })
			store.setLastOpenedFromListMutation({ mailboxId: mailbox.databaseId, query: 'is:starred', databaseId: 70 })

			expect(() => view.vm.reanchorScrollToLastOpenedEnvelope()).not.toThrow()
		})

		it('does nothing when this instance owns a different mailbox/query (Priority Inbox multi-section case)', () => {
			const view = mountMailbox({ searchQuery: 'is:starred' })
			const row = appendFakeRow(view, 70)
			store.setLastOpenedFromListMutation({ mailboxId: mailbox.databaseId, query: 'is:important', databaseId: 70 })

			view.vm.reanchorScrollToLastOpenedEnvelope()

			expect(row.scrollIntoView).not.toHaveBeenCalled()
		})

		it('does nothing when nothing has ever been recorded', () => {
			const view = mountMailbox({ searchQuery: 'is:starred' })
			appendFakeRow(view, 70)

			expect(() => view.vm.reanchorScrollToLastOpenedEnvelope()).not.toThrow()
		})

		it('only fires on a genuine thread-closed transition (new threadId falsy, old one truthy), not on opening a thread', async () => {
			const view = mountMailbox({ searchQuery: 'is:starred' })
			const spy = vi.spyOn(view.vm, 'reanchorScrollToLastOpenedEnvelope')
			// Vue 2 normalizes a mixin's own watch entries into an array
			// (so multiple mixins/component options watching the same key
			// can coexist) -- this key is only watched here, so it's a
			// one-element array.
			const rawWatcher = view.vm.$options.watch['$route.params.threadId']
			const watcher = Array.isArray(rawWatcher) ? rawWatcher[0] : rawWatcher

			watcher.call(view.vm, '2', '1') // opening a different thread
			watcher.call(view.vm, undefined, undefined) // initial mount, nothing to close
			await view.vm.$nextTick()
			expect(spy).not.toHaveBeenCalled()

			watcher.call(view.vm, undefined, '2') // the thread actually closed
			await view.vm.$nextTick()
			expect(spy).toHaveBeenCalledTimes(1)
		})
	})

	describe('onDelete() honors the "auto-advance" preference', () => {
		// After deleting the open message, where to go is a user preference
		// (AppSettingsMenu.vue): 'next' (default) / 'previous' / 'list'. The
		// directions are sort-agnostic -- next/previous mean the neighbour
		// below/above in the list as currently sorted, each falling back to
		// the other end, then to the list.
		beforeEach(() => {
			store.getEnvelopes = vi.fn().mockReturnValue([
				{ databaseId: 1 },
				{ databaseId: 2 },
				{ databaseId: 3 },
			])
			store.fetchNextEnvelopes = vi.fn().mockResolvedValue([])
		})

		it('opens the previous message when the preference is "previous"', () => {
			store.getPreference = vi.fn().mockReturnValue('previous')
			const view = mountMailbox({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 2 } } })

			view.vm.onDelete(2)

			expect(store.getPreference).toHaveBeenCalledWith('auto-advance', 'next')
			expect(view.vm.$router.push).toHaveBeenCalledWith(expect.objectContaining({
				name: 'message',
				params: expect.objectContaining({ threadId: 1 }),
			}))
		})

		it('falls back to the other neighbour when the preferred direction has none', () => {
			// "previous" from the first message: no message above, so it takes
			// the one below rather than bailing to the list.
			store.getPreference = vi.fn().mockReturnValue('previous')
			const view = mountMailbox({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 1 } } })

			view.vm.onDelete(1)

			expect(view.vm.$router.push).toHaveBeenCalledWith(expect.objectContaining({
				name: 'message',
				params: expect.objectContaining({ threadId: 2 }),
			}))
		})

		it('returns to the message list when the preference is "list"', () => {
			store.getPreference = vi.fn().mockReturnValue('list')
			const view = mountMailbox({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 2 } } })

			view.vm.onDelete(2)

			expect(view.vm.$router.push).toHaveBeenCalledWith(expect.objectContaining({ name: 'mailbox' }))
			expect(view.vm.$router.push).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'message' }))
			// "list" is an explicit navigate-away, not a neighbour open, so it
			// must not record list context for neighbour prefetching.
			expect(store.lastOpenedFromList).toBeNull()
		})

		it('returns to the message list when there is no neighbour at all', () => {
			store.getEnvelopes = vi.fn().mockReturnValue([{ databaseId: 2 }])
			store.getPreference = vi.fn().mockReturnValue('next')
			const view = mountMailbox({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 2 } } })

			view.vm.onDelete(2)

			expect(view.vm.$router.push).toHaveBeenCalledWith(expect.objectContaining({ name: 'mailbox' }))
		})
	})

	describe('keyboard-shortcut delete/archive go through the same undo window as a list click', () => {
		// Mailbox.vue's own 'del'/'arch' keyboard shortcuts used to call
		// deleteThread()/moveThread() directly -- a third entry point
		// (besides EnvelopeList.vue's bulk delete and Envelope.vue's own
		// row click) with zero undo coverage. Both now go through the
		// same UndoableActionMixin every other delete/archive path uses.
		beforeEach(() => {
			store.getEnvelopes = vi.fn().mockReturnValue([
				// accountId matches the outer beforeEach's real account (id 4,
				// added via addAccountMutation) -- the 'arch' shortcut resolves
				// the envelope's own account via mainStore.getAccount(accountId)
				// (a real, unmocked store getter) rather than the component's
				// own this.account, exactly the unified-mailbox distinction
				// upstream v5.10.9 introduced (merged in 74e8d8af7).
				{ databaseId: 1, mailboxId: 38, accountId: 4 },
			])
			store.deleteThread = vi.fn().mockResolvedValue()
			store.moveThread = vi.fn().mockResolvedValue()
			account.archiveMailboxId = 99
			showUndo.mockClear()
			showError.mockClear()
		})

		it('defers the real delete behind an undo window instead of calling it immediately', async () => {
			vi.useFakeTimers()
			try {
				const view = mountMailbox({}, { $route: { params: { threadId: 1 } } })

				view.vm.handleShortcut({ srcKey: 'del' })
				await vi.advanceTimersByTimeAsync(0)
				expect(store.deleteThread).not.toHaveBeenCalled()

				await vi.advanceTimersByTimeAsync(10000)
				expect(store.deleteThread).toHaveBeenCalledWith({ envelope: { databaseId: 1, mailboxId: 38, accountId: 4 } })
			} finally {
				vi.useRealTimers()
			}
		})

		it('never deletes at all if Undo is clicked in time', async () => {
			vi.useFakeTimers()
			try {
				const view = mountMailbox({}, { $route: { params: { threadId: 1 } } })

				view.vm.handleShortcut({ srcKey: 'del' })
				await vi.advanceTimersByTimeAsync(0)
				const onUndo = showUndo.mock.calls[0][1]
				onUndo()

				await vi.advanceTimersByTimeAsync(10000)
				expect(store.deleteThread).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it('defers the real archive (moveThread) behind the same undo window', async () => {
			vi.useFakeTimers()
			try {
				const view = mountMailbox({}, { $route: { params: { threadId: 1 } } })

				view.vm.handleShortcut({ srcKey: 'arch' })
				await vi.advanceTimersByTimeAsync(0)
				expect(store.moveThread).not.toHaveBeenCalled()

				await vi.advanceTimersByTimeAsync(10000)
				expect(store.moveThread).toHaveBeenCalledWith({
					envelope: { databaseId: 1, mailboxId: 38, accountId: 4 },
					destMailboxId: 99,
				})
			} finally {
				vi.useRealTimers()
			}
		})

		it('surfaces an error if the deferred delete itself fails once the undo window passes', async () => {
			store.deleteThread = vi.fn().mockRejectedValue(new Error('boom'))
			vi.useFakeTimers()
			try {
				const view = mountMailbox({}, { $route: { params: { threadId: 1 } } })

				view.vm.handleShortcut({ srcKey: 'del' })
				await vi.advanceTimersByTimeAsync(10000)

				expect(showError).toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})
	})

	// Reported live: MailboxThread.vue mounts several Mailbox instances at
	// once (Priority Inbox's Favorites/Follow up/Important/Other
	// sections), plus an independent Thread.vue reading pane. Deleting a
	// message from ONE of them used to leave it fully visible in every
	// OTHER one for the whole undo window, because UndoableActionMixin
	// used to track "what's pending" in each component's own data() --
	// invisible to every other instance. Fixed by moving that bookkeeping
	// into the shared Pinia store (pendingRemovals/beginPendingRemoval()/
	// endPendingRemoval()/isPendingRemoval()); this is the regression test
	// that is structurally impossible to pass against the old,
	// component-scoped implementation.
	describe('undo-hiding is shared across every simultaneously-rendered instance, not just the one that triggered it', () => {
		beforeEach(() => {
			store.getEnvelopes = vi.fn().mockReturnValue([
				{ databaseId: 1, mailboxId: 38 },
			])
			store.deleteThread = vi.fn().mockResolvedValue()
			showUndo.mockClear()
		})

		it('hides a message in a second, independently-mounted Mailbox instance the instant the first one deletes it', async () => {
			vi.useFakeTimers()
			try {
				const viewA = mountMailbox({}, { $route: { params: { threadId: 1 } } })
				const viewB = mountMailbox({}, { $route: { params: { threadId: 1 } } })

				expect(viewB.vm.visibleEnvelopesToShow).toEqual([{ databaseId: 1, mailboxId: 38 }])

				viewA.vm.handleShortcut({ srcKey: 'del' })
				await viewA.vm.$nextTick()

				// Still mid-undo-window -- the real deleteThread() call
				// hasn't fired yet -- but already hidden everywhere.
				expect(store.deleteThread).not.toHaveBeenCalled()
				expect(viewA.vm.visibleEnvelopesToShow).toEqual([])
				expect(viewB.vm.visibleEnvelopesToShow).toEqual([])

				await vi.advanceTimersByTimeAsync(10000)
			} finally {
				vi.useRealTimers()
			}
		})

		it('restores visibility in every instance if Undo is clicked, not just the one that triggered it', async () => {
			vi.useFakeTimers()
			try {
				const viewA = mountMailbox({}, { $route: { params: { threadId: 1 } } })
				const viewB = mountMailbox({}, { $route: { params: { threadId: 1 } } })

				viewA.vm.handleShortcut({ srcKey: 'del' })
				await viewA.vm.$nextTick()
				expect(viewB.vm.visibleEnvelopesToShow).toEqual([])

				const onUndo = showUndo.mock.calls[0][1]
				onUndo()
				await viewA.vm.$nextTick()

				expect(viewA.vm.visibleEnvelopesToShow).toEqual([{ databaseId: 1, mailboxId: 38 }])
				expect(viewB.vm.visibleEnvelopesToShow).toEqual([{ databaseId: 1, mailboxId: 38 }])

				await vi.advanceTimersByTimeAsync(10000)
			} finally {
				vi.useRealTimers()
			}
		})
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
				propsData: { account, mailbox, bus, skipInitialLoad: true },
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

	describe('IdleTailTrimMixin: idle-and-unselected tail trimming', () => {
		// Real scroll-position math is meaningless in jsdom (zero real
		// layout -- scrollHeight/clientHeight are always 0), so these
		// tests stub isScrolledNearIdleTailTrimBoundary() directly and
		// exercise only the idle-timer/tick-driven decision logic, same
		// pragmatic approach already used elsewhere in this test suite
		// for scroll/layout-dependent behavior.
		it('trims once idle for long enough and not scrolled near the boundary, triggered by a sync tick', async () => {
			const view = mountMailbox()
			vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(false)
			vi.spyOn(store, 'trimIdleEnvelopeListTailMutation')
			view.vm.lastTailActivityAt = Date.now() - 13 * 60 * 1000 // past IDLE_TRIM_MS (12 min)

			store.updateSyncTimestamp()
			await view.vm.$nextTick()

			expect(store.trimIdleEnvelopeListTailMutation).toHaveBeenCalledWith({
				mailboxId: mailbox.databaseId,
				query: undefined,
			})
		})

		it('does not trim while still within the idle threshold', async () => {
			const view = mountMailbox()
			vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(false)
			vi.spyOn(store, 'trimIdleEnvelopeListTailMutation')
			view.vm.lastTailActivityAt = Date.now() - 60 * 1000 // well under 12 min

			store.updateSyncTimestamp()
			await view.vm.$nextTick()

			expect(store.trimIdleEnvelopeListTailMutation).not.toHaveBeenCalled()
		})

		it('does not trim when scrolled near where the boundary would fall, even if idle long enough', async () => {
			const view = mountMailbox()
			vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(true)
			vi.spyOn(store, 'trimIdleEnvelopeListTailMutation')
			view.vm.lastTailActivityAt = Date.now() - 13 * 60 * 1000

			store.updateSyncTimestamp()
			await view.vm.$nextTick()

			expect(store.trimIdleEnvelopeListTailMutation).not.toHaveBeenCalled()
		})

		it('a settled scroll near the tail refreshes lastTailActivityAt, resetting the idle clock', async () => {
			vi.useFakeTimers()
			try {
				const view = mountMailbox()
				view.vm.stopInterval()
				vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(true)
				const longAgo = Date.now() - 13 * 60 * 1000
				view.vm.lastTailActivityAt = longAgo

				view.vm.onIdleTailTrimScrollActivity()
				await vi.advanceTimersByTimeAsync(150)

				expect(view.vm.lastTailActivityAt).toBeGreaterThan(longAgo)
				view.destroy()
			} finally {
				vi.useRealTimers()
			}
		})

		it('scrolling at the head does not keep the forgotten tail alive', async () => {
			vi.useFakeTimers()
			try {
				const view = mountMailbox()
				view.vm.stopInterval()
				vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(false)
				const longAgo = Date.now() - 13 * 60 * 1000
				view.vm.lastTailActivityAt = longAgo

				view.vm.onIdleTailTrimScrollActivity()
				await vi.advanceTimersByTimeAsync(150)

				expect(view.vm.lastTailActivityAt).toBe(longAgo)
				view.destroy()
			} finally {
				vi.useRealTimers()
			}
		})

		it('coalesces repeated scroll events into one settled geometry check', async () => {
			vi.useFakeTimers()
			try {
				const view = mountMailbox()
				view.vm.stopInterval()
				const boundarySpy = vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(false)

				view.vm.onIdleTailTrimScrollActivity()
				view.vm.onIdleTailTrimScrollActivity()
				view.vm.onIdleTailTrimScrollActivity()
				expect(boundarySpy).not.toHaveBeenCalled()

				await vi.advanceTimersByTimeAsync(150)

				expect(boundarySpy).toHaveBeenCalledTimes(1)
				view.destroy()
			} finally {
				vi.useRealTimers()
			}
		})

		it('trims one minute after a visited tail returns safely above the boundary', async () => {
			vi.useFakeTimers()
			try {
				const view = mountMailbox()
				view.vm.stopInterval()
				vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(false)
				vi.spyOn(store, 'trimIdleEnvelopeListTailMutation').mockReturnValue({ trimmedCount: 20 })
				view.vm.idleTailWasVisited = true

				view.vm.onIdleTailTrimScrollActivity()
				expect(store.trimIdleEnvelopeListTailMutation).not.toHaveBeenCalled()

				await vi.advanceTimersByTimeAsync(60 * 1000 + 150)

				expect(store.trimIdleEnvelopeListTailMutation).toHaveBeenCalledWith({
					mailboxId: mailbox.databaseId,
					query: undefined,
				})
				expect(view.vm.idleTailWasVisited).toBe(false)
				view.destroy()
			} finally {
				vi.useRealTimers()
			}
		})

		it('stops retrying the returned-tail timer after a bounded number of blocked attempts', async () => {
			vi.useFakeTimers()
			try {
				const view = mountMailbox()
				view.vm.stopInterval()
				vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(false)
				vi.spyOn(view.vm, 'envelopes', 'get').mockReturnValue(new Array(101).fill({}))
				// A selected tail row keeps blocking the trim every time.
				vi.spyOn(store, 'trimIdleEnvelopeListTailMutation').mockReturnValue({ trimmedCount: 0 })
				view.vm.idleTailWasVisited = true

				view.vm.onIdleTailTrimScrollActivity()
				// 3 bounded attempts, each spaced RETURNED_TAIL_TRIM_MS apart.
				await vi.advanceTimersByTimeAsync(3 * (60 * 1000) + 150)

				expect(store.trimIdleEnvelopeListTailMutation).toHaveBeenCalledTimes(3)
				expect(view.vm.idleTailReturnTrimTimer).toBeUndefined()

				// A 4th window passing confirms no further local retry --
				// the poller fallback (maybeTrimIdleTail(), a separate,
				// already-tested path) is what's left to eventually trim it.
				await vi.advanceTimersByTimeAsync(60 * 1000)

				expect(store.trimIdleEnvelopeListTailMutation).toHaveBeenCalledTimes(3)
				view.destroy()
			} finally {
				vi.useRealTimers()
			}
		})

		it('resets the return-trim attempt budget on a fresh visit to the tail', async () => {
			vi.useFakeTimers()
			try {
				const view = mountMailbox()
				view.vm.stopInterval()
				view.vm.idleTailReturnTrimAttempts = 2

				vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(true)
				vi.spyOn(view.vm, 'envelopes', 'get').mockReturnValue(new Array(101).fill({}))

				view.vm.onIdleTailTrimScrollActivity()
				await vi.advanceTimersByTimeAsync(150)

				expect(view.vm.idleTailReturnTrimAttempts).toBe(0)
				view.destroy()
			} finally {
				vi.useRealTimers()
			}
		})

		it('does not run the returned-tail timer while the boundary is near the viewport', async () => {
			vi.useFakeTimers()
			try {
				const view = mountMailbox()
				view.vm.stopInterval()
				vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(true)
				vi.spyOn(store, 'trimIdleEnvelopeListTailMutation')
				view.vm.idleTailWasVisited = true

				view.vm.onIdleTailTrimScrollActivity()
				await vi.advanceTimersByTimeAsync(60 * 1000 + 150)

				expect(store.trimIdleEnvelopeListTailMutation).not.toHaveBeenCalled()
				view.destroy()
			} finally {
				vi.useRealTimers()
			}
		})

		it('also checks immediately when the tab is backgrounded, not just on the next sync tick', () => {
			const view = mountMailbox()
			vi.spyOn(view.vm, 'isScrolledNearIdleTailTrimBoundary').mockReturnValue(false)
			vi.spyOn(store, 'trimIdleEnvelopeListTailMutation')
			view.vm.lastTailActivityAt = Date.now() - 13 * 60 * 1000
			vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')

			view.vm.onIdleTailTrimVisibilityChange()

			expect(store.trimIdleEnvelopeListTailMutation).toHaveBeenCalledWith({
				mailboxId: mailbox.databaseId,
				query: undefined,
			})
		})
	})

	describe('"Show less": collapsing an expanded manual-paginate section back to its initial page size', () => {
		// MailboxThread.vue was already passing :collapsible="true" for
		// the Favorites/Follow-up/Important sections, but Mailbox.vue had
		// no such prop -- once "Load more" expanded a section, the only
		// way back to the compact view was a full page reload.
		function mountCollapsible(envelopeCount, { expanded = true, collapsible = true } = {}) {
			const view = mountMailbox({
				paginate: 'manual',
				initialPageSize: 5,
				collapsible,
			})
			const fakeEnvelopes = Array.from({ length: envelopeCount }, (_, i) => ({ databaseId: i + 1, flags: {} }))
			vi.spyOn(view.vm, 'envelopes', 'get').mockReturnValue(fakeEnvelopes)
			view.vm.expanded = expanded
			return view
		}

		it('offers the collapse control once expanded past the initial page size', () => {
			const view = mountCollapsible(12)

			expect(view.vm.showCollapse).toBe(true)
		})

		it('does not offer it before the section was ever expanded', () => {
			const view = mountCollapsible(12, { expanded: false })

			expect(view.vm.showCollapse).toBe(false)
		})

		it('does not offer it when everything loaded already fits the initial page', () => {
			const view = mountCollapsible(4)

			expect(view.vm.showCollapse).toBe(false)
		})

		it('does not offer it for a section not marked collapsible', () => {
			const view = mountCollapsible(12, { collapsible: false })

			expect(view.vm.showCollapse).toBe(false)
		})

		it('collapse() shrinks the visible list back to the initial page size, suppressing the bulk-leave transition', async () => {
			const view = mountCollapsible(12)
			expect(view.vm.envelopesToShow).toHaveLength(12)

			view.vm.collapse()

			expect(view.vm.expanded).toBe(false)
			expect(view.vm.envelopesToShow).toHaveLength(5)
			expect(view.vm.skipListTransition).toBe(true)
			await view.vm.$nextTick()
			expect(view.vm.skipListTransition).toBe(false)
		})

		it('a later "Load more" simply re-expands to everything already loaded', () => {
			const view = mountCollapsible(12)
			view.vm.collapse()

			view.vm.loadMore()

			expect(view.vm.expanded).toBe(true)
			expect(view.vm.envelopesToShow).toHaveLength(12)
		})
	})
})
