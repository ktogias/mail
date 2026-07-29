/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SearchMessages from '../../../components/SearchMessages.vue'
import useMainStore from '../../../store/mainStore.js'

/**
 * The quick-filter row -- "Has attachment", "Unread", "To me" -- is hidden
 * until the search box is focused.
 *
 * .39 pinned it open in the Priority Inbox. That was collateral: what .39
 * actually fixed was a duplicate "Unread only" checkbox in the overview bar,
 * and that fix stands either way. The row itself is chrome the user looks past
 * on every screen, for filters wanted occasionally.
 *
 * Hiding filters is only safe because of one thing, and it is the thing these
 * tests exist to hold: a filter that is ON never hides. A collapsed row
 * silently narrowing the list would leave the user with no way to see why
 * messages are missing, which is a far worse outcome than one extra click.
 */
describe('SearchMessages quick filters', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		// hasToMeActive() compares against the account's own address, so the
		// component needs one to exist before any quick filter can be read.
		useMainStore().addAccountMutation({ id: 13, emailAddress: 'me@example.org' })
	})

	/** @return {object} a shallow-mounted component */
	const mountSearch = () => shallowMount(SearchMessages, {
		propsData: {
			mailbox: { databaseId: 1, isPriorityInbox: true, isUnified: false },
			accountId: 13,
		},
		mocks: { t: (app, text) => text },
		stubs: { NcChip: true },
	})

	it('keeps the filters out of the way until the user goes to search', () => {
		const wrapper = mountSearch()

		expect(wrapper.vm.showButtons).toBe(false)
		expect(wrapper.find('.filter-buttons').exists()).toBe(false)
	})

	it('reveals them when the search box is focused', async () => {
		const wrapper = mountSearch()

		wrapper.vm.showButtons = true
		await wrapper.vm.$nextTick()

		expect(wrapper.find('.filter-buttons').exists()).toBe(true)
	})

	it('does NOT hide a filter that is switched on', async () => {
		// The safety property. hideButtonsWithDelay(true) is what blur calls,
		// and it must decline while any quick filter is active -- otherwise
		// the list stays narrowed with nothing on screen saying so.
		vi.useFakeTimers()
		try {
			const wrapper = mountSearch()
			wrapper.vm.showButtons = true
			wrapper.vm.searchFlags = ['unread']
			expect(wrapper.vm.hasQuickFiltersActive).toBe(true)

			wrapper.vm.hideButtonsWithDelay(true)
			await vi.advanceTimersByTimeAsync(2000)

			expect(wrapper.vm.showButtons).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	it('hides them again once the last filter is switched off', async () => {
		vi.useFakeTimers()
		try {
			const wrapper = mountSearch()
			wrapper.vm.showButtons = true
			wrapper.vm.searchFlags = []

			wrapper.vm.hideButtonsWithDelay(true)
			await vi.advanceTimersByTimeAsync(2000)

			expect(wrapper.vm.showButtons).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})
})
