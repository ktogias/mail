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

describe('SearchMessages: the typed term must survive a re-mount', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		useMainStore().addAccountMutation({ id: 13, emailAddress: 'me@example.org' })
	})

	/**
	 * @param {number} mailboxId which folder's search box this is
	 * @return {object} a shallow-mounted component
	 */
	const mountFor = (mailboxId) => shallowMount(SearchMessages, {
		propsData: {
			mailbox: { databaseId: mailboxId, isPriorityInbox: false, isUnified: false },
			accountId: 13,
		},
		mocks: { t: (app, text) => text },
		stubs: { NcChip: true },
	})

	/**
	 * Reported with a screenshot on 2026-08-15: search, open a message, come
	 * back, and the input shows its placeholder while the list is still
	 * filtered. The clear button only renders for a non-empty term, so it had
	 * gone too -- there was no way back to the full list short of reloading.
	 *
	 * The term lived only in this component's local data, while the filter it
	 * produces lives in the parent and the store. Data flows one way, so
	 * nothing carried it back when the component was created again.
	 */
	it('restores what was typed when it is created again', async () => {
		const first = mountFor(21)
		first.vm.query = 'macbook'
		await first.vm.$nextTick()
		first.destroy()

		expect(mountFor(21).vm.query).toBe('macbook')
	})

	it('does not hand one mailbox another mailbox term', async () => {
		const first = mountFor(21)
		first.vm.query = 'macbook'
		await first.vm.$nextTick()
		first.destroy()

		expect(mountFor(22).vm.query).toBe('')
	})

	it('does not resurrect a term the user has cleared', async () => {
		const wrapper = mountFor(21)
		wrapper.vm.query = 'macbook'
		await wrapper.vm.$nextTick()
		wrapper.vm.query = ''
		await wrapper.vm.$nextTick()

		expect(useMainStore().getSearchTerm(21)).toBe('')
		expect(mountFor(21).vm.query).toBe('')
	})
})

/**
 * A body search is decided per account. The unified and priority inboxes have
 * no single account to ask -- `accountId` there is the unified pseudo-account,
 * whose `searchBody` is undefined -- so the per-account setting used to be
 * silently ignored in exactly the inbox the user sits in, and only the global
 * preference counted.
 *
 * Reported live on 2026-08-28: a word that was in a message body of an account
 * with body search explicitly enabled returned nothing from the priority
 * inbox, and the request carried no `body:` token at all.
 *
 * Asking whenever ANY account wants it is safe because the server now decides
 * per account too (MailSearch::searchesBodies), so the accounts that opted out
 * still pay nothing for the ones that did not.
 */
describe('SearchMessages: whose bodies get searched', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
	})

	/**
	 * @param {object} mailbox the mailbox this search box belongs to
	 * @param {number} accountId the account prop the parent passes down
	 * @return {object} a shallow-mounted component
	 */
	const mountIn = (mailbox, accountId) => shallowMount(SearchMessages, {
		propsData: { mailbox, accountId },
		mocks: { t: (app, text) => text },
		stubs: { NcChip: true },
	})

	const unifiedPseudoAccount = { id: 0, emailAddress: '', isUnified: true }
	const bodySearchOn = { id: 13, emailAddress: 'me@example.org', searchBody: true }
	const bodySearchOff = { id: 14, emailAddress: 'other@example.org', searchBody: false }

	it('asks for bodies in the priority inbox when an account wants them', () => {
		const store = useMainStore()
		store.addAccountMutation(unifiedPseudoAccount)
		store.addAccountMutation(bodySearchOff)
		store.addAccountMutation(bodySearchOn)

		const wrapper = mountIn({ databaseId: 'priority', isPriorityInbox: true }, 0)

		expect(wrapper.vm.searchBody).toBe(true)
	})

	it('asks for bodies in the unified inbox on the same grounds', () => {
		const store = useMainStore()
		store.addAccountMutation(unifiedPseudoAccount)
		store.addAccountMutation(bodySearchOn)

		const wrapper = mountIn({ databaseId: 'unified', isUnified: true }, 0)

		expect(wrapper.vm.searchBody).toBe(true)
	})

	it('does not ask when no account wants them and the preference is off', () => {
		const store = useMainStore()
		store.addAccountMutation(unifiedPseudoAccount)
		store.addAccountMutation(bodySearchOff)

		const wrapper = mountIn({ databaseId: 'priority', isPriorityInbox: true }, 0)

		expect(wrapper.vm.searchBody).toBe(false)
	})

	it('still lets the priority-inbox preference turn them on by itself', () => {
		const store = useMainStore()
		store.addAccountMutation(unifiedPseudoAccount)
		store.addAccountMutation(bodySearchOff)
		store.savePreferenceMutation({ key: 'search-priority-body', value: 'true' })

		const wrapper = mountIn({ databaseId: 'priority', isPriorityInbox: true }, 0)

		expect(wrapper.vm.searchBody).toBe(true)
	})

	/**
	 * Typing must not fire an IMAP round trip per keystroke.
	 *
	 * A header search is a local database query; a body search is a full round
	 * trip to the mail server, measured live on 2026-08-31 at 8.4 s for one
	 * word and 25.1 s for three. At the shared 700 ms debounce every pause
	 * between two words started its own, so `ifiroumelioti Ασυρματο δίκτυο`
	 * paid three real body searches for one question -- and aborting the
	 * superseded requests does not help, because the HTTP client gives up
	 * while the PHP worker carries on and pays for the round trip anyway.
	 */
	it('asks for headers while typing and never carries the last keystroke\'s bodies forward', async () => {
		const store = useMainStore()
		store.addAccountMutation(unifiedPseudoAccount)
		store.addAccountMutation(bodySearchOn)
		const wrapper = mountIn({ databaseId: 'priority', isPriorityInbox: true }, 0)

		wrapper.vm.query = 'ifiroumelioti'
		await wrapper.vm.$nextTick()

		expect(wrapper.vm.searchBody).toBe(true)
		expect(wrapper.vm.searchInMessageBody).toBe(null)
		expect(wrapper.vm.searchQuery).not.toContain('body:')
		expect(wrapper.vm.searchQuery).toContain('text:ifiroumelioti')
	})

	it('adds the bodies once the box has settled', async () => {
		const store = useMainStore()
		store.addAccountMutation(unifiedPseudoAccount)
		store.addAccountMutation(bodySearchOn)
		const wrapper = mountIn({ databaseId: 'priority', isPriorityInbox: true }, 0)
		wrapper.vm.query = 'ifiroumelioti'
		await wrapper.vm.$nextTick()

		wrapper.vm.sendBodySearchEvent()

		expect(wrapper.vm.searchInMessageBody).toBe('ifiroumelioti')
		expect(wrapper.vm.searchQuery).toContain('body:ifiroumelioti')
	})

	/**
	 * The settle timer outlives the text that started it: clearing the box, or
	 * cutting it below the minimum length, must not leave a body search on its
	 * way for a term nobody is looking for.
	 */
	it('does not search bodies for a query that has since been cleared', async () => {
		const store = useMainStore()
		store.addAccountMutation(unifiedPseudoAccount)
		store.addAccountMutation(bodySearchOn)
		const wrapper = mountIn({ databaseId: 'priority', isPriorityInbox: true }, 0)
		wrapper.vm.query = 'ifiroumelioti'
		await wrapper.vm.$nextTick()

		wrapper.vm.query = ''
		await wrapper.vm.$nextTick()
		wrapper.vm.sendBodySearchEvent()

		expect(wrapper.vm.searchInMessageBody).toBe(null)
	})

	it('does not schedule a body search at all for an account that opted out', async () => {
		const store = useMainStore()
		store.addAccountMutation(bodySearchOff)
		const wrapper = mountIn({ databaseId: 22 }, 14)
		wrapper.vm.query = 'ifiroumelioti'
		await wrapper.vm.$nextTick()

		wrapper.vm.sendBodySearchEvent()

		expect(wrapper.vm.searchInMessageBody).toBe(null)
		expect(wrapper.vm.searchQuery).not.toContain('body:')
	})

	it('reads one account\'s own setting in that account\'s folder', () => {
		const store = useMainStore()
		store.addAccountMutation(bodySearchOn)
		store.addAccountMutation(bodySearchOff)

		expect(mountIn({ databaseId: 21 }, 13).vm.searchBody).toBe(true)
		expect(mountIn({ databaseId: 22 }, 14).vm.searchBody).toBe(false)
	})
})
