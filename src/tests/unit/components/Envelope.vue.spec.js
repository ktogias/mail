/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Envelope from '../../../components/Envelope.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'

const localVue = createLocalVue()
const $route = {
	params: {
		id: 1,
	},
}

const pinia = createPinia()

localVue.mixin(Nextcloud)

describe('Envelope', () => {
	let store

	beforeEach(() => {
		setActivePinia(createPinia())

		store = useMainStore()

		store.accountsUnmapped[123] = { sentMailboxId: '1' }
	})
	it('allows toggling seen flag without ACLs', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
				account: { sentMailboxId: '1' },
				mailbox: {
					myAcls: undefined,
					databaseId: '3',
					specialRole: '',
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasSeenAcl).toBe(true)
	})

	it('disallows toggling seen flag without s ACL right', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: 'x',
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			store,
			pinia,
			localVue,
		})

		expect(view.vm.hasSeenAcl).toBe(false)
	})

	it('allows toggling seen flag with s ACL right', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: 's',
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasSeenAcl).toBe(true)
	})
	it('allows toggling archive action without ACLs', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: undefined,
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			computed: {
				archiveMailbox() {
					return { myAcls: undefined }
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasArchiveAcl).toBe(true)
	})

	it('source mailbox has te and archive mailbox has i ACLs for archiving', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: 'te',
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			computed: {
				archiveMailbox() {
					return { myAcls: 'i' }
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasArchiveAcl).toBe(true)
	})

	it('source mailbox has te and archive mailbox has no ACLs for archiving', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: 'te',
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			computed: {
				archiveMailbox() {
					return { myAcls: undefined }
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasArchiveAcl).toBe(true)
	})

	it('source mailbox has no acls and archive mailbox has i ACL for archiving', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: undefined,
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			computed: {
				archiveMailbox() {
					return { myAcls: 'i' }
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasArchiveAcl).toBe(true)
	})

	it('disallows toggling archive action without i ACL right', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: 'x',
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasArchiveAcl).toBe(false)
	})

	it('allows toggling delete action without ACLs', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: undefined,
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },

				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasDeleteAcl).toBe(true)
	})
	it('disallows toggling delete action without x ACL right', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: 's',
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },

				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasDeleteAcl).toBe(false)
	})
	it('allows toggling delete action with te ACL right', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					sentMailboxId: '1',
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasDeleteAcl).toBe(true)
	})
	it('allows toggling favorite, important and spam action with w ACL right', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: 'w',
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasWriteAcl).toBe(true)
	})
	it('allows toggling favorite, important and spam action without w ACL right', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: 's',
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasWriteAcl).toBe(false)
	})
	it('allows toggling favorite, important and spam action without ACL right', () => {
		const view = shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: undefined,
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
				},
			},
			store,
			localVue,
		})

		expect(view.vm.hasWriteAcl).toBe(true)
	})

	describe('isThreadUnread', () => {
		const mountWithFlags = (flags) => shallowMount(Envelope, {
			mocks: {
				$route,
			},
			propsData: {
				mailbox: {
					specialRole: '',
					databaseId: '3',
					myAcls: undefined,
				},
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags,
				},
			},
			store,
			localVue,
		})

		it('is unread when the thread has an unseen message, even if this row itself is seen', () => {
			const view = mountWithFlags({ seen: true, hasUnseenInThread: true })

			expect(view.vm.isThreadUnread).toBe(true)
		})

		it('is read when the thread has no unseen message, even if this row itself is unseen', () => {
			// Not a realistic combination in practice (the row shown is
			// always the thread's newest message, which would itself be
			// among any unseen ones) -- but hasUnseenInThread must still
			// win over the row's own flag when both are present.
			const view = mountWithFlags({ seen: false, hasUnseenInThread: false })

			expect(view.vm.isThreadUnread).toBe(false)
		})

		it('falls back to the row-s own seen flag when hasUnseenInThread is absent', () => {
			const unseen = mountWithFlags({ seen: false })
			const seen = mountWithFlags({ seen: true })

			expect(unseen.vm.isThreadUnread).toBe(true)
			expect(seen.vm.isThreadUnread).toBe(false)
		})

		it('shows the unread dot for a thread with an unseen message even if this row itself is seen', () => {
			// Otherwise the row is bold (isThreadUnread drives the "seen"
			// CSS class) but missing its unread dot -- an inconsistent,
			// easy-to-miss half-state instead of looking like a normal
			// unread row.
			const view = mountWithFlags({ seen: true, hasUnseenInThread: true })

			expect(view.find('iconbullet-stub').exists()).toBe(true)
		})

		it('hides the unread dot once the thread has no unseen message', () => {
			const view = mountWithFlags({ seen: true, hasUnseenInThread: false })

			expect(view.find('iconbullet-stub').exists()).toBe(false)
		})
	})

	describe('hover prefetch', () => {
		// Gmail-style: start fetching a row's message+thread while the
		// pointer is still hovering, so the data is already there by the
		// time a deliberate click happens.
		beforeEach(() => {
			vi.useFakeTimers()
			store.fetchMessage = vi.fn().mockResolvedValue({})
			store.fetchThread = vi.fn().mockResolvedValue([])
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		function mountEnvelope(flagOverrides = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: {
						specialRole: '',
						databaseId: '3',
						myAcls: undefined,
					},
					data: {
						accountId: 123,
						databaseId: 999,
						from: [{ email: 'info@test.com' }],
						flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false, ...flagOverrides },
					},
				},
				store,
				localVue,
			})
		}

		it('prefetches the message and thread after hovering past the debounce delay', async () => {
			const view = mountEnvelope()

			view.vm.onEnvelopeMouseEnter()
			expect(store.fetchMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(200)

			expect(store.fetchMessage).toHaveBeenCalledWith(999)
			expect(store.fetchThread).toHaveBeenCalledWith(999)
		})

		it('does not prefetch when the pointer leaves before the delay elapses', async () => {
			const view = mountEnvelope()

			view.vm.onEnvelopeMouseEnter()
			view.vm.onEnvelopeMouseLeave()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('does not prefetch drafts, which open the composer instead of a thread', async () => {
			const view = mountEnvelope({ draft: true })

			view.vm.onEnvelopeMouseEnter()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})
	})
})
