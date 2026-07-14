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

			expect(store.lastOpenedFromList).toEqual({ mailboxId: 38, query: 'is:starred' })
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
		})

		it('only actually deletes once the undo window passes uninterrupted', async () => {
			const view = mountEnvelopeList()
			await view.setData({ selection: [1, 2] })

			await view.vm.deleteAllSelected()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.deleteThread).toHaveBeenCalledTimes(2)
		})

		it('never calls the real delete at all if Undo is clicked in time', async () => {
			const view = mountEnvelopeList()
			await view.setData({ selection: [1, 2] })

			await view.vm.deleteAllSelected()
			const onUndo = showUndo.mock.calls[0][1]
			onUndo()
			await vi.advanceTimersByTimeAsync(10000)

			expect(store.deleteThread).not.toHaveBeenCalled()
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
})
