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

	function mountMailbox(propsOverride = {}, mocksOverride = {}) {
		return shallowMount(Mailbox, {
			propsData: {
				account,
				mailbox,
				bus: { on: vi.fn(), off: vi.fn() },
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

			expect(store.lastOpenedFromList).toEqual({ mailboxId: mailbox.databaseId, query: 'is:starred' })
			expect(view.vm.$router.push).toHaveBeenCalledWith(expect.objectContaining({
				params: expect.objectContaining({ threadId: 2 }),
			}))
		})

		it('records the mailbox and search query before jumping to the previous message via keyboard shortcut', () => {
			const view = mountMailbox({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 2 } } })

			view.vm.handleShortcut({ srcKey: 'prev' })

			expect(store.lastOpenedFromList).toEqual({ mailboxId: mailbox.databaseId, query: 'is:starred' })
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

			expect(store.lastOpenedFromList).toEqual({ mailboxId: mailbox.databaseId, query: 'is:starred' })
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

	describe('keyboard-shortcut delete/archive go through the same undo window as a list click', () => {
		// Mailbox.vue's own 'del'/'arch' keyboard shortcuts used to call
		// deleteThread()/moveThread() directly -- a third entry point
		// (besides EnvelopeList.vue's bulk delete and Envelope.vue's own
		// row click) with zero undo coverage. Both now go through the
		// same UndoableActionMixin every other delete/archive path uses.
		beforeEach(() => {
			store.getEnvelopes = vi.fn().mockReturnValue([
				{ databaseId: 1, mailboxId: 38 },
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
				expect(store.deleteThread).toHaveBeenCalledWith({ envelope: { databaseId: 1, mailboxId: 38 } })
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
					envelope: { databaseId: 1, mailboxId: 38 },
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
