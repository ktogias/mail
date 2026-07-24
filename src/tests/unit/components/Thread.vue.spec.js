/**
 * SPDX-FileCopyrightText: 2023 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { showUndo } from '@nextcloud/dialogs'
import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Thread from '../../../components/Thread.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import { UNIFIED_INBOX_ID } from '../../../store/constants.js'
import useMainStore from '../../../store/mainStore.js'

vi.mock('@nextcloud/dialogs', async (importOriginal) => ({
	...(await importOriginal()),
	showUndo: vi.fn(),
}))

const localVue = createLocalVue()

localVue.mixin(Nextcloud)

describe('Thread', () => {
	let store

	beforeEach(() => {
		setActivePinia(createPinia())

		store = useMainStore()
		store.getEnvelope = vi.fn().mockImplementation((id) => {
			if (id === 200) {
				return {
					accountId: 100,
					threadRootId: '123-456-789',
					mailboxId: 10,
				}
			}
			if (id === 300) {
				return {
					accountId: 200,
					threadRootId: '456-789-123',
					mailboxId: 20,
				}
			}
			if (id === 301) {
				return {
					accountId: 200,
					threadRootId: '456-789-123',
					mailboxId: 22,
				}
			}
			if (id === 302) {
				return {
					accountId: 200,
					threadRootId: '456-789-123',
					mailboxId: 23,
				}
			}
			if (id === 4003) {
				return {
					accountId: 300,
					threadRootId: 'thread-unread',
					mailboxId: 30,
				}
			}
			if (id === 5003) {
				return {
					accountId: 300,
					threadRootId: 'thread-allread',
					mailboxId: 30,
				}
			}
			return undefined
		})

		store.getEnvelopesByThreadRootId = vi.fn().mockImplementation((accountId, threadRootId) => {
			if (threadRootId === '123-456-789') {
				return [
					{
						accountId: 100,
						threadRootId: '123-456-789',
						mailboxId: 10,
						databaseId: 1001,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 100,
						threadRootId: '123-456-789',
						mailboxId: 11,
						databaseId: 1002,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 100,
						threadRootId: '123-456-789',
						mailboxId: 10,
						databaseId: 1003,
						from: [],
						to: [],
						cc: [],
					},
				]
			}
			if (threadRootId === '456-789-123') {
				return [
					{
						accountId: 200,
						threadRootId: '456-789-123',
						mailboxId: 20,
						databaseId: 2001,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 200,
						threadRootId: '456-789-123',
						mailboxId: 21,
						databaseId: 2002,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 200,
						threadRootId: '456-789-123',
						mailboxId: 20,
						databaseId: 2003,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 200,
						threadRootId: '456-789-123',
						mailboxId: 22,
						databaseId: 2004,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 200,
						threadRootId: '456-789-123',
						mailboxId: 23,
						databaseId: 2005,
						from: [],
						to: [],
						cc: [],
					},
				]
			}
			if (threadRootId === 'thread-unread') {
				// Oldest-to-newest, matching the real getter's dateInt sort.
				// The oldest (4001) is unread; the clicked/newest (4003,
				// the route's threadId) has already been read.
				return [
					{
						accountId: 300,
						threadRootId: 'thread-unread',
						mailboxId: 30,
						databaseId: 4001,
						from: [],
						to: [],
						cc: [],
						flags: { seen: false },
					},
					{
						accountId: 300,
						threadRootId: 'thread-unread',
						mailboxId: 30,
						databaseId: 4002,
						from: [],
						to: [],
						cc: [],
						flags: { seen: true },
					},
					{
						accountId: 300,
						threadRootId: 'thread-unread',
						mailboxId: 30,
						databaseId: 4003,
						from: [],
						to: [],
						cc: [],
						flags: { seen: true },
					},
				]
			}
			if (threadRootId === 'thread-allread') {
				return [
					{
						accountId: 300,
						threadRootId: 'thread-allread',
						mailboxId: 30,
						databaseId: 5001,
						from: [],
						to: [],
						cc: [],
						flags: { seen: true },
					},
					{
						accountId: 300,
						threadRootId: 'thread-allread',
						mailboxId: 30,
						databaseId: 5002,
						from: [],
						to: [],
						cc: [],
						flags: { seen: true },
					},
					{
						accountId: 300,
						threadRootId: 'thread-allread',
						mailboxId: 30,
						databaseId: 5003,
						from: [],
						to: [],
						cc: [],
						flags: { seen: true },
					},
				]
			}
			return []
		})

		store.getMailbox = vi.fn().mockImplementation((id) => {
			if (id === 10) {
				return {
					databaseId: 10,
					name: 'INBOX',
					accountId: 100,
					specialRole: 'inbox',
				}
			}
			if (id === 20) {
				return {
					databaseId: 20,
					name: 'INBOX',
					accountId: 200,
					specialRole: 'inbox',
				}
			}
			if (id === 22) {
				return {
					databaseId: 22,
					name: 'Trash',
					accountId: 200,
					specialRole: 'trash',
				}
			}
			if (id === 23) {
				return {
					databaseId: 23,
					name: 'Junk',
					accountId: 200,
					specialRole: 'junk',
				}
			}
			if (id === 30) {
				return {
					databaseId: 30,
					name: 'INBOX',
					accountId: 300,
					specialRole: 'inbox',
				}
			}
			return undefined
		})

		store.getMailboxes = vi.fn().mockImplementation((accountId) => {
			if (accountId === 100) {
				return [
					{
						databaseId: 10,
						name: 'INBOX',
						specialRole: 'inbox',
					},
					{
						databaseId: 11,
						name: 'Test',
						specialRole: '',
					},
				]
			}
			if (accountId === 200) {
				return [
					{
						databaseId: 20,
						name: 'INBOX',
						specialRole: 'inbox',
					},
					{
						databaseId: 21,
						name: 'Test',
						specialRole: '',
					},
					{
						databaseId: 22,
						name: 'Trash',
						specialRole: 'trash',
					},
					{
						databaseId: 23,
						name: 'Junk',
						specialRole: 'junk',
					},
				]
			}
			if (accountId === 300) {
				return [
					{
						databaseId: 30,
						name: 'INBOX',
						specialRole: 'inbox',
					},
				]
			}
			return []
		})
	})

	it('empty list when envelope not found', () => {
		const view = shallowMount(Thread, {
			mocks: {
				$route: {
					params: {
						threadId: 100,
					},
				},
			},
			store,
			localVue,
		})

		expect(view.vm.thread).toHaveLength(0)
	})

	it('show messages for thread root from inbox and test folder', () => {
		const view = shallowMount(Thread, {
			mocks: {
				$route: {
					params: {
						threadId: 200,
					},
				},
			},
			store,
			localVue,
		})

		expect(view.vm.thread).toHaveLength(3)
	})

	it('show messages for thread root from inbox and test folder, ignore trash', () => {
		const view = shallowMount(Thread, {
			mocks: {
				$route: {
					params: {
						threadId: 300,
					},
				},
			},
			store,
			localVue,
		})

		expect(view.vm.thread).toHaveLength(3)
	})

	it('show messages for thread root only from trash', () => {
		const view = shallowMount(Thread, {
			mocks: {
				$route: {
					params: {
						threadId: 301,
					},
				},
			},
			store,
			localVue,
		})

		const envelopes = view.vm.thread
		expect(envelopes).toHaveLength(1)
		expect(envelopes[0].mailboxId).toBe(22)
	})

	it('show messages for thread root only from junk', () => {
		const view = shallowMount(Thread, {
			mocks: {
				$route: {
					params: {
						threadId: 302,
					},
				},
			},
			store,
			localVue,
		})

		const envelopes = view.vm.thread
		expect(envelopes).toHaveLength(1)
		expect(envelopes[0].mailboxId).toBe(23)
	})

	describe('dedupeFolderCopies: one thread entry per real email (Message-ID)', () => {
		// On Gmail, INBOX / "All Mail" / Important are folder views of one
		// message, each synced as its own row with independently-refreshed
		// flags. Confirmed live: unmarking the INBOX copy left a stale
		// still-flagged [Gmail]/Important copy rendered as a seemingly
		// separate, still-important "second message".
		function mountThreadFor(threadId, envelopes, mailboxes) {
			store.getEnvelope = vi.fn().mockImplementation((id) => envelopes.find((e) => e.databaseId === id))
			store.getEnvelopesByThreadRootId = vi.fn().mockReturnValue(envelopes)
			store.getMailboxes = vi.fn().mockReturnValue(mailboxes)
			store.getMailbox = vi.fn().mockImplementation((id) => mailboxes.find((mb) => mb.databaseId === id))
			return shallowMount(Thread, {
				mocks: { $route: { params: { threadId } } },
				store,
				localVue,
			})
		}

		const inbox = { databaseId: 10, name: 'INBOX', specialRole: 'inbox' }
		const importantFolder = { databaseId: 11, name: '[Gmail]/Important', specialRole: '', specialUse: ['important'] }
		const plainFolder = { databaseId: 12, name: 'Work', specialRole: '', specialUse: [] }

		function copy(databaseId, mailboxId, messageId, extra = {}) {
			return { accountId: 100, threadRootId: 'root', databaseId, mailboxId, messageId, from: [], to: [], cc: [], flags: {}, ...extra }
		}

		it('collapses same-Message-ID folder copies into one entry, preferring the opened copy', () => {
			const view = mountThreadFor(1001, [
				copy(1001, 10, '<one@test>', { flags: { important: false } }),
				copy(1002, 11, '<one@test>', { flags: { important: true } }), // stale Important-folder copy
			], [inbox, importantFolder])

			expect(view.vm.thread).toHaveLength(1)
			expect(view.vm.thread[0].databaseId).toBe(1001)
		})

		it('prefers the inbox copy when the opened row is not among the duplicates', () => {
			// Opened id 2001 is its own distinct message; the OTHER email
			// exists in a plain folder and the inbox -- inbox wins.
			const view = mountThreadFor(2001, [
				copy(2001, 10, '<opened@test>'),
				copy(2002, 12, '<dup@test>'),
				copy(2003, 10, '<dup@test>'),
			], [inbox, plainFolder])

			expect(view.vm.thread).toHaveLength(2)
			const dup = view.vm.thread.find((e) => e.messageId === '<dup@test>')
			expect(dup.databaseId).toBe(2003)
		})

		it('keeps genuinely different messages of the thread separate', () => {
			const view = mountThreadFor(3001, [
				copy(3001, 10, '<a@test>'),
				copy(3002, 10, '<b@test>'),
			], [inbox])

			expect(view.vm.thread).toHaveLength(2)
		})

		it('keeps rows without a messageId as-is (nothing to group on)', () => {
			const view = mountThreadFor(4001, [
				copy(4001, 10, undefined),
				copy(4002, 10, undefined),
			], [inbox])

			expect(view.vm.thread).toHaveLength(2)
		})
	})

	describe('initiallyExpandedEnvelopeId', () => {
		it('opens on the first (oldest) unread message instead of always the clicked/newest one', () => {
			const view = shallowMount(Thread, {
				mocks: {
					$route: {
						params: {
							threadId: 4003,
						},
					},
				},
				store,
				localVue,
			})

			expect(view.vm.initiallyExpandedEnvelopeId()).toBe(4001)
			// resetThread() runs on created(), so this should already hold
			// without calling the method directly.
			expect(view.vm.expandedThreads).toEqual([4001])
		})

		it('falls back to the clicked/newest message when nothing in the thread is unread', () => {
			const view = shallowMount(Thread, {
				mocks: {
					$route: {
						params: {
							threadId: 5003,
						},
					},
				},
				store,
				localVue,
			})

			expect(view.vm.initiallyExpandedEnvelopeId()).toBe(5003)
			expect(view.vm.expandedThreads).toEqual([5003])
		})
	})

	describe('stale fetchThread() rejections', () => {
		// The store's fetchThread() action has no caching/dedup at all
		// (unlike fetchMessage()), so hover-prefetch (Envelope.vue) firing
		// its own independent fetchThread() call for the same id can race
		// this component's own call. Confirmed live: a thread that visibly
		// loaded fine flipped to "Δεν βρέθηκε" moments later, only
		// reproducible on desktop (hover exists there, not on mobile touch).
		it('ignores a rejection once the thread is already loaded (a concurrent call must have succeeded)', async () => {
			let reject
			store.fetchThread = vi.fn().mockReturnValue(new Promise((_resolve, r) => {
				reject = r
			}))

			const view = shallowMount(Thread, {
				mocks: {
					$route: { params: { threadId: 300 } },
				},
				store,
				localVue,
			})

			// getEnvelope()/getEnvelopesByThreadRootId() already return a
			// fully-populated thread for 300, as if a concurrent call (e.g.
			// hover prefetch) had already committed it to the store.
			expect(view.vm.thread.length).toBeGreaterThan(0)

			reject(new Error('boom'))
			await Promise.resolve()
			await Promise.resolve()

			expect(view.vm.errorMessage).toBe('')
		})

		it('ignores a rejection for a thread the user already navigated away from', async () => {
			let reject
			store.fetchThread = vi.fn().mockReturnValue(new Promise((_resolve, r) => {
				reject = r
			}))

			const view = shallowMount(Thread, {
				mocks: {
					$route: { params: { threadId: 900 } },
				},
				store,
				localVue,
			})

			// Simulate having navigated to a different thread before the
			// original call's promise settles.
			view.vm.$route.params.threadId = 901

			reject(new Error('boom'))
			await Promise.resolve()
			await Promise.resolve()

			expect(view.vm.errorMessage).toBe('')
		})

		it('still shows the error when the thread genuinely failed to load and nothing superseded it', async () => {
			let reject
			store.fetchThread = vi.fn().mockReturnValue(new Promise((_resolve, r) => {
				reject = r
			}))

			const view = shallowMount(Thread, {
				mocks: {
					$route: { params: { threadId: 900 } },
				},
				store,
				localVue,
			})

			reject(new Error('boom'))
			await Promise.resolve()
			await Promise.resolve()

			expect(view.vm.errorMessage).toBeTruthy()
		})
	})

	describe('resume-on-visibility after a network-shaped failure', () => {
		// Confirmed live: backgrounding the tab on Android mid-thread-load
		// then returning previously left the loading spinner stuck
		// forever. fetchThread()'s catch() branch for a network-shaped
		// error (no HTTP response at all -- exactly what a backgrounded
		// tab's dropped connection produces) never reset `loading`, so
		// the template's loading/error v-if chain never reached the error
		// message that branch had actually just set.
		function setVisibility(state) {
			Object.defineProperty(document, 'visibilityState', {
				value: state,
				configurable: true,
			})
		}

		afterEach(() => {
			setVisibility('visible')
		})

		it('stops the loading spinner and shows the error for a network-shaped failure, marking it retryable', async () => {
			store.fetchThread = vi.fn().mockRejectedValue(new Error('Network Error'))

			const view = shallowMount(Thread, {
				mocks: { $route: { params: { threadId: 900 } } },
				store,
				localVue,
			})
			await Promise.resolve()
			await Promise.resolve()

			expect(view.vm.loading).toBe(false)
			expect(view.vm.errorMessage).toBeTruthy()
			expect(view.vm.retryOnVisible).toBe(true)
		})

		it('does not mark a definitive 403 (thread genuinely gone) as retryable', async () => {
			const error = new Error('Forbidden')
			error.response = { status: 403 }
			store.fetchThread = vi.fn().mockRejectedValue(error)

			const view = shallowMount(Thread, {
				mocks: { $route: { params: { threadId: 900 } } },
				store,
				localVue,
			})
			await Promise.resolve()
			await Promise.resolve()

			expect(view.vm.retryOnVisible).toBe(false)
		})

		it('retries automatically once the tab becomes visible again', async () => {
			store.fetchThread = vi.fn().mockRejectedValue(new Error('Network Error'))
			const view = shallowMount(Thread, {
				mocks: { $route: { params: { threadId: 900 } } },
				store,
				localVue,
			})
			await Promise.resolve()
			await Promise.resolve()
			expect(view.vm.retryOnVisible).toBe(true)

			store.fetchThread = vi.fn().mockResolvedValue([{ databaseId: 900 }])
			setVisibility('visible')
			document.dispatchEvent(new Event('visibilitychange'))

			expect(store.fetchThread).toHaveBeenCalled()
			expect(view.vm.retryOnVisible).toBe(false)
		})

		it('does not retry while the tab is still hidden', async () => {
			store.fetchThread = vi.fn().mockRejectedValue(new Error('Network Error'))
			shallowMount(Thread, {
				mocks: { $route: { params: { threadId: 900 } } },
				store,
				localVue,
			})
			await Promise.resolve()
			await Promise.resolve()

			store.fetchThread = vi.fn().mockResolvedValue([])
			setVisibility('hidden')
			document.dispatchEvent(new Event('visibilitychange'))

			expect(store.fetchThread).not.toHaveBeenCalled()
		})

		it('does not retry when nothing marked the failure as retryable', async () => {
			store.fetchThread = vi.fn().mockResolvedValue([{ databaseId: 900 }])
			shallowMount(Thread, {
				mocks: { $route: { params: { threadId: 900 } } },
				store,
				localVue,
			})
			await Promise.resolve()
			await Promise.resolve()

			store.fetchThread = vi.fn().mockResolvedValue([])
			setVisibility('visible')
			document.dispatchEvent(new Event('visibilitychange'))

			expect(store.fetchThread).not.toHaveBeenCalled()
		})

		it('removes the visibilitychange listener on destroy', () => {
			store.fetchThread = vi.fn().mockResolvedValue([])
			const view = shallowMount(Thread, {
				mocks: { $route: { params: { threadId: 900 } } },
				store,
				localVue,
			})
			const removeSpy = vi.spyOn(document, 'removeEventListener')

			view.destroy()

			expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
			removeSpy.mockRestore()
		})
	})

	describe('message prefetch', () => {
		// The clicked message's databaseId is already known from the
		// route, before the thread listing resolves -- fetching it in
		// parallel removes one full round trip from the critical path
		// instead of waiting for the thread to resolve and
		// ThreadEnvelope.vue to mount before firing it.
		it('starts fetching the clicked message immediately, without waiting for the thread', () => {
			store.fetchMessage = vi.fn().mockResolvedValue({ databaseId: 200 })
			store.fetchThread = vi.fn().mockResolvedValue([])

			shallowMount(Thread, {
				mocks: {
					$route: {
						params: {
							threadId: 200,
						},
					},
				},
				store,
				localVue,
			})

			expect(store.fetchMessage).toHaveBeenCalledWith(200)
		})
	})

	describe('cancels stale speculative prefetches on open', () => {
		// Confirmed live (thread 926521, 2026-07-12): unrelated
		// viewport-prefetch requests from list scrolling queued a real
		// thread open behind them for ~31s. resetThread() -- the one
		// place that knows a real open just happened -- must cancel
		// every OTHER speculative fetch immediately, before anything
		// else, so those workers/connections free up for what actually
		// matters now.
		it('calls cancelSpeculativeFetchesExcept with the opened thread id, before fetching anything', () => {
			const calls = []
			store.cancelSpeculativeFetchesExcept = vi.fn(() => calls.push('cancel'))
			store.fetchMessage = vi.fn(() => {
				calls.push('fetchMessage')
				return Promise.resolve({ databaseId: 200 })
			})
			store.fetchThread = vi.fn(() => {
				calls.push('fetchThread')
				return Promise.resolve([])
			})

			shallowMount(Thread, {
				mocks: {
					$route: { params: { threadId: 200 } },
				},
				store,
				localVue,
			})

			expect(store.cancelSpeculativeFetchesExcept).toHaveBeenCalledWith(200)
			expect(calls[0]).toBe('cancel')
		})
	})

	describe('prefetchThreadNeighborhood', () => {
		// A dedicated, simple fixture (single inbox mailbox, no trash/
		// junk exclusion to reason about) rather than reusing the shared
		// fixtures above -- full control over exactly where the opened
		// message sits in the thread.
		beforeEach(() => {
			store.getEnvelope = vi.fn().mockReturnValue({
				accountId: 500,
				threadRootId: 'neighborhood-thread',
				mailboxId: 50,
			})
			store.getEnvelopesByThreadRootId = vi.fn().mockReturnValue([7001, 7002, 7003, 7004, 7005].map((databaseId) => ({
				accountId: 500,
				threadRootId: 'neighborhood-thread',
				mailboxId: 50,
				databaseId,
				from: [],
				to: [],
				cc: [],
				flags: { seen: true },
			})))
			store.getMailbox = vi.fn().mockReturnValue({
				databaseId: 50,
				name: 'INBOX',
				accountId: 500,
				specialRole: 'inbox',
			})
			store.getMailboxes = vi.fn().mockReturnValue([
				{ databaseId: 50, name: 'INBOX', specialRole: 'inbox' },
			])
			// prefetchListNeighborhood() also runs on every resetThread()
			// now, calling the REAL (unmocked) getEnvelopes(), which reads
			// getMailbox(id).envelopeLists -- the mock above has no such
			// property. These tests aren't about that method; mock it
			// directly so it's a no-op ([] -> openIndex -1 -> early
			// return) rather than coupling this fixture to its internals.
			store.getEnvelopes = vi.fn().mockReturnValue([])
			// fetchThread()'s own local method treats an empty array as
			// "thread not found" and returns early, before ever reaching
			// prefetchThreadNeighborhood() -- only the .length matters
			// here, this.thread (the computed prop actually used for the
			// neighborhood calculation) comes from the getters above.
			store.fetchThread = vi.fn().mockResolvedValue([{ databaseId: 7001 }])
		})

		it('prefetches the previous message and the thread\'s first message, when the open one sits in the middle', async () => {
			store.fetchMessage = vi.fn().mockResolvedValue({ databaseId: 7003 })

			// All read (flags.seen: true) -- initiallyExpandedEnvelopeId()
			// falls back to the clicked/route id, 7003, which is index 2
			// of 5: a distinct "previous" (7002) and "first" (7001).
			shallowMount(Thread, {
				mocks: {
					$route: { params: { threadId: 7003 } },
				},
				store,
				localVue,
			})
			await vi.waitFor(() => {
				expect(store.fetchMessage).toHaveBeenCalledWith(7002, { speculative: true })
			})

			expect(store.fetchMessage).toHaveBeenCalledWith(7001, { speculative: true })
		})

		it('does not duplicate the fetch when previous and first are the same message', async () => {
			store.fetchMessage = vi.fn().mockResolvedValue({ databaseId: 7002 })

			// Open at index 1 of 5: previous (index 0) and first
			// (index 0) are the same envelope, 7001.
			shallowMount(Thread, {
				mocks: {
					$route: { params: { threadId: 7002 } },
				},
				store,
				localVue,
			})
			await vi.waitFor(() => {
				expect(store.fetchMessage.mock.calls.some(([id]) => id === 7001)).toBe(true)
			})

			expect(store.fetchMessage.mock.calls.filter(([id]) => id === 7001)).toHaveLength(1)
		})

		it('prefetches nothing beyond the open message itself when it is already the first', async () => {
			store.fetchMessage = vi.fn().mockResolvedValue({ databaseId: 7001 })

			shallowMount(Thread, {
				mocks: {
					$route: { params: { threadId: 7001 } },
				},
				store,
				localVue,
			})
			await vi.waitFor(() => {
				expect(store.fetchThread).toHaveBeenCalled()
			})

			// Only the open message itself (fetched by resetThread()'s own
			// parallel-prefetch, non-speculative) -- no neighborhood calls.
			expect(store.fetchMessage.mock.calls.filter((call) => call[1]?.speculative)).toHaveLength(0)
		})
	})

	describe('prefetchListNeighborhood', () => {
		// The reading time between opening a message and the user's next
		// action is otherwise idle -- prefetch the previous/next message
		// in the LIST the user opened this one from (not just siblings
		// within its own thread, see prefetchThreadNeighborhood above).
		// Reads mainStore.lastOpenedFromList (set by Envelope.vue's own
		// onClick(), not exercised by these component-level tests) rather
		// than reconstructing "the list" from route params -- so these
		// tests set it directly, the same way the real click would have.
		beforeEach(() => {
			store.getMailbox = vi.fn().mockImplementation((id) => {
				if (id === 50 || id === UNIFIED_INBOX_ID) {
					return { databaseId: id, name: 'INBOX', specialRole: 'inbox' }
				}
				return undefined
			})
			store.getEnvelopes = vi.fn().mockImplementation((mailboxId, query) => {
				if (mailboxId === 50 && query === undefined) {
					return [8001, 8002, 8003, 8004, 8005].map((databaseId) => ({ databaseId }))
				}
				if (mailboxId === UNIFIED_INBOX_ID && query === 'is:pi-important') {
					return [9001, 9002, 9003].map((databaseId) => ({ databaseId }))
				}
				if (mailboxId === UNIFIED_INBOX_ID && query === 'is:pi-other') {
					return [9101, 9102, 9103].map((databaseId) => ({ databaseId }))
				}
				return []
			})
			store.fetchThread = vi.fn().mockResolvedValue([{ databaseId: 8003 }])
			store.fetchMessage = vi.fn().mockResolvedValue({})
		})

		function mountAt(threadId) {
			return shallowMount(Thread, {
				mocks: {
					$route: { params: { mailboxId: 50, threadId } },
				},
				store,
				localVue,
			})
		}

		it('prefetches both the previous and next message in the list, when the open one sits in the middle', async () => {
			store.lastOpenedFromList = { mailboxId: 50, query: undefined }

			mountAt(8003)
			await vi.waitFor(() => {
				expect(store.fetchMessage).toHaveBeenCalledWith(8002, { speculative: true })
			})

			expect(store.fetchMessage).toHaveBeenCalledWith(8004, { speculative: true })
		})

		it('only prefetches the next message when the open one is first in the list', async () => {
			store.lastOpenedFromList = { mailboxId: 50, query: undefined }

			mountAt(8001)
			await vi.waitFor(() => {
				expect(store.fetchMessage).toHaveBeenCalledWith(8002, { speculative: true })
			})

			expect(store.fetchMessage.mock.calls.filter((call) => call[1]?.speculative)).toHaveLength(1)
		})

		it('only prefetches the previous message when the open one is last in the list', async () => {
			store.lastOpenedFromList = { mailboxId: 50, query: undefined }

			mountAt(8005)
			await vi.waitFor(() => {
				expect(store.fetchMessage).toHaveBeenCalledWith(8004, { speculative: true })
			})

			expect(store.fetchMessage.mock.calls.filter((call) => call[1]?.speculative)).toHaveLength(1)
		})

		it('does nothing when nothing was recorded (a direct URL, bookmark, or browser back/forward)', async () => {
			store.lastOpenedFromList = null

			mountAt(8003)
			await vi.waitFor(() => {
				expect(store.fetchThread).toHaveBeenCalled()
			})

			expect(store.getEnvelopes).not.toHaveBeenCalled()
		})

		it('does not crash when the recorded mailbox no longer exists', () => {
			store.lastOpenedFromList = { mailboxId: 999, query: undefined }

			expect(() => mountAt(8003)).not.toThrow()
			expect(store.getEnvelopes).not.toHaveBeenCalled()
		})

		it('does not crash and prefetches nothing when the open message is not in the recorded list', async () => {
			store.lastOpenedFromList = { mailboxId: 50, query: undefined }

			mountAt(9999)
			await vi.waitFor(() => {
				expect(store.fetchThread).toHaveBeenCalled()
			})

			expect(store.fetchMessage.mock.calls.filter((call) => call[1]?.speculative)).toHaveLength(0)
		})

		// Priority Inbox's sections all share the SAME mailboxId
		// (UNIFIED_INBOX_ID) but each has its own distinct query --
		// getEnvelopes() keys its lists by query within a mailbox, so
		// this already disambiguates correctly with no special-casing:
		// unlike the old route-param-based approach, this one works for
		// Priority Inbox and the unified inbox too, not just a single
		// regular folder.
		it('correctly picks the Important section, not Other, when opened from Important', async () => {
			store.lastOpenedFromList = { mailboxId: UNIFIED_INBOX_ID, query: 'is:pi-important' }

			mountAt(9002)
			await vi.waitFor(() => {
				expect(store.fetchMessage).toHaveBeenCalledWith(9001, { speculative: true })
			})

			expect(store.fetchMessage).toHaveBeenCalledWith(9003, { speculative: true })
			expect(store.fetchMessage).not.toHaveBeenCalledWith(9101, expect.anything())
			expect(store.fetchMessage).not.toHaveBeenCalledWith(9103, expect.anything())
		})

		it('correctly picks the Other section, not Important, when opened from Other', async () => {
			store.lastOpenedFromList = { mailboxId: UNIFIED_INBOX_ID, query: 'is:pi-other' }

			mountAt(9102)
			await vi.waitFor(() => {
				expect(store.fetchMessage).toHaveBeenCalledWith(9101, { speculative: true })
			})

			expect(store.fetchMessage).toHaveBeenCalledWith(9103, { speculative: true })
			expect(store.fetchMessage).not.toHaveBeenCalledWith(9001, expect.anything())
			expect(store.fetchMessage).not.toHaveBeenCalledWith(9003, expect.anything())
		})
	})

	describe('list navigation controls', () => {
		function mountAt(threadId) {
			return shallowMount(Thread, {
				mocks: {
					$route: { params: { mailboxId: 50, threadId } },
				},
				store,
				localVue,
				data: () => ({ loading: false }),
			})
		}

		beforeEach(() => {
			store.getMailbox = vi.fn().mockImplementation((id) => (id === 50 ? { databaseId: 50 } : undefined))
			store.getEnvelopes = vi.fn().mockReturnValue([
				{ databaseId: 8001 },
				{ databaseId: 8002 },
				{ databaseId: 8003 },
			])
			store.fetchThread = vi.fn().mockResolvedValue([])
			store.lastOpenedFromList = { mailboxId: 50, query: 'is:starred' }
		})

		it('emits the existing shortcut payload for each available neighbor', () => {
			const view = mountAt(8002)

			expect(view.vm.listNavigation).toEqual({ hasPrevious: true, hasNext: true })

			view.vm.navigateList('prev')
			view.vm.navigateList('next')

			expect(view.emitted('navigate-list')).toEqual([
				[{ srcKey: 'prev' }],
				[{ srcKey: 'next' }],
			])
		})

		it('does not emit a shortcut beyond an unavailable boundary', () => {
			const view = mountAt(8001)

			expect(view.vm.listNavigation).toEqual({ hasPrevious: false, hasNext: true })

			view.vm.navigateList('prev')

			expect(view.emitted('navigate-list')).toBeUndefined()
		})

		it('does not expose a deleted undo-pending thread as a previous destination', () => {
			store.beginPendingRemoval([8001])
			const view = mountAt(8002)

			expect(view.vm.listNavigation).toEqual({ hasPrevious: false, hasNext: true })

			view.vm.navigateList('prev')

			expect(view.emitted('navigate-list')).toBeUndefined()
		})

		it('keeps the subject, metadata and body on the same pending-removal view', () => {
			store.getEnvelope = vi.fn().mockReturnValue({
				databaseId: 8002,
				subject: 'Deleted subject',
				from: [{ email: 'from@example.com' }],
				to: [{ email: 'to@example.com' }],
				flags: {},
			})
			store.beginPendingRemoval([8002])
			const view = mountAt(8002)

			expect(view.vm.visibleThread).toEqual([])
			expect(view.vm.threadSubject).toBe('')
			expect(view.vm.threadMetaText).toContain('0')
		})

		it('hides controls when the thread was not opened from a loaded list', () => {
			store.lastOpenedFromList = null
			const view = mountAt(8002)

			expect(view.vm.listNavigation).toBeUndefined()
			expect(view.find('#mail-thread-list-navigation').exists()).toBe(false)
		})
	})

	describe('advanceAfterRemoval() delegates to the mailbox list, like single-message removal', () => {
		// Whole-thread removal (delete/move/junk/snooze) must advance exactly
		// like deleting a single message does: it emits 'delete', which
		// MailboxThread forwards to the list's own onDelete() -- the one place
		// that owns the sort-agnostic next/previous/back-to-list preference
		// logic and, crucially, uses the list component's *own* mailbox+query
		// (correct even in unified/Priority Inbox sections, where Thread's own
		// listNavigation resolved empty and wrongly sent every thread removal
		// back to the list). With no list context (a direct URL/bookmark/
		// notification) there's nothing to advance within, so it closes the pane.
		function mountAt(threadId) {
			return shallowMount(Thread, {
				mocks: {
					$route: { params: { mailboxId: 50, threadId } },
					$router: { replace: vi.fn() },
				},
				store,
				localVue,
				data: () => ({ loading: false }),
			})
		}

		beforeEach(() => {
			store.getMailbox = vi.fn().mockImplementation((id) => (id === 50 ? { databaseId: 50 } : undefined))
			store.getEnvelopes = vi.fn().mockReturnValue([
				{ databaseId: 8001 },
				{ databaseId: 8002 },
				{ databaseId: 8003 },
			])
			store.fetchThread = vi.fn().mockResolvedValue([])
		})

		it('emits "delete" with the open thread id when opened from a list (reusing the single-message advance path)', () => {
			store.lastOpenedFromList = { mailboxId: 50, query: 'is:starred' }
			const view = mountAt(8002)

			view.vm.advanceAfterRemoval()

			expect(view.emitted('delete')).toEqual([[8002]])
			expect(view.vm.$router.replace).not.toHaveBeenCalled()
		})

		it('closes the reading pane when there is no list context to advance within', () => {
			store.lastOpenedFromList = null
			const view = mountAt(8002)

			view.vm.advanceAfterRemoval()

			expect(view.emitted('delete')).toBeUndefined()
			expect(view.vm.$router.replace).toHaveBeenCalledWith(expect.objectContaining({ name: 'mailbox' }))
		})
	})

	describe('onRequestDeleteOne/onRequestArchiveOne (ThreadEnvelope.vue requests them instead of calling the store itself)', () => {
		// Deleting/archiving a single message from within an open thread
		// used to call deleteMessage()/moveMessage() directly from
		// ThreadEnvelope.vue -- a separate entry point from
		// EnvelopeList.vue's own delete, with zero undo coverage. Both
		// now go through the same UndoableActionMixin.
		const envelope = { databaseId: 1001, accountId: 100 }

		beforeEach(() => {
			vi.useFakeTimers()
			store.deleteMessage = vi.fn().mockResolvedValue()
			store.moveMessage = vi.fn().mockResolvedValue()
			store.getAccount = vi.fn().mockReturnValue({ archiveMailboxId: 55 })
			showUndo.mockClear()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		function mountThread() {
			return shallowMount(Thread, {
				mocks: { $route: { params: { threadId: 200 } } },
				store,
				localVue,
			})
		}

		it('defers the real delete behind an undo window', async () => {
			const view = mountThread()

			view.vm.onRequestDeleteOne(envelope)
			await vi.advanceTimersByTimeAsync(0)
			expect(store.deleteMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.deleteMessage).toHaveBeenCalledWith({ id: 1001 })
		})

		it('never deletes at all if Undo is clicked in time', async () => {
			const view = mountThread()

			view.vm.onRequestDeleteOne(envelope)
			await vi.advanceTimersByTimeAsync(0)
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.deleteMessage).not.toHaveBeenCalled()
		})

		it('defers the real archive (moveMessage, resolving the destination from the envelope\'s own account) behind the same undo window', async () => {
			const view = mountThread()

			view.vm.onRequestArchiveOne(envelope)
			await vi.advanceTimersByTimeAsync(0)
			expect(store.moveMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.getAccount).toHaveBeenCalledWith(100)
			expect(store.moveMessage).toHaveBeenCalledWith({ id: 1001, destMailboxId: 55 })
		})
	})

	describe('onRequestToggleJunkOne (ThreadEnvelope.vue/MenuEnvelope.vue both request it instead of calling the store directly)', () => {
		const envelope = { databaseId: 1001, accountId: 100, flags: { seen: false } }

		beforeEach(() => {
			vi.useFakeTimers()
			store.toggleEnvelopeImportant = vi.fn().mockResolvedValue()
			store.toggleEnvelopeSeen = vi.fn().mockResolvedValue()
			store.toggleEnvelopeJunk = vi.fn().mockResolvedValue()
			showUndo.mockClear()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		function mountThread() {
			return shallowMount(Thread, {
				mocks: { $route: { params: { threadId: 200 } } },
				store,
				localVue,
			})
		}

		it('defers important/seen/junk toggling behind the undo window', async () => {
			const view = mountThread()

			view.vm.onRequestToggleJunkOne({ envelope, removeEnvelope: true, isImportant: true })
			await vi.advanceTimersByTimeAsync(0)
			expect(store.toggleEnvelopeJunk).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.toggleEnvelopeImportant).toHaveBeenCalledWith(envelope)
			expect(store.toggleEnvelopeSeen).toHaveBeenCalledWith({ envelope })
			expect(store.toggleEnvelopeJunk).toHaveBeenCalledWith({ envelope, removeEnvelope: true })
		})

		it('never toggles anything if Undo is clicked in time', async () => {
			const view = mountThread()

			view.vm.onRequestToggleJunkOne({ envelope, removeEnvelope: true, isImportant: true })
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.toggleEnvelopeJunk).not.toHaveBeenCalled()
		})
	})

	describe('onRequestMove (ThreadEnvelope.vue\'s own "Move to folder..." dialog)', () => {
		const envelope = { databaseId: 1001, accountId: 100 }

		beforeEach(() => {
			vi.useFakeTimers()
			store.moveThread = vi.fn().mockResolvedValue()
			store.moveMessage = vi.fn().mockResolvedValue()
			store.syncEnvelopes = vi.fn().mockResolvedValue()
			showUndo.mockClear()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		function mountThread() {
			return shallowMount(Thread, {
				mocks: { $route: { params: { threadId: 200 } } },
				store,
				localVue,
			})
		}

		it('defers the real move behind an undo window and syncs the destination mailbox afterwards', async () => {
			const view = mountThread()

			view.vm.onRequestMove({ envelopes: [envelope], destMailboxId: 55, moveThread: true })
			await vi.advanceTimersByTimeAsync(0)
			expect(store.moveThread).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.moveThread).toHaveBeenCalledWith({ envelope, destMailboxId: 55 })
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 55 })
		})

		it('never moves anything if Undo is clicked in time', async () => {
			const view = mountThread()

			view.vm.onRequestMove({ envelopes: [envelope], destMailboxId: 55, moveThread: true })
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.moveThread).not.toHaveBeenCalled()
			expect(store.syncEnvelopes).not.toHaveBeenCalled()
		})
	})

	describe('onRequestSnooze (MenuEnvelope.vue\'s own snooze action, via ThreadEnvelope.vue)', () => {
		const envelope = { databaseId: 1001, accountId: 100 }

		beforeEach(() => {
			vi.useFakeTimers()
			store.snoozeThread = vi.fn().mockResolvedValue()
			store.snoozeMessage = vi.fn().mockResolvedValue()
			showUndo.mockClear()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		function mountThread() {
			return shallowMount(Thread, {
				mocks: { $route: { params: { threadId: 200 } } },
				store,
				localVue,
			})
		}

		it('defers the real snooze behind an undo window', async () => {
			const view = mountThread()

			view.vm.onRequestSnooze({ envelope, isThreaded: false, unixTimestamp: 1700000000, destMailboxId: 88 })
			await vi.advanceTimersByTimeAsync(0)
			expect(store.snoozeMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.snoozeMessage).toHaveBeenCalledWith({ id: envelope.databaseId, unixTimestamp: 1700000000, destMailboxId: 88 })
		})

		it('never snoozes anything if Undo is clicked in time', async () => {
			const view = mountThread()

			view.vm.onRequestSnooze({ envelope, isThreaded: false, unixTimestamp: 1700000000, destMailboxId: 88 })
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.snoozeMessage).not.toHaveBeenCalled()
		})
	})

	describe('thread-level actions (the header ⋮ menu, 2026-07-20)', () => {
		function mountThread(threadId) {
			return shallowMount(Thread, {
				mocks: {
					$route: { params: { threadId, mailboxId: '30' } },
					$router: { replace: vi.fn() },
				},
				store,
				localVue,
			})
		}

		it('exposes unread state and a compact "N messages · X participants" meta line', () => {
			const unread = mountThread(4003)
			expect(unread.vm.threadHasUnread).toBe(true)
			// 3 messages in the fixture; no from/to -> falls back to 1 participant
			expect(unread.vm.threadMetaText).toContain('3')

			const allRead = mountThread(5003)
			expect(allRead.vm.threadHasUnread).toBe(false)
		})

		it('caps how many leading actions promote onto the toolbar (threadInlineMenuSize)', () => {
			// Only the safe, reversible leading actions may leave the ⋮ menu:
			// mark-all-read (always) + archive (only if the account has an
			// archive mailbox). The destructive ones after them can never
			// promote, so the size never exceeds how many of those exist.
			store.getAccount = vi.fn().mockReturnValue({ archiveMailboxId: 55 })
			const withArchive = mountThread(4003)

			withArchive.vm.threadHeaderWidth = 320 // narrow split pane
			expect(withArchive.vm.threadInlineMenuSize).toBe(0)

			withArchive.vm.threadHeaderWidth = 560 // room for one
			expect(withArchive.vm.threadInlineMenuSize).toBe(1)

			withArchive.vm.threadHeaderWidth = 900 // room for both
			expect(withArchive.vm.threadInlineMenuSize).toBe(2)

			// No archive mailbox -> only mark-all-read is promotable, so a wide
			// pane still caps at 1 (archive/move/etc. stay in the menu).
			store.getAccount = vi.fn().mockReturnValue({ archiveMailboxId: null })
			const noArchive = mountThread(4003)
			noArchive.vm.threadHeaderWidth = 900
			expect(noArchive.vm.threadInlineMenuSize).toBe(1)
		})

		it('marks all as read by toggling only the messages that are still unread', async () => {
			store.toggleEnvelopeSeen = vi.fn().mockResolvedValue()
			const view = mountThread(4003)

			view.vm.markThreadSeen(true)
			await view.vm.$nextTick()

			// Only 4001 is unread in the fixture, so only it is toggled
			expect(store.toggleEnvelopeSeen).toHaveBeenCalledTimes(1)
			expect(store.toggleEnvelopeSeen).toHaveBeenCalledWith({
				envelope: expect.objectContaining({ databaseId: 4001 }),
			})
		})

		it('marks all as unread by toggling every currently-read message', async () => {
			store.toggleEnvelopeSeen = vi.fn().mockResolvedValue()
			const view = mountThread(5003)

			view.vm.markThreadSeen(false)
			await view.vm.$nextTick()

			// All three fixture messages are read -> all three toggled
			expect(store.toggleEnvelopeSeen).toHaveBeenCalledTimes(3)
		})

		it('deletes the whole thread behind an undo window and closes the reading pane immediately', async () => {
			vi.useFakeTimers()
			store.deleteThread = vi.fn().mockResolvedValue()
			showUndo.mockClear()
			const view = mountThread(4003)

			view.vm.deleteThreadAction()

			// Navigates back to the mailbox right away (before awaiting)
			expect(view.vm.$router.replace).toHaveBeenCalledWith(expect.objectContaining({ name: 'mailbox' }))
			// The real, irreversible delete is deferred
			await vi.advanceTimersByTimeAsync(0)
			expect(store.deleteThread).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.deleteThread).toHaveBeenCalledWith({
				envelope: expect.objectContaining({ databaseId: 4003 }),
			})
			vi.useRealTimers()
		})

		it('never deletes the thread if Undo is clicked in time', async () => {
			vi.useFakeTimers()
			store.deleteThread = vi.fn().mockResolvedValue()
			showUndo.mockClear()
			const view = mountThread(4003)

			view.vm.deleteThreadAction()
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.deleteThread).not.toHaveBeenCalled()
			vi.useRealTimers()
		})

		it('archives the whole thread (moveThread to the account archive) behind the undo window', async () => {
			vi.useFakeTimers()
			store.getAccount = vi.fn().mockReturnValue({ archiveMailboxId: 55 })
			store.moveThread = vi.fn().mockResolvedValue()
			store.syncEnvelopes = vi.fn().mockResolvedValue()
			showUndo.mockClear()
			const view = mountThread(4003)

			view.vm.archiveThread()
			expect(view.vm.$router.replace).toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.moveThread).toHaveBeenCalledWith({
				envelope: expect.objectContaining({ databaseId: 4003 }),
				destMailboxId: 55,
			})
			vi.useRealTimers()
		})

		it('moves the whole thread to the chosen folder from the Move modal', async () => {
			vi.useFakeTimers()
			store.moveThread = vi.fn().mockResolvedValue()
			store.syncEnvelopes = vi.fn().mockResolvedValue()
			showUndo.mockClear()
			const view = mountThread(4003)

			view.vm.onThreadMove({ destMailboxId: 77 })
			expect(view.vm.showMoveModal).toBe(false)
			expect(view.vm.$router.replace).toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.moveThread).toHaveBeenCalledWith({
				envelope: expect.objectContaining({ databaseId: 4003 }),
				destMailboxId: 77,
			})
			vi.useRealTimers()
		})

		it('marks the whole thread as spam behind the undo window and advances, moving to Junk when one is configured', async () => {
			vi.useFakeTimers()
			store.junkMoveDestinationMailboxId = vi.fn().mockReturnValue(88)
			store.toggleEnvelopeJunk = vi.fn().mockResolvedValue()
			showUndo.mockClear()
			const view = mountThread(4003)
			// Fixture messages carry no $junk flag -> all three get junked
			expect(view.vm.threadIsJunk).toBe(false)

			view.vm.junkThread()

			// Advances right away (no list context here -> closes the pane), and
			// the real, folder-moving junk toggle is deferred behind the undo window
			expect(view.vm.$router.replace).toHaveBeenCalledWith(expect.objectContaining({ name: 'mailbox' }))
			expect(store.toggleEnvelopeJunk).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.toggleEnvelopeJunk).toHaveBeenCalledTimes(3)
			expect(store.toggleEnvelopeJunk).toHaveBeenCalledWith(expect.objectContaining({ removeEnvelope: true }))
			vi.useRealTimers()
		})

		it('marks the thread as spam in place (no move, no advance) when no Junk mailbox is configured', async () => {
			vi.useFakeTimers()
			store.junkMoveDestinationMailboxId = vi.fn().mockReturnValue(null)
			store.toggleEnvelopeJunk = vi.fn().mockResolvedValue()
			const view = mountThread(4003)

			view.vm.junkThread()

			// Nothing moves folders, so it stays put -- no navigation
			expect(view.vm.$router.replace).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.toggleEnvelopeJunk).toHaveBeenCalledWith(expect.objectContaining({ removeEnvelope: false }))
			vi.useRealTimers()
		})

		it('snoozes the whole thread behind the undo window, creating the snooze mailbox if needed, and closes the pane', async () => {
			vi.useFakeTimers()
			store.getAccount = vi.fn().mockReturnValue({ snoozeMailboxId: undefined })
			store.createAndSetSnoozeMailbox = vi.fn().mockImplementation(async (account) => {
				account.snoozeMailboxId = 99
			})
			store.snoozeThread = vi.fn().mockResolvedValue()
			showUndo.mockClear()
			const view = mountThread(4003)

			await view.vm.snoozeThreadAt(1700000000000)
			expect(store.createAndSetSnoozeMailbox).toHaveBeenCalled()
			expect(view.vm.$router.replace).toHaveBeenCalled()
			expect(view.vm.threadSnoozeOpen).toBe(false)

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.snoozeThread).toHaveBeenCalledWith({
				envelope: expect.objectContaining({ databaseId: 4003 }),
				unixTimestamp: 1700000000,
				destMailboxId: 99,
			})
			vi.useRealTimers()
		})
	})
})
