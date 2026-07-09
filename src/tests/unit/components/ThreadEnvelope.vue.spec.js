/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ThreadEnvelope from '../../../components/ThreadEnvelope.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'

const localVue = createLocalVue()

localVue.mixin(Nextcloud)

describe('ThreadEnvelope', () => {
	beforeEach(() => {
		setActivePinia(createPinia())
	})

	it('allows toggling seen flag without ACLs', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: undefined }
				},
			},
			localVue,
		})

		expect(view.vm.hasSeenAcl).toBe(true)
	})

	it('disallows toggling seen flag without s ACL right', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: 'x' }
				},
			},
			localVue,
		})

		expect(view.vm.hasSeenAcl).toBe(false)
	})

	it('allows toggling seen flag with s ACL right', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: 's' }
				},
			},
			localVue,
		})

		expect(view.vm.hasSeenAcl).toBe(true)
	})
	it('allows toggling archive action without ACLs', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: undefined }
				},
				archiveMailbox() {
					return { myAcls: undefined }
				},
			},
			localVue,
		})

		expect(view.vm.hasArchiveAcl).toBe(true)
	})

	it('source mailbox has te and archive mailbox has i ACLs for archiving', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: 'te' }
				},
				archiveMailbox() {
					return { myAcls: 'i' }
				},
			},
			localVue,
		})

		expect(view.vm.hasArchiveAcl).toBe(true)
	})

	it('source mailbox has te and archive mailbox has no ACLs for archiving', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: 'te' }
				},
				archiveMailbox() {
					return { myAcls: undefined }
				},
			},
			localVue,
		})

		expect(view.vm.hasArchiveAcl).toBe(true)
	})

	it('source mailbox has no acls and archive mailbox has i ACL for archiving', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: undefined }
				},
				archiveMailbox() {
					return { }
				},
			},
			localVue,
		})

		expect(view.vm.hasArchiveAcl).toBe(true)
	})

	it('disallows toggling archive action without w ACL right', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: 'x' }
				},
			},
			localVue,
		})

		expect(view.vm.hasArchiveAcl).toBe(false)
	})

	it('allows toggling delete action without ACLs', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,

				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: undefined }
				},
			},
			localVue,
		})

		expect(view.vm.hasDeleteAcl).toBe(true)
	})
	it('disallows toggling delete action without x ACL right', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: 's' }
				},
			},
			localVue,
		})

		expect(view.vm.hasDeleteAcl).toBe(false)
	})
	it('allows toggling delete action with te ACL right', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: 'te' }
				},
			},
			localVue,
		})

		expect(view.vm.hasDeleteAcl).toBe(true)
	})
	it('allows toggling favorite, important and spam action with w ACL right', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: {
						seen: false,
						flagged: false,
						$junk: false,
						answered: false,
						hasAttachments: false,
						draft: false,
					},
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: 'w' }
				},
			},
			localVue,
		})

		expect(view.vm.hasWriteAcl).toBe(true)
	})

	it('allows toggling favorite, important and spam action without w ACL right', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: {
						seen: false,
						flagged: false,
						$junk: false,
						answered: false,
						hasAttachments: false,
						draft: false,
					},
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: 's' }
				},
				archiveMailbox() {
					return { }
				},
			},
			localVue,
		})

		expect(view.vm.hasWriteAcl).toBe(false)
	})
	it('allows toggling favorite, important and spam action without ACL right', () => {
		const view = shallowMount(ThreadEnvelope, {
			propsData: {
				account: {},
				mailbox: {
					specialRole: '',
				},
				envelope: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: {
						seen: false,
						flagged: false,
						$junk: false,
						answered: false,
						hasAttachments: false,
						draft: false,
					},
					subject: '',
					dateInt: 1692200926180,
				},
				threadSubject: '',
			},
			computed: {
				mailbox() {
					return { myAcls: undefined }
				},
				archiveMailbox() {
					return { }
				},
			},
			localVue,
		})

		expect(view.vm.hasWriteAcl).toBe(true)
	})

	describe('hover prefetch', () => {
		// Same idea as Envelope.vue's row-level prefetch, for a collapsed
		// message within an already-open thread: start fetching its body
		// while the pointer hovers the (still collapsed) header, so it's
		// already there once the user actually clicks to expand it.
		let store

		beforeEach(() => {
			vi.useFakeTimers()
			store = useMainStore()
			store.getAccount = vi.fn().mockReturnValue({ name: 'Test', emailAddress: 'test@test.com' })
			// A fuller shape than the other tests in this file need:
			// mounting with expanded=true (for the "already expanded"
			// case) drives mounted()'s own fetchMessage(), whose
			// follow-up itineraries/dkim checks read these fields.
			store.fetchMessage = vi.fn().mockResolvedValue({
				databaseId: 999,
				hasHtmlBody: false,
				attachments: [],
				dkimValid: true,
				itineraries: [],
			})
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		function mountThreadEnvelope(expanded = false) {
			return shallowMount(ThreadEnvelope, {
				propsData: {
					account: {},
					mailbox: {
						specialRole: '',
					},
					envelope: {
						accountId: 123,
						databaseId: 999,
						from: [{ email: 'info@test.com' }],
						to: [],
						cc: [],
						flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
						subject: '',
						dateInt: 1692200926180,
					},
					threadSubject: '',
					expanded,
				},
				computed: {
					mailbox() {
						return { myAcls: undefined }
					},
					archiveMailbox() {
						return { myAcls: undefined }
					},
				},
				localVue,
			})
		}

		it('prefetches the collapsed message after hovering past the debounce delay', async () => {
			const view = mountThreadEnvelope(false)

			view.vm.onEnvelopeMouseEnter()
			expect(store.fetchMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(200)

			expect(store.fetchMessage).toHaveBeenCalledWith(999)
		})

		it('does not prefetch when the pointer leaves before the delay elapses', async () => {
			const view = mountThreadEnvelope(false)

			view.vm.onEnvelopeMouseEnter()
			view.vm.onEnvelopeMouseLeave()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('does not additionally prefetch an already-expanded message', async () => {
			// mounted() already calls fetchMessage() on its own for an
			// envelope that starts out expanded -- the hover handler must
			// not add a second, redundant call on top of that.
			const view = mountThreadEnvelope(true)
			await vi.advanceTimersByTimeAsync(0)
			const callsAfterMount = store.fetchMessage.mock.calls.length
			expect(callsAfterMount).toBeGreaterThan(0)

			view.vm.onEnvelopeMouseEnter()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).toHaveBeenCalledTimes(callsAfterMount)
		})
	})
})
