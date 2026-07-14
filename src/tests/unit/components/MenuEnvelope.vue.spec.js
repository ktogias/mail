/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import MenuEnvelope from '../../../components/MenuEnvelope.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

describe('MenuEnvelope', () => {
	let store

	beforeEach(() => {
		setActivePinia(createPinia())
		store = useMainStore()
		store.getAccount = vi.fn().mockReturnValue({ databaseId: 4, snoozeMailboxId: null, archiveMailboxId: null })
	})

	describe('onToggleJunk() requests it from Thread.vue (via ThreadEnvelope.vue), for a shared undo window', () => {
		// This is the only entry point of the four historical
		// onToggleJunk() implementations with no important/seen side
		// effects -- preserved exactly; only the deferred store calls
		// moved up to Thread.vue.
		function mountMenuEnvelope() {
			return shallowMount(MenuEnvelope, {
				propsData: {
					envelope: {
						databaseId: 999,
						accountId: 123,
						flags: { seen: false, flagged: false, $junk: false },
					},
					mailbox: { specialRole: '', databaseId: 42, myAcls: undefined },
				},
				store,
				localVue,
			})
		}

		it('emits delete first, then request-toggle-junk-one, when the envelope will actually move', async () => {
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(true)
			const view = mountMenuEnvelope()

			view.vm.onToggleJunk()
			await vi.waitFor(() => expect(view.emitted()['request-toggle-junk-one']).toBeTruthy())

			expect(view.emitted().delete[0]).toEqual([999])
			expect(view.emitted()['request-toggle-junk-one'][0]).toEqual([{
				envelope: view.vm.envelope,
				removeEnvelope: true,
				isImportant: false,
			}])
		})

		it('does not emit delete when the envelope stays in the current view', async () => {
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(false)
			const view = mountMenuEnvelope()

			view.vm.onToggleJunk()
			await vi.waitFor(() => expect(view.emitted()['request-toggle-junk-one']).toBeTruthy())

			expect(view.emitted().delete).toBeFalsy()
		})

		it('never calls toggleEnvelopeJunk itself -- that is Thread.vue\'s job now', async () => {
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(true)
			store.toggleEnvelopeJunk = vi.fn()
			const view = mountMenuEnvelope()

			view.vm.onToggleJunk()
			await vi.waitFor(() => expect(view.emitted()['request-toggle-junk-one']).toBeTruthy())

			expect(store.toggleEnvelopeJunk).not.toHaveBeenCalled()
		})
	})

	describe('onSnooze() requests it from Thread.vue (via ThreadEnvelope.vue), for a shared undo window', () => {
		function mountMenuEnvelope() {
			return shallowMount(MenuEnvelope, {
				propsData: {
					envelope: {
						databaseId: 999,
						accountId: 123,
						flags: { seen: false, flagged: false, $junk: false },
					},
					mailbox: { specialRole: '', databaseId: 42, myAcls: undefined },
				},
				store,
				localVue,
			})
		}

		it('creates the snooze mailbox first if the account does not have one yet, then emits request-snooze', async () => {
			const account = { databaseId: 4, snoozeMailboxId: null, archiveMailboxId: null }
			store.getAccount = vi.fn().mockReturnValue(account)
			store.createAndSetSnoozeMailbox = vi.fn().mockImplementation(async (acc) => {
				acc.snoozeMailboxId = 88
			})
			store.snoozeMessage = vi.fn()
			const view = mountMenuEnvelope()

			await view.vm.onSnooze(1700000000000)

			expect(store.createAndSetSnoozeMailbox).toHaveBeenCalled()
			expect(view.emitted()['request-snooze'][0]).toEqual([{
				envelope: view.vm.envelope,
				isThreaded: false,
				unixTimestamp: 1700000000,
				destMailboxId: 88,
			}])
			expect(store.snoozeMessage).not.toHaveBeenCalled()
		})

		it('never calls snoozeMessage itself -- that is Thread.vue\'s job now', async () => {
			store.getAccount = vi.fn().mockReturnValue({ databaseId: 4, snoozeMailboxId: 88, archiveMailboxId: null })
			store.snoozeMessage = vi.fn()
			const view = mountMenuEnvelope()

			await view.vm.onSnooze(1700000000000)

			expect(store.snoozeMessage).not.toHaveBeenCalled()
		})
	})
})
