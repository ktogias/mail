/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import NewMessageButtonHeader from '../../../components/NewMessageButtonHeader.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import { WorkClass } from '../../../service/RequestCoordinator.js'
import { PRIORITY_INBOX_ID } from '../../../store/constants.js'
import useMainStore from '../../../store/mainStore.js'

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

describe('NewMessageButtonHeader', () => {
	it('uses the single exact Priority refresh instead of the legacy two-bucket fan-out', async () => {
		setActivePinia(createPinia())
		const store = useMainStore()
		store.refreshPriorityInboxView = vi.fn().mockResolvedValue({})
		store.syncEnvelopes = vi.fn().mockResolvedValue([])
		store.syncMailboxesForAccount = vi.fn().mockResolvedValue()
		const wrapper = shallowMount(NewMessageButtonHeader, {
			store,
			localVue,
			mocks: {
				$route: {
					name: 'mailbox',
					params: { mailboxId: PRIORITY_INBOX_ID },
				},
			},
		})

		await wrapper.vm.refreshMailbox()

		expect(store.refreshPriorityInboxView).toHaveBeenCalledWith({
			workClass: WorkClass.EXPLICIT_HEAVY,
			syncSources: true,
		})
		expect(store.syncEnvelopes).not.toHaveBeenCalled()
		expect(store.syncMailboxesForAccount).toHaveBeenCalledTimes(1)

		wrapper.destroy()
	})
})
