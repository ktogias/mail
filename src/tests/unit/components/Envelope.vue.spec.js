/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Envelope from '../../../components/Envelope.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'
import * as ScrollActivityTracker from '../../../util/scrollActivityTracker.js'
import * as ViewportPrefetchObserver from '../../../util/viewportPrefetchObserver.js'

vi.mock('../../../util/scrollActivityTracker.js')
vi.mock('../../../util/viewportPrefetchObserver.js')

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

	describe('onClick records which list this row belongs to', () => {
		// Thread.vue::prefetchListNeighborhood() reads
		// mainStore.lastOpenedFromList instead of trying to reconstruct
		// "the list" from route params -- several lists (Priority Inbox's
		// Favorites/Important/Other, a Favorites sub-list inside a
		// regular folder, the unified inbox's merge, any search/filter)
		// can share the same route, so only the actual click -- which
		// unambiguously knows its own mailbox/searchQuery props -- can
		// record this correctly.
		function mountEnvelope(propsOverride = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: { specialRole: '', databaseId: 42, myAcls: undefined },
					searchQuery: 'is:starred',
					data: {
						accountId: 123,
						databaseId: 999,
						from: [{ email: 'info@test.com' }],
						flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					},
					...propsOverride,
				},
				store,
				localVue,
			})
		}

		it('records the mailbox and search query on a plain click', async () => {
			const view = mountEnvelope()

			await view.vm.onClick({})

			expect(store.lastOpenedFromList).toEqual({ mailboxId: 42, query: 'is:starred' })
		})

		it('does not record anything for a draft (opens the composer instead)', async () => {
			store.startComposerSession = vi.fn().mockResolvedValue({})
			const view = mountEnvelope({
				data: {
					accountId: 123,
					databaseId: 999,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: true },
				},
			})

			await view.vm.onClick({})

			expect(store.lastOpenedFromList).toBeNull()
		})
	})

	describe('onDelete() delegates the actual deletion to EnvelopeList, for a shared undo window', () => {
		// EnvelopeList.vue owns the undo-toast bookkeeping (a single
		// click here should behave exactly like a bulk delete of one
		// message) -- this component's own job is just to say "the user
		// asked to delete this", not to call the store directly anymore.
		function mountEnvelope(propsOverride = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: { specialRole: '', databaseId: 42, myAcls: undefined },
					data: {
						accountId: 123,
						databaseId: 999,
						from: [{ email: 'info@test.com' }],
						flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					},
					...propsOverride,
				},
				store,
				localVue,
			})
		}

		it('emits both delete (for navigation) and request-delete (for the actual deferred deletion), threaded by default', () => {
			const view = mountEnvelope()

			view.vm.onDelete()

			expect(view.emitted().delete[0]).toEqual([999])
			expect(view.emitted()['request-delete'][0]).toEqual([{ envelope: view.vm.data, isThreaded: true }])
		})

		it('flags the request as non-threaded when the threaded layout preference is off', () => {
			store.preferences = { 'layout-message-view': 'flat' }
			const view = mountEnvelope()

			view.vm.onDelete()

			expect(view.emitted()['request-delete'][0]).toEqual([{ envelope: view.vm.data, isThreaded: false }])
		})

		it('never calls deleteThread/deleteMessage itself -- that is EnvelopeList.vue\'s job now', () => {
			store.deleteThread = vi.fn()
			store.deleteMessage = vi.fn()
			const view = mountEnvelope()

			view.vm.onDelete()

			expect(store.deleteThread).not.toHaveBeenCalled()
			expect(store.deleteMessage).not.toHaveBeenCalled()
		})
	})

	describe('onSnooze() requests it from EnvelopeList, for a shared undo window', () => {
		function mountEnvelope(propsOverride = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: { specialRole: '', databaseId: 42, myAcls: undefined },
					data: {
						accountId: 123,
						databaseId: 999,
						from: [{ email: 'info@test.com' }],
						to: [],
						cc: [],
						attachments: [],
						subject: '',
						dateInt: 1692200926180,
						flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					},
					...propsOverride,
				},
				store,
				localVue,
			})
		}

		it('creates the snooze mailbox first if the account does not have one yet, then emits request-snooze', async () => {
			store.accountsUnmapped[123].snoozeMailboxId = null
			store.createAndSetSnoozeMailbox = vi.fn().mockImplementation(async (account) => {
				account.snoozeMailboxId = 88
			})
			store.snoozeMessage = vi.fn()
			const view = mountEnvelope()

			await view.vm.onSnooze(1700000000000)

			expect(store.createAndSetSnoozeMailbox).toHaveBeenCalled()
			expect(view.emitted()['request-snooze'][0]).toEqual([{
				envelope: view.vm.data,
				isThreaded: true,
				unixTimestamp: 1700000000,
				destMailboxId: 88,
			}])
			expect(store.snoozeMessage).not.toHaveBeenCalled()
		})

		it('does not try to create a snooze mailbox that already exists', async () => {
			store.accountsUnmapped[123].snoozeMailboxId = 88
			store.createAndSetSnoozeMailbox = vi.fn()
			const view = mountEnvelope()

			await view.vm.onSnooze(1700000000000)

			expect(store.createAndSetSnoozeMailbox).not.toHaveBeenCalled()
			expect(view.emitted()['request-snooze'][0][0].destMailboxId).toBe(88)
		})

		it('never calls snoozeThread/snoozeMessage itself -- that is EnvelopeList.vue\'s job now', async () => {
			store.accountsUnmapped[123].snoozeMailboxId = 88
			store.snoozeThread = vi.fn()
			store.snoozeMessage = vi.fn()
			const view = mountEnvelope()

			await view.vm.onSnooze(1700000000000)

			expect(store.snoozeThread).not.toHaveBeenCalled()
			expect(store.snoozeMessage).not.toHaveBeenCalled()
		})
	})

	describe('onArchive()/moveThread() request them from EnvelopeList, for a shared undo window', () => {
		beforeEach(() => {
			// archiveMailbox (used by the template's hasArchiveAcl, which
			// re-evaluates on the next tick after these methods emit)
			// resolves via mainStore.getMailbox(account.archiveMailboxId)
			// -- with no archiveMailboxId set on the fixture account,
			// that's undefined, and mailboxHasRights() doesn't handle a
			// missing mailbox object at all. Populating real store state
			// (not just mocking the getter) since the crash happens on a
			// deferred re-render, not synchronously within the method
			// call itself.
			store.accountsUnmapped[123].archiveMailboxId = 1
			store.mailboxes[1] = { myAcls: undefined }
		})

		function mountEnvelope(propsOverride = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: { specialRole: '', databaseId: 42, myAcls: undefined },
					data: {
						accountId: 123,
						databaseId: 999,
						from: [{ email: 'info@test.com' }],
						to: [],
						cc: [],
						attachments: [],
						subject: '',
						dateInt: 1692200926180,
						flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: false },
					},
					...propsOverride,
				},
				store,
				localVue,
			})
		}

		it('onArchive() emits archive (for navigation) and request-archive (for the actual deferred move), never calling the store itself', () => {
			store.moveThread = vi.fn()
			store.moveMessage = vi.fn()
			const view = mountEnvelope()

			view.vm.onArchive()

			expect(view.emitted().archive[0]).toEqual([999])
			expect(view.emitted()['request-archive'][0]).toEqual([{ envelope: view.vm.data, isThreaded: true }])
			expect(store.moveThread).not.toHaveBeenCalled()
			expect(store.moveMessage).not.toHaveBeenCalled()
		})

		it('moveThread() (the quick-actions "move to X" step) emits request-move with the chosen destination, never calling the store itself', () => {
			store.moveThread = vi.fn()
			store.moveMessage = vi.fn()
			const view = mountEnvelope()

			view.vm.moveThread(77)

			expect(view.emitted()['request-move'][0]).toEqual([{ envelopes: [view.vm.data], destMailboxId: 77, moveThread: true }])
			expect(view.emitted().move).toBeTruthy()
			expect(store.moveThread).not.toHaveBeenCalled()
			expect(store.moveMessage).not.toHaveBeenCalled()
		})
	})

	describe('onToggleJunk()/onToggleJunkThread() request them from EnvelopeList, for a shared undo window', () => {
		// Real fix history in this exact area: marking a message as spam
		// used to never actually move it (confirmed live, it reappeared
		// after every refresh) -- moveEnvelopeToJunk()'s eager resolution
		// and the delete-emit-before-store-mutation ordering are
		// preserved exactly as before; only the deferred store calls
		// themselves moved to EnvelopeList.vue.
		function mountEnvelope(flagOverrides = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: { specialRole: '', databaseId: 42, myAcls: undefined },
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

		beforeEach(() => {
			store.getEnvelopeTags = vi.fn().mockReturnValue([])
		})

		it('onToggleJunk() emits delete first, then request-toggle-junk-one, when the envelope will actually move', async () => {
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(true)
			const view = mountEnvelope()

			view.vm.onToggleJunk()
			await vi.waitFor(() => expect(view.emitted()['request-toggle-junk-one']).toBeTruthy())

			expect(view.emitted().delete[0]).toEqual([999])
			expect(view.emitted()['request-toggle-junk-one'][0]).toEqual([{
				envelope: view.vm.data,
				removeEnvelope: true,
				isImportant: false,
			}])
		})

		it('onToggleJunk() does not emit delete when the envelope stays in the current view', async () => {
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(false)
			const view = mountEnvelope()

			view.vm.onToggleJunk()
			await vi.waitFor(() => expect(view.emitted()['request-toggle-junk-one']).toBeTruthy())

			expect(view.emitted().delete).toBeFalsy()
			expect(view.emitted()['request-toggle-junk-one'][0][0].removeEnvelope).toBe(false)
		})

		it('onToggleJunk() reports isImportant so EnvelopeList can defer clearing it too', async () => {
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(false)
			store.getEnvelopeTags = vi.fn().mockReturnValue([{ imapLabel: '$label1' }])
			const view = mountEnvelope()

			view.vm.onToggleJunk()
			await vi.waitFor(() => expect(view.emitted()['request-toggle-junk-one']).toBeTruthy())

			expect(view.emitted()['request-toggle-junk-one'][0][0].isImportant).toBe(true)
		})

		it('never calls toggleEnvelopeJunk itself -- that is EnvelopeList.vue\'s job now', async () => {
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(true)
			store.toggleEnvelopeJunk = vi.fn()
			const view = mountEnvelope()

			view.vm.onToggleJunk()
			await vi.waitFor(() => expect(view.emitted()['request-toggle-junk-one']).toBeTruthy())

			expect(store.toggleEnvelopeJunk).not.toHaveBeenCalled()
		})

		it('onToggleJunkThread() emits request-toggle-junk-thread with every envelope in the thread', async () => {
			store.moveEnvelopeToJunk = vi.fn().mockResolvedValue(true)
			store.preferences = { 'layout-message-view': 'threaded' }
			const threadEnvelopes = [{ databaseId: 999, flags: {} }, { databaseId: 1000, flags: {} }]
			store.getEnvelopesByThreadRootId = vi.fn().mockReturnValue(threadEnvelopes)
			const view = mountEnvelope()

			await view.vm.onToggleJunkThread()

			expect(view.emitted().delete).toEqual([[threadEnvelopes[0]], [threadEnvelopes[1]]])
			expect(view.emitted()['request-toggle-junk-thread'][0]).toEqual([{
				envelopes: threadEnvelopes,
				removeEnvelope: true,
				isImportant: false,
			}])
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
			ScrollActivityTracker.isScrollingRecently.mockReturnValue(false)
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

		it('prefetches the message and thread after pointer movement settles past the debounce delay', async () => {
			const view = mountEnvelope()

			view.vm.onEnvelopeMouseMove()
			expect(store.fetchMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(200)

			expect(store.fetchMessage).toHaveBeenCalledWith(999, { speculative: true })
			expect(store.fetchThread).toHaveBeenCalledWith(999, { speculative: true })
		})

		it('does not prefetch when the pointer leaves before the delay elapses', async () => {
			const view = mountEnvelope()

			view.vm.onEnvelopeMouseMove()
			view.vm.onEnvelopeMouseLeave()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('does not prefetch drafts, which open the composer instead of a thread', async () => {
			const view = mountEnvelope({ draft: true })

			view.vm.onEnvelopeMouseMove()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('does not prefetch when scrolling moves a row under a stationary pointer', async () => {
			const view = mountEnvelope()

			await view.trigger('mouseenter')
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
			expect(store.fetchThread).not.toHaveBeenCalled()
		})

		it('does not arm the hover timer while the list is scrolling', async () => {
			ScrollActivityTracker.isScrollingRecently.mockReturnValue(true)
			const view = mountEnvelope()

			view.vm.onEnvelopeMouseMove()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('cancels an already-ticking hover timer the moment scrolling starts', async () => {
			const view = mountEnvelope()
			view.vm.onEnvelopeMouseMove()

			ScrollActivityTracker.isScrollingRecently.mockReturnValue(true)
			view.vm.onEnvelopeMouseMove()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('does not arm the touchstart timer while the list is scrolling', async () => {
			ScrollActivityTracker.isScrollingRecently.mockReturnValue(true)
			const view = mountEnvelope()

			view.vm.onEnvelopeTouchStart()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('prefetches on touchstart past the (shorter) touch delay', async () => {
			// Mouse hover never gets a head start on touch devices -- a
			// tap's own touchstart-to-navigation window is itself only
			// ~100-150ms, so touchstart needs its own much shorter delay.
			const view = mountEnvelope()

			view.vm.onEnvelopeTouchStart()
			expect(store.fetchMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(60)

			expect(store.fetchMessage).toHaveBeenCalledWith(999, { speculative: true })
			expect(store.fetchThread).toHaveBeenCalledWith(999, { speculative: true })
		})

		it('does not prefetch when touchmove happens before the delay elapses', async () => {
			// A touchmove means this touch became a scroll, not a tap --
			// same reasoning as mouseleave cancelling the hover timer.
			const view = mountEnvelope()

			view.vm.onEnvelopeTouchStart()
			view.vm.cancelHoverPrefetch()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('does not prefetch drafts on touchstart either', async () => {
			const view = mountEnvelope({ draft: true })

			view.vm.onEnvelopeTouchStart()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})
	})

	describe('mailbox-row viewport behavior', () => {
		beforeEach(() => {
			vi.useFakeTimers()
			vi.clearAllMocks()
			store.fetchMessage = vi.fn().mockResolvedValue({})
			store.fetchThread = vi.fn().mockResolvedValue([])
			ViewportPrefetchObserver.runIfViewportPrefetchSlotAvailable.mockImplementation((fn) => fn())
			ScrollActivityTracker.isScrollingRecently.mockReturnValue(false)
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		function mountMailboxRow(flagOverrides = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: { specialRole: '', databaseId: '3', myAcls: undefined },
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

		it('registers its own element for viewport visibility on mount', () => {
			const view = mountMailboxRow()

			expect(ViewportPrefetchObserver.observeViewportVisibility).toHaveBeenCalledWith(view.vm.$el, expect.any(Function))
		})

		it('does not register a draft -- it opens the composer, not a thread', () => {
			mountMailboxRow({ draft: true })

			expect(ViewportPrefetchObserver.observeViewportVisibility).not.toHaveBeenCalled()
		})

		it('prefetches the message and thread once continuously visible past the settle delay', async () => {
			mountMailboxRow()
			const onIntersect = ViewportPrefetchObserver.observeViewportVisibility.mock.calls[0][1]

			onIntersect(true)
			expect(store.fetchMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(300)

			expect(store.fetchMessage).toHaveBeenCalledWith(999, { speculative: true })
			expect(store.fetchThread).toHaveBeenCalledWith(999, { speculative: true })
		})

		it('does not prefetch if the row leaves the viewport before the settle delay elapses', async () => {
			mountMailboxRow()
			const onIntersect = ViewportPrefetchObserver.observeViewportVisibility.mock.calls[0][1]

			onIntersect(true)
			onIntersect(false)
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('keeps waiting instead of firing while the list is still being scrolled, even once continuously visible past the settle delay', async () => {
			ScrollActivityTracker.isScrollingRecently.mockReturnValue(true)
			mountMailboxRow()
			const onIntersect = ViewportPrefetchObserver.observeViewportVisibility.mock.calls[0][1]

			onIntersect(true)
			await vi.advanceTimersByTimeAsync(300)
			expect(store.fetchMessage).not.toHaveBeenCalled()

			// Scrolling stops -- the next re-check (still gated by the same
			// settle delay) fires normally.
			ScrollActivityTracker.isScrollingRecently.mockReturnValue(false)
			await vi.advanceTimersByTimeAsync(300)

			expect(store.fetchMessage).toHaveBeenCalledWith(999, { speculative: true })
		})

		it('gives up the retry loop for good once the row scrolls out of view while still waiting on scroll to settle', async () => {
			ScrollActivityTracker.isScrollingRecently.mockReturnValue(true)
			mountMailboxRow()
			const onIntersect = ViewportPrefetchObserver.observeViewportVisibility.mock.calls[0][1]

			onIntersect(true)
			await vi.advanceTimersByTimeAsync(300)
			onIntersect(false)

			ScrollActivityTracker.isScrollingRecently.mockReturnValue(false)
			await vi.advanceTimersByTimeAsync(1000)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('removes the exact global resize listener when the row is destroyed', () => {
			const addSpy = vi.spyOn(window, 'addEventListener')
			const removeSpy = vi.spyOn(window, 'removeEventListener')
			const view = mountMailboxRow()
			const resizeListener = addSpy.mock.calls.find(([event]) => event === 'resize')[1]

			view.destroy()

			expect(removeSpy).toHaveBeenCalledWith('resize', resizeListener)
			addSpy.mockRestore()
			removeSpy.mockRestore()
		})

		it('unobserves its element on destroy', () => {
			const view = mountMailboxRow()
			const el = view.vm.$el

			view.destroy()

			expect(ViewportPrefetchObserver.unobserveViewportVisibility).toHaveBeenCalledWith(el)
		})
	})
})
