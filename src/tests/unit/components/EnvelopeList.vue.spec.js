/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import EnvelopeList from '../../../components/EnvelopeList.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'

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
})
