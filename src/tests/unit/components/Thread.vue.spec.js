/**
 * SPDX-FileCopyrightText: 2023 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Thread from '../../../components/Thread.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import { UNIFIED_INBOX_ID } from '../../../store/constants.js'
import useMainStore from '../../../store/mainStore.js'

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
			store.fetchThread = vi.fn().mockReturnValue(new Promise((_resolve, r) => { reject = r }))

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
			store.fetchThread = vi.fn().mockReturnValue(new Promise((_resolve, r) => { reject = r }))

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
			store.fetchThread = vi.fn().mockReturnValue(new Promise((_resolve, r) => { reject = r }))

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
})
