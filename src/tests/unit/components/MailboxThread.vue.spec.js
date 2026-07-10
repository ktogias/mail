/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import MailboxThread from '../../../components/MailboxThread.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import { PRIORITY_INBOX_ID, UNIFIED_INBOX_ID } from '../../../store/constants.js'
import useMainStore from '../../../store/mainStore.js'
import { priorityImportantQuery, priorityOtherQuery } from '../../../util/priorityInbox.js'

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

describe('MailboxThread', () => {
	let store

	beforeEach(() => {
		setActivePinia(createPinia())
		store = useMainStore()
	})

	function seedEnvelope(query, id) {
		store.envelopes[id] = { databaseId: id, dateInt: id }
		store.mailboxes[UNIFIED_INBOX_ID].envelopeLists[query] = [id]
	}

	function mountThread() {
		return shallowMount(MailboxThread, {
			propsData: {
				account: store.accountsUnmapped[0],
				mailbox: store.mailboxes[PRIORITY_INBOX_ID],
			},
			store,
			localVue,
			mocks: {
				$route: { params: {} },
			},
			stubs: {
				AppContent: { template: '<div><slot name="list" /><slot /></div>' },
				AppContentList: { template: '<div><slot /></div>' },
			},
		})
	}

	it("gates the 'Other' section on its own envelopes, not the 'Important' section's", () => {
		// Regression: the 'Other' SectionTitle/Mailbox were wired to
		// v-show="hasImportantEnvelopes" (a copy-paste of the section
		// above), so an empty Important section hid Other's own title
		// while Other's Mailbox (which had no v-show at all) kept
		// rendering underneath whatever the previous visible section
		// was -- no divider between them, both animating as a single
		// transition-group batch. Confirmed live as permanently
		// overlapping envelope rows in the priority inbox.
		seedEnvelope(priorityImportantQuery, 1)
		// priorityOtherQuery deliberately left empty

		const wrapper = mountThread()

		const otherTitle = wrapper.find('.section-title.other')
		const otherMailbox = wrapper.find('.nameother')

		expect(otherTitle.isVisible()).toBe(false)
		expect(otherMailbox.isVisible()).toBe(false)
	})

	describe('appendToSearch', () => {
		// followUpQuery is undefined when no follow-up tag exists on the
		// instance -- concatenating it produced the literal string
		// "... undefined", which the backend treats as a free-text search
		// term and answers with its heaviest query (threaded self-join +
		// two recipients JOINs + ILIKE '%undefined%'). Confirmed live as
		// 16 concurrent copies each running 38-51 minutes on a
		// 27k-message INBOX, starving every other request.
		it('never concatenates an undefined query into the search string', () => {
			const wrapper = mountThread()

			wrapper.setData({ searchQuery: 'mentions:false match:allof' })

			expect(wrapper.vm.appendToSearch(undefined)).toBe('mentions:false match:allof')
			expect(wrapper.vm.appendToSearch(null)).toBe('mentions:false match:allof')
		})

		it('returns the plain string when there is no active search', () => {
			const wrapper = mountThread()

			expect(wrapper.vm.appendToSearch('is:starred')).toBe('is:starred')
			expect(wrapper.vm.appendToSearch(undefined)).toBeUndefined()
		})

		it('mounts the follow-up section only when a follow-up tag actually exists', () => {
			// v-show alone only hides it visually -- the Mailbox still
			// mounted and fetched, previously with the poisoned
			// "... undefined" query.
			const withoutTag = mountThread()
			expect(withoutTag.vm.followUpQuery).toBeUndefined()
			const mailboxCountWithoutTag = withoutTag.findAll('mailbox-stub').length

			store.tags = { 77: { id: 77, imapLabel: '$follow_up', displayName: 'Follow up' } }
			const withTag = mountThread()
			expect(withTag.vm.followUpQuery).toBeTruthy()

			expect(withTag.findAll('mailbox-stub').length).toBe(mailboxCountWithoutTag + 1)
		})
	})

	it("shows the 'Other' section once it actually has envelopes, even if Important is empty", () => {
		seedEnvelope(priorityOtherQuery, 2)
		// priorityImportantQuery deliberately left empty

		const wrapper = mountThread()

		const otherTitle = wrapper.find('.section-title.other')
		const otherMailbox = wrapper.find('.nameother')

		expect(otherTitle.isVisible()).toBe(true)
		expect(otherMailbox.isVisible()).toBe(true)
	})

	it("applies the sort-favorites 'not:starred' filter before any child Mailbox mounts", () => {
		// Vue mounts children bottom-up (child created+mounted, THEN
		// parent mounted()) -- setting searchQuery in mounted() meant
		// every child's own first fetch always ran with the stale,
		// unfiltered query, immediately superseded by a second, corrected
		// fetch once this component's mounted() ran and the prop change
		// hit the child's own watcher (confirmed live via HAR: every
		// priority section's initial request aborted and re-issued with
		// not:starred added, on every single page load with this setting
		// on). Setting it in created() -- which the Vue lifecycle
		// guarantees runs before any child's created/mounted -- means the
		// prop passed to children is already correct on their first read.
		store.savePreferenceMutation({ key: 'sort-favorites', value: 'true' })

		const wrapper = mountThread()

		expect(wrapper.vm.searchQuery).toBe('not:starred')
	})
})
