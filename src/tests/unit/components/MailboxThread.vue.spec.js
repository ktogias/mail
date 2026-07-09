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

	it("shows the 'Other' section once it actually has envelopes, even if Important is empty", () => {
		seedEnvelope(priorityOtherQuery, 2)
		// priorityImportantQuery deliberately left empty

		const wrapper = mountThread()

		const otherTitle = wrapper.find('.section-title.other')
		const otherMailbox = wrapper.find('.nameother')

		expect(otherTitle.isVisible()).toBe(true)
		expect(otherMailbox.isVisible()).toBe(true)
	})
})
