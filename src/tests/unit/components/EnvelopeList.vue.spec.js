/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { showUndo } from '@nextcloud/dialogs'
import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import EnvelopeList from '../../../components/EnvelopeList.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'

vi.mock('@nextcloud/dialogs', async (importOriginal) => ({
	...(await importOriginal()),
	showUndo: vi.fn(),
}))

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

describe('EnvelopeList', () => {
	let store
	let account
	let mailbox
	let envelopes

	beforeEach(() => {
		setActivePinia(createPinia())
		store = useMainStore()

		account = { id: 4 }
		mailbox = { databaseId: 38, accountId: 4 }
		envelopes = [
			{ databaseId: 1, flags: {}, dateInt: 1 },
			{ databaseId: 2, flags: {}, dateInt: 2 },
			{ databaseId: 3, flags: {}, dateInt: 3 },
		]
	})

	function mountEnvelopeList(propsOverride = {}, mocksOverride = {}) {
		return shallowMount(EnvelopeList, {
			propsData: {
				account,
				mailbox,
				envelopes,
				loadingMore: false,
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

	describe('optimistic bulk read state', () => {
		it('sends one optimistic batch before clearing the selection', async () => {
			envelopes[0].flags = { seen: false, hasUnseenInThread: true }
			envelopes[1].flags = { seen: false, hasUnseenInThread: true }
			store.setEnvelopesSeen = vi.fn().mockReturnValue(new Promise(() => {}))
			const view = mountEnvelopeList()
			await view.setData({ selection: [1, 2] })

			view.vm.markSelectedRead()

			expect(store.setEnvelopesSeen).toHaveBeenCalledTimes(1)
			expect(store.setEnvelopesSeen).toHaveBeenCalledWith({
				envelopes: [envelopes[0], envelopes[1]],
				seen: true,
			})
			expect(view.vm.selection).toEqual([])
		})
	})

	describe('records list context when auto-navigating after a bulk delete', () => {
		// Thread.vue::prefetchListNeighborhood() reads
		// mainStore.lastOpenedFromList to prefetch this list's neighbors.
		// deleteAllSelected()'s auto-jump to the surviving message lands on
		// 'message' the same way a click does, but without going through
		// Envelope.vue's onClick() -- so without its own recording, opening
		// a message this way would prefetch stale (or no) neighbors.
		beforeEach(() => {
			store.deleteThread = vi.fn().mockResolvedValue()
			store.fetchNextEnvelopes = vi.fn().mockResolvedValue([])
		})

		it('records the mailbox and search query before navigating to the surviving message', async () => {
			const view = mountEnvelopeList({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 2 } } })
			await view.setData({ selection: [2] })

			await view.vm.deleteAllSelected()

			expect(store.lastOpenedFromList).toEqual({ mailboxId: 38, query: 'is:starred', databaseId: 1 })
			expect(view.vm.$router.push).toHaveBeenCalledWith(expect.objectContaining({
				params: expect.objectContaining({ threadId: 1 }),
			}))
		})

		it('does not record anything when every envelope in the list was selected (navigates to the mailbox, not a message)', async () => {
			const view = mountEnvelopeList({ searchQuery: 'is:starred' }, { $route: { params: { threadId: 2 } } })
			await view.setData({ selection: [1, 2, 3] })

			await view.vm.deleteAllSelected()

			expect(store.lastOpenedFromList).toBeNull()
			expect(view.vm.$router.push).toHaveBeenCalledWith(expect.objectContaining({ name: 'mailbox' }))
		})
	})

	describe('undo window on delete (backlog item #5: no confirmation dialog, but a real undo)', () => {
		// Deletes had no confirmation dialog and no undo affordance at
		// all -- reversibility was entirely implicit ("go find it in
		// Trash yourself"). The stronger, standard pattern is an "N
		// deleted -- Undo" toast: the row disappears immediately, but the
		// real, irreversible server-side call is held back for a few
		// seconds in case the user meant something else.
		beforeEach(() => {
			vi.useFakeTimers()
			store.deleteThread = vi.fn().mockResolvedValue()
			store.deleteThreads = vi.fn().mockResolvedValue()
			store.deleteMessage = vi.fn().mockResolvedValue()
			showUndo.mockClear()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('hides the deleted envelopes immediately, before the undo window even starts counting down', async () => {
			const view = mountEnvelopeList()
			await view.setData({ selection: [1, 2] })

			await view.vm.deleteAllSelected()

			expect(view.vm.sortedEnvelops.map((e) => e.databaseId)).toEqual([3])
			// Nothing irreversible yet -- the real call only happens once
			// the undo window passes without being cancelled.
			expect(store.deleteThread).not.toHaveBeenCalled()
			expect(store.deleteThreads).not.toHaveBeenCalled()
		})

		it('only actually deletes once the undo window passes uninterrupted', async () => {
			const view = mountEnvelopeList()
			await view.setData({ selection: [1, 2] })

			await view.vm.deleteAllSelected()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.deleteThreads).toHaveBeenCalledTimes(1)
			expect(store.deleteThreads).toHaveBeenCalledWith({ envelopes: [envelopes[0], envelopes[1]] })
		})

		it('never calls the real delete at all if Undo is clicked in time', async () => {
			const view = mountEnvelopeList()
			await view.setData({ selection: [1, 2] })

			await view.vm.deleteAllSelected()
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.deleteThread).not.toHaveBeenCalled()
			expect(store.deleteThreads).not.toHaveBeenCalled()
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId).sort()).toEqual([1, 2, 3])
		})

		it('a single envelope\'s own delete request goes through the same undo window as a bulk delete', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestDeleteOne({ envelope: envelopes[0], isThreaded: true })
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId)).toEqual([2, 3])
			expect(store.deleteThread).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.deleteThread).toHaveBeenCalledWith({ envelope: envelopes[0] })
		})

		it('routes a single non-threaded delete request through deleteMessage instead of deleteThread', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestDeleteOne({ envelope: envelopes[0], isThreaded: false })
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.deleteMessage).toHaveBeenCalledWith({ id: envelopes[0].databaseId })
			expect(store.deleteThread).not.toHaveBeenCalled()
		})
	})

	describe('undo window on bulk junk-marking (real user reports exist of accidental bulk spam-marking with no way back)', () => {
		beforeEach(() => {
			vi.useFakeTimers()
			store.toggleEnvelopeJunk = vi.fn().mockResolvedValue()
			showUndo.mockClear()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('hides only the envelopes that will actually leave the mailbox (removeEnvelope=true), immediately', async () => {
			// Envelope 2 has no junk mailbox configured for its account
			// (or is already there) -- it stays visible either way, so it
			// must not flicker out and back in over the undo window.
			store.moveEnvelopeToJunk = vi.fn().mockImplementation((envelope) => Promise.resolve(envelope.databaseId !== 2))
			const view = mountEnvelopeList()
			await view.setData({ selection: [1, 2, 3] })

			await view.vm.markSelectionJunk()

			expect(view.vm.sortedEnvelops.map((e) => e.databaseId)).toEqual([2])
			expect(store.toggleEnvelopeJunk).not.toHaveBeenCalled()
		})

		it('only actually flags/moves the selection once the undo window passes uninterrupted', async () => {
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(true)
			const view = mountEnvelopeList()
			await view.setData({ selection: [1, 2] })

			await view.vm.markSelectionJunk()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.toggleEnvelopeJunk).toHaveBeenCalledTimes(2)
			expect(store.toggleEnvelopeJunk).toHaveBeenCalledWith({ envelope: envelopes[0], removeEnvelope: true })
			expect(store.toggleEnvelopeJunk).toHaveBeenCalledWith({ envelope: envelopes[1], removeEnvelope: true })
		})

		it('never marks anything as spam at all if Undo is clicked in time', async () => {
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(true)
			const view = mountEnvelopeList()
			await view.setData({ selection: [1, 2] })

			await view.vm.markSelectionJunk()
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.toggleEnvelopeJunk).not.toHaveBeenCalled()
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId).sort()).toEqual([1, 2, 3])
		})

		it('markSelectionNotJunk only targets already-junk envelopes', async () => {
			envelopes[0].flags.$junk = true
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(true)
			const view = mountEnvelopeList()
			await view.setData({ selection: [1, 2, 3] })

			await view.vm.markSelectionNotJunk()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.toggleEnvelopeJunk).toHaveBeenCalledTimes(1)
			expect(store.toggleEnvelopeJunk).toHaveBeenCalledWith({ envelope: envelopes[0], removeEnvelope: true })
		})
	})

	describe('onRequestToggleJunkOne/onRequestToggleJunkThread (a single row/thread requests the same undo window)', () => {
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

		it('hides the row immediately only when removeEnvelope is true', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestToggleJunkOne({ envelope: envelopes[0], removeEnvelope: true, isImportant: false })
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId)).toEqual([2, 3])
		})

		it('does not hide the row when removeEnvelope is false -- it stays visible either way', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestToggleJunkOne({ envelope: envelopes[0], removeEnvelope: false, isImportant: false })
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId)).toEqual([1, 2, 3])
		})

		it('defers clearing important and marking seen until the undo window passes, in the same order as before', async () => {
			envelopes[0].flags.seen = false
			const view = mountEnvelopeList()

			view.vm.onRequestToggleJunkOne({ envelope: envelopes[0], removeEnvelope: true, isImportant: true })
			await vi.advanceTimersByTimeAsync(0)
			expect(store.toggleEnvelopeImportant).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.toggleEnvelopeImportant).toHaveBeenCalledWith(envelopes[0])
			expect(store.toggleEnvelopeSeen).toHaveBeenCalledWith({ envelope: envelopes[0] })
			expect(store.toggleEnvelopeJunk).toHaveBeenCalledWith({ envelope: envelopes[0], removeEnvelope: true })
		})

		it('does not mark seen again if the envelope was already seen', async () => {
			envelopes[0].flags.seen = true
			const view = mountEnvelopeList()

			view.vm.onRequestToggleJunkOne({ envelope: envelopes[0], removeEnvelope: true, isImportant: false })
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.toggleEnvelopeSeen).not.toHaveBeenCalled()
		})

		it('never toggles anything at all if Undo is clicked in time', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestToggleJunkOne({ envelope: envelopes[0], removeEnvelope: true, isImportant: true })
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.toggleEnvelopeImportant).not.toHaveBeenCalled()
			expect(store.toggleEnvelopeSeen).not.toHaveBeenCalled()
			expect(store.toggleEnvelopeJunk).not.toHaveBeenCalled()
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId).sort()).toEqual([1, 2, 3])
		})

		it('onRequestToggleJunkThread applies the toggle to every envelope in the thread', async () => {
			const threadEnvelopes = [
				{ databaseId: 101, flags: { seen: true } },
				{ databaseId: 102, flags: { seen: false } },
			]
			const view = mountEnvelopeList()

			view.vm.onRequestToggleJunkThread({ envelopes: threadEnvelopes, removeEnvelope: true, isImportant: false })
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.toggleEnvelopeJunk).toHaveBeenCalledWith({ envelope: threadEnvelopes[0], removeEnvelope: true })
			expect(store.toggleEnvelopeJunk).toHaveBeenCalledWith({ envelope: threadEnvelopes[1], removeEnvelope: true })
			expect(store.toggleEnvelopeSeen).toHaveBeenCalledWith({ envelope: threadEnvelopes[1] })
			expect(store.toggleEnvelopeSeen).not.toHaveBeenCalledWith({ envelope: threadEnvelopes[0] })
		})
	})

	describe('onRequestArchiveOne/onRequestMove (a single row\'s own archive button, quick-action move, and the Move-to-folder dialog)', () => {
		beforeEach(() => {
			vi.useFakeTimers()
			store.moveThread = vi.fn().mockResolvedValue()
			store.moveMessage = vi.fn().mockResolvedValue()
			store.syncEnvelopes = vi.fn().mockResolvedValue()
			account.archiveMailboxId = 99
			showUndo.mockClear()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('defers the real archive (moveThread) behind an undo window and hides the row immediately', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestArchiveOne({ envelope: envelopes[0], isThreaded: true })
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId)).toEqual([2, 3])
			expect(store.moveThread).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.moveThread).toHaveBeenCalledWith({ envelope: envelopes[0], destMailboxId: 99 })
		})

		it('routes a non-threaded archive request through moveMessage instead of moveThread', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestArchiveOne({ envelope: envelopes[0], isThreaded: false })
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.moveMessage).toHaveBeenCalledWith({ id: envelopes[0].databaseId, destMailboxId: 99 })
			expect(store.moveThread).not.toHaveBeenCalled()
		})

		it('defers the real move (moveThread) to the chosen destination behind an undo window -- quick-action shape (one envelope)', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestMove({ envelopes: [envelopes[0]], destMailboxId: 77, moveThread: true })
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId)).toEqual([2, 3])
			expect(store.moveThread).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.moveThread).toHaveBeenCalledWith({ envelope: envelopes[0], destMailboxId: 77 })
		})

		it('defers a bulk move-to-folder (MoveModal.vue) for every selected envelope, as one combined undo toast', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestMove({ envelopes: [envelopes[0], envelopes[1]], destMailboxId: 77, moveThread: true })
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId)).toEqual([3])
			expect(showUndo).toHaveBeenCalledTimes(1)

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.moveThread).toHaveBeenCalledWith({ envelope: envelopes[0], destMailboxId: 77 })
			expect(store.moveThread).toHaveBeenCalledWith({ envelope: envelopes[1], destMailboxId: 77 })
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 77 })
		})

		it('routes a non-threaded move request through moveMessage instead of moveThread', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestMove({ envelopes: [envelopes[0]], destMailboxId: 77, moveThread: false })
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.moveMessage).toHaveBeenCalledWith({ id: envelopes[0].databaseId, destMailboxId: 77 })
			expect(store.moveThread).not.toHaveBeenCalled()
		})

		it('never moves anything if Undo is clicked in time', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestMove({ envelopes: [envelopes[0]], destMailboxId: 77, moveThread: true })
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.moveThread).not.toHaveBeenCalled()
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId).sort()).toEqual([1, 2, 3])
		})
	})

	describe('onRequestSnooze (a single row\'s own snooze action)', () => {
		beforeEach(() => {
			vi.useFakeTimers()
			store.snoozeThread = vi.fn().mockResolvedValue()
			store.snoozeMessage = vi.fn().mockResolvedValue()
			showUndo.mockClear()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('hides the row immediately and defers the real snooze (snoozeThread) behind an undo window', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestSnooze({ envelope: envelopes[0], isThreaded: true, unixTimestamp: 1700000000, destMailboxId: 88 })
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId)).toEqual([2, 3])
			expect(store.snoozeThread).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(10000)
			expect(store.snoozeThread).toHaveBeenCalledWith({ envelope: envelopes[0], unixTimestamp: 1700000000, destMailboxId: 88 })
		})

		it('routes a non-threaded snooze request through snoozeMessage instead of snoozeThread', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestSnooze({ envelope: envelopes[0], isThreaded: false, unixTimestamp: 1700000000, destMailboxId: 88 })
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.snoozeMessage).toHaveBeenCalledWith({ id: envelopes[0].databaseId, unixTimestamp: 1700000000, destMailboxId: 88 })
			expect(store.snoozeThread).not.toHaveBeenCalled()
		})

		it('never snoozes anything if Undo is clicked in time', async () => {
			const view = mountEnvelopeList()

			view.vm.onRequestSnooze({ envelope: envelopes[0], isThreaded: true, unixTimestamp: 1700000000, destMailboxId: 88 })
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.snoozeThread).not.toHaveBeenCalled()
			expect(view.vm.sortedEnvelops.map((e) => e.databaseId).sort()).toEqual([1, 2, 3])
		})
	})

	describe('listTransitionName: drops the enter/leave animation on long lists', () => {
		// On a deep-scrolled list the per-row enter/leave transitions
		// (transition: all + per-row getTransitionInfo/DOMPurify work)
		// dominate paint time as new pages stream in during scroll -- the
		// 2026-07-20 profile flagged exactly this at ~1145 rows. A short list
		// at the head keeps animating; a long one does not.
		function manyEnvelopes(count) {
			return Array.from({ length: count }, (_, i) => ({ databaseId: i + 1, flags: {}, dateInt: i + 1 }))
		}

		it('animates a short list (at or below the threshold)', () => {
			const view = mountEnvelopeList({ envelopes: manyEnvelopes(200) })

			expect(view.vm.sortedEnvelops.length).toBe(200)
			expect(view.vm.listTransitionName).toBe('list')
		})

		it('stops animating once the list grows past the threshold', () => {
			const view = mountEnvelopeList({ envelopes: manyEnvelopes(201) })

			expect(view.vm.listTransitionName).toBe('disabled')
		})

		it('still honours skipTransition on a short list (bulk-removal suppression)', () => {
			const view = mountEnvelopeList({ envelopes: manyEnvelopes(3), skipTransition: true })

			expect(view.vm.listTransitionName).toBe('disabled')
		})
	})
})
