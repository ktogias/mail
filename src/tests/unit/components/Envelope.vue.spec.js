/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Envelope from '../../../components/Envelope.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'
import { isCoarsePointer } from '../../../util/pointerType.js'
import * as ScrollActivityTracker from '../../../util/scrollActivityTracker.js'
import * as ViewportPrefetchObserver from '../../../util/viewportPrefetchObserver.js'

vi.mock('../../../util/scrollActivityTracker.js')
vi.mock('../../../util/viewportPrefetchObserver.js')
vi.mock('../../../util/pointerType.js', () => ({
	isCoarsePointer: vi.fn(() => false),
}))

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

			expect(store.lastOpenedFromList).toEqual({ mailboxId: 42, query: 'is:starred', databaseId: 999 })
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

	describe('onClick: selection-mode and long-press interception (mobile tap ambiguity fix)', () => {
		function mountEnvelope(propsOverride = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: { specialRole: '', databaseId: 42, myAcls: undefined },
					searchQuery: 'is:starred',
					selectMode: false,
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

		it('toggles selection instead of navigating when selectMode is true', async () => {
			const view = mountEnvelope({ selectMode: true })
			const event = { preventDefault: vi.fn() }

			await view.vm.onClick(event)

			expect(event.preventDefault).toHaveBeenCalled()
			expect(view.emitted('update:selected')).toEqual([[true]])
			// Did not fall through to the normal open-and-record path.
			expect(store.lastOpenedFromList).toBeNull()
		})

		it('opens normally (records list context) when selectMode is false', async () => {
			const view = mountEnvelope({ selectMode: false })

			await view.vm.onClick({})

			expect(store.lastOpenedFromList).toEqual({ mailboxId: 42, query: 'is:starred', databaseId: 999 })
		})

		it('swallows exactly one click after a long-press, then resumes normal behavior', async () => {
			const view = mountEnvelope()
			await view.setData({ suppressNextClickAfterLongPress: true })
			const suppressedEvent = { preventDefault: vi.fn() }

			await view.vm.onClick(suppressedEvent)

			expect(suppressedEvent.preventDefault).toHaveBeenCalled()
			expect(store.lastOpenedFromList).toBeNull()
			expect(view.vm.suppressNextClickAfterLongPress).toBe(false)

			// The flag only swallows the one synthesized click -- the next
			// real click behaves normally again.
			await view.vm.onClick({})

			expect(store.lastOpenedFromList).toEqual({ mailboxId: 42, query: 'is:starred', databaseId: 999 })
		})
	})

	describe('long-press-to-select (mobile tap ambiguity fix)', () => {
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

		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('toggles selection and arms the click-suppress flag after a 500ms hold with no movement', () => {
			const view = mountEnvelope()
			const touchEvent = { touches: [{ clientX: 100, clientY: 100 }] }

			view.vm.onEnvelopeTouchStart(touchEvent)
			vi.advanceTimersByTime(500)

			expect(view.emitted('update:selected')).toEqual([[true]])
			expect(view.vm.suppressNextClickAfterLongPress).toBe(true)
		})

		it('does not fire before 500ms elapses', () => {
			const view = mountEnvelope()
			const touchEvent = { touches: [{ clientX: 100, clientY: 100 }] }

			view.vm.onEnvelopeTouchStart(touchEvent)
			vi.advanceTimersByTime(499)

			expect(view.emitted('update:selected')).toBeUndefined()
		})

		it('is cancelled by a touchmove past the movement tolerance', () => {
			const view = mountEnvelope()
			view.vm.onEnvelopeTouchStart({ touches: [{ clientX: 100, clientY: 100 }] })

			view.vm.onEnvelopeTouchMove({ touches: [{ clientX: 130, clientY: 100 }] })
			vi.advanceTimersByTime(500)

			expect(view.emitted('update:selected')).toBeUndefined()
		})

		it('survives a touchmove within the movement tolerance (hand tremor)', () => {
			const view = mountEnvelope()
			view.vm.onEnvelopeTouchStart({ touches: [{ clientX: 100, clientY: 100 }] })

			view.vm.onEnvelopeTouchMove({ touches: [{ clientX: 105, clientY: 100 }] })
			vi.advanceTimersByTime(500)

			expect(view.emitted('update:selected')).toEqual([[true]])
		})

		it('is cancelled by touchend before the hold completes', () => {
			const view = mountEnvelope()
			view.vm.onEnvelopeTouchStart({ touches: [{ clientX: 100, clientY: 100 }] })

			view.vm.onEnvelopeTouchEnd()
			vi.advanceTimersByTime(500)

			expect(view.emitted('update:selected')).toBeUndefined()
		})

		it('still works on a draft row (bulk-selecting drafts is a real case)', () => {
			const view = mountEnvelope({
				data: {
					accountId: 123,
					databaseId: 999,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: true },
				},
			})

			view.vm.onEnvelopeTouchStart({ touches: [{ clientX: 100, clientY: 100 }] })
			vi.advanceTimersByTime(500)

			expect(view.emitted('update:selected')).toEqual([[true]])
		})

		it('clears a stale suppress flag on the next touchstart (a long-press that produced no trailing click must not swallow the next real tap)', () => {
			const view = mountEnvelope()

			// A long-press fired but its synthesized click never arrived, so
			// the flag is still set going into the next, unrelated gesture.
			view.setData({ suppressNextClickAfterLongPress: true })

			view.vm.onEnvelopeTouchStart({ touches: [{ clientX: 100, clientY: 100 }] })

			expect(view.vm.suppressNextClickAfterLongPress).toBe(false)
		})

		it('does not flip a non-selected avatar to a check on a synthesized mouseenter on touch (list reflow under a held finger)', () => {
			isCoarsePointer.mockReturnValue(true)
			try {
				const view = mountEnvelope()

				view.vm.onAvatarMouseEnter()

				expect(view.vm.hoveringAvatar).toBe(false)
			} finally {
				isCoarsePointer.mockReturnValue(false)
			}
		})

		it('still shows the hover check on a real (fine) pointer', () => {
			const view = mountEnvelope()

			view.vm.onAvatarMouseEnter()

			expect(view.vm.hoveringAvatar).toBe(true)
		})
	})

	describe('selection-mode avatar affordance (empty selectable circle on non-selected rows)', () => {
		function mountEnvelope(propsOverride = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: { specialRole: '', databaseId: 42, myAcls: undefined },
					selectMode: false,
					selected: false,
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

		it('shows the empty selectable circle on a non-selected row while in selection mode', () => {
			const view = mountEnvelope({ selectMode: true, selected: false })

			expect(view.find('.select-affordance').exists()).toBe(true)
			expect(view.findComponent({ name: 'Avatar' }).exists()).toBe(false)
		})

		it('shows the normal avatar when NOT in selection mode', () => {
			const view = mountEnvelope({ selectMode: false, selected: false })

			expect(view.find('.select-affordance').exists()).toBe(false)
			expect(view.findComponent({ name: 'Avatar' }).exists()).toBe(true)
		})

		it('shows the filled check (not the empty circle) on the selected row itself', () => {
			const view = mountEnvelope({ selectMode: true, selected: true })

			expect(view.find('.select-affordance').exists()).toBe(false)
			expect(view.find('.check-icon').exists()).toBe(true)
		})
	})

	describe('link()/isActiveThread decouple the row from $route (2026-07-20 open-latency fix)', () => {
		// Every row used to be a <router-link>, so opening any message
		// re-rendered the whole list. link() now reads the store's route
		// mirror (stable across thread opens) and active state comes from
		// currentOpenThreadId, so only the affected rows re-render.
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

		it('builds the target route from the store mirror, not $route', () => {
			store.setCurrentViewMailboxIdMutation('priority')
			store.setCurrentViewFilterMutation('starred')
			const view = mountEnvelope()

			expect(view.vm.link).toEqual({
				name: 'message',
				params: { mailboxId: 'priority', filter: 'starred', threadId: 999 },
			})
		})

		it('omits an empty filter segment', () => {
			store.setCurrentViewMailboxIdMutation('42')
			store.setCurrentViewFilterMutation(undefined)
			const view = mountEnvelope()

			expect(view.vm.link.params.filter).toBeUndefined()
		})

		it('has no link for a draft row (it opens the composer instead)', () => {
			const view = mountEnvelope({
				data: {
					accountId: 123,
					databaseId: 999,
					from: [{ email: 'info@test.com' }],
					flags: { seen: false, flagged: false, $junk: false, answered: false, hasAttachments: false, draft: true },
				},
			})

			expect(view.vm.link).toBeUndefined()
		})

		it('marks itself active only when its own thread id is the open one', () => {
			const view = mountEnvelope()
			expect(view.vm.isActiveThread).toBe(false)

			store.setCurrentOpenThreadIdMutation(999)
			expect(view.vm.isActiveThread).toBe(true)

			store.setCurrentOpenThreadIdMutation(1000)
			expect(view.vm.isActiveThread).toBe(false)

			store.setCurrentOpenThreadIdMutation(undefined)
			expect(view.vm.isActiveThread).toBe(false)
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
			// Importance now reads the per-copy flag, not the user-wide tag.
			const view = mountEnvelope({ important: true })

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

		// Profiled live at ~2.5% of main-thread samples: every row ran the
		// attachment-chip measurement (several layout-forcing DOM reads)
		// synchronously on mount and on every resize event. Rows without
		// attachments skip it entirely; the rest coalesce onto one
		// animation frame.
		it('does not schedule any attachment measurement for a row without attachments', () => {
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame')

			const view = mountMailboxRow()
			view.vm.onWindowResize()

			expect(rafSpy).not.toHaveBeenCalled()
			rafSpy.mockRestore()
		})

		it('coalesces a resize burst into one scheduled measurement for a row with attachments', async () => {
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42)
			const view = mountMailboxRow()
			await view.setProps({
				data: { ...view.vm.data, attachments: [{ fileName: 'a.pdf' }] },
			})
			rafSpy.mockClear() // the late-arrival watcher may already have scheduled once

			view.vm.attachmentMeasureRaf = null
			view.vm.onWindowResize()
			view.vm.onWindowResize()
			view.vm.onWindowResize()

			expect(rafSpy).toHaveBeenCalledTimes(1)
			rafSpy.mockRestore()
		})

		it('measures once attachments arrive late (preview enhancer), so the chips still appear', async () => {
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
				cb()
				return 1
			})
			const view = mountMailboxRow()
			const countSpy = vi.spyOn(view.vm, 'countPossibleAttachements').mockImplementation(() => {})

			view.setProps({
				data: { ...view.vm.data, attachments: [{ fileName: 'a.pdf' }] },
			})
			await view.vm.$nextTick()

			expect(countSpy).toHaveBeenCalled()
			rafSpy.mockRestore()
		})

		it('cancels a pending measurement frame on destroy', async () => {
			vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(77)
			const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')
			const view = mountMailboxRow()
			await view.setProps({
				data: { ...view.vm.data, attachments: [{ fileName: 'a.pdf' }] },
			})
			view.vm.attachmentMeasureRaf = null
			view.vm.onWindowResize()

			view.destroy()

			expect(cancelSpy).toHaveBeenCalledWith(77)
			vi.restoreAllMocks()
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

	describe('thread-context badges in the Important/Favorites sections', () => {
		// A row rendered inside those sections is there because its THREAD
		// matched the section's query (thread-wide EXISTS) -- when the
		// shown message itself doesn't carry the attribute, an outline
		// badge variant explains why the row is here (reported live as
		// confusing: a message "in Important" with no badge at all).
		function mountRow({ flagged = false, important = false, searchQuery } = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: { specialRole: '', databaseId: '3', myAcls: undefined },
					searchQuery,
					data: {
						accountId: 123,
						databaseId: 999,
						from: [{ email: 'info@test.com' }],
						flags: { seen: false, flagged, important, $junk: false, answered: false, hasAttachments: false, draft: false },
					},
				},
				store,
				localVue,
			})
		}

		it('offers the thread-important outline badge for an unimportant message rendered in an is:pi-important list', () => {
			const view = mountRow({ searchQuery: 'not:starred is:pi-important' })

			expect(view.vm.threadCarriesImportantOnly).toBe(true)
		})

		it('does not offer it when the message itself is important (the filled badge covers that)', () => {
			// Per-copy flag, the same source the sections and the filled
			// badge now read -- not the user-wide tag.
			const view = mountRow({ important: true, searchQuery: 'not:starred is:pi-important' })

			expect(view.vm.threadCarriesImportantOnly).toBe(false)
		})

		// The reported live case (message 1100345): the copy's
		// flag_important is set (our classifier's keyword round-tripped
		// via IMAP) but no user-wide $label1 tag was ever created (the
		// classifier's tagMessage step can fail independently). The badge
		// must follow the flag -- the same source that put the row in the
		// Important section -- so the message visibly IS the important one
		// instead of showing a confusing "the conversation contains an
		// important message" outline with no filled badge anywhere.
		it('shows the filled badge for a flag-important copy even when no user-wide tag exists', () => {
			const view = mountRow({ important: true, searchQuery: 'not:starred is:pi-important' })

			expect(view.vm.isImportant).toBe(true)
		})

		it('does not offer it outside an is:pi-important list', () => {
			const view = mountRow({ searchQuery: 'not:starred is:pi-other' })

			expect(view.vm.threadCarriesImportantOnly).toBe(false)
		})

		it('offers the thread-starred outline badge for an unstarred message rendered in an is:starred list', () => {
			const view = mountRow({ searchQuery: 'is:starred' })

			expect(view.vm.threadCarriesStarredOnly).toBe(true)
			expect(view.find('.thread-context-badge--favorite').exists()).toBe(true)
		})

		it('marks the thread-important outline badge for its blue context styling', () => {
			const view = mountRow({ searchQuery: 'not:starred is:pi-important' })

			expect(view.find('.thread-context-badge--important').exists()).toBe(true)
		})

		it('does not offer it when the message itself is starred, or outside an is:starred list', () => {
			expect(mountRow({ flagged: true, searchQuery: 'is:starred' }).vm.threadCarriesStarredOnly).toBe(false)
			expect(mountRow({ searchQuery: 'not:starred is:pi-other' }).vm.threadCarriesStarredOnly).toBe(false)
		})
	})
	// Reported live on 2026-07-28: the badge went hollow while the row stayed
	// in its section. The row's icons used to call the per-message
	// toggleEnvelope*() actions, which write the head's flag only, while
	// section membership reads the thread-wide aggregate. Routing them
	// through the store's row-level actions is the whole fix, so it is the
	// thing asserted here.
	describe('the row icons act through the row-level store actions', () => {
		function mountIconRow({ flagged = false, important = false } = {}) {
			return shallowMount(Envelope, {
				mocks: { $route },
				propsData: {
					mailbox: { specialRole: '', databaseId: '3', myAcls: undefined },
					data: {
						accountId: 123,
						databaseId: 999,
						from: [{ email: 'info@test.com' }],
						flags: { seen: false, flagged, important, $junk: false, answered: false, hasAttachments: false, draft: false },
					},
				},
				store,
				localVue,
			})
		}

		it('stars through markEnvelopeFavoriteOrUnfavorite rather than the per-message toggle', () => {
			const favorite = vi.spyOn(store, 'markEnvelopeFavoriteOrUnfavorite').mockResolvedValue()
			const perMessage = vi.spyOn(store, 'toggleEnvelopeFlagged').mockResolvedValue()

			mountIconRow().vm.onToggleFlagged()

			expect(favorite).toHaveBeenCalledWith({ envelope: expect.objectContaining({ databaseId: 999 }), favFlag: true })
			expect(perMessage).not.toHaveBeenCalled()
		})

		it('sends the direction the icon is showing, so a lit star clears', () => {
			const favorite = vi.spyOn(store, 'markEnvelopeFavoriteOrUnfavorite').mockResolvedValue()

			mountIconRow({ flagged: true }).vm.onToggleFlagged()

			expect(favorite).toHaveBeenCalledWith({ envelope: expect.anything(), favFlag: false })
		})

		it('marks importance through markEnvelopeImportantOrUnimportant', () => {
			const importance = vi.spyOn(store, 'markEnvelopeImportantOrUnimportant').mockResolvedValue()
			const perMessage = vi.spyOn(store, 'toggleEnvelopeImportant').mockResolvedValue()

			mountIconRow().vm.onToggleImportant()

			expect(importance).toHaveBeenCalledWith({ envelope: expect.anything(), addTag: true })
			expect(perMessage).not.toHaveBeenCalled()
		})

		it('clears importance when the badge is already filled', () => {
			const importance = vi.spyOn(store, 'markEnvelopeImportantOrUnimportant').mockResolvedValue()

			mountIconRow({ important: true }).vm.onToggleImportant()

			expect(importance).toHaveBeenCalledWith({ envelope: expect.anything(), addTag: false })
		})
	})

	describe('the task badge on the avatar', () => {
		// Third corner of the same system: important holds top-start, the star
		// top-end, the task bottom-start -- and the same rule decides which
		// form it takes. Filled means THIS message; outlined means somewhere
		// in the conversation. Exactly what Star/StarOutline already do, so it
		// has to behave identically or the app teaches two rules for one idea.

		/**
		 * @param {object} flags envelope flags under test
		 * @return {object} the mounted row
		 */
		const mountRow = (flags) => shallowMount(Envelope, {
			mocks: { $route },
			propsData: {
				data: {
					accountId: 123,
					from: [{ email: 'info@test.com' }],
					flags: {
						seen: true, flagged: false, $junk: false, answered: false,
						hasAttachments: false, draft: false, ...flags,
					},
				},
				account: { sentMailboxId: '1' },
				mailbox: { myAcls: undefined, databaseId: '3', specialRole: '' },
			},
			store,
			localVue,
		})

		it('is filled when this message has the task', () => {
			const icons = mountRow({ hasTask: true, hasTaskInThread: true })
				.findAllComponents({ name: 'TasksAppIcon' })

			expect(icons).toHaveLength(1)
			expect(icons.at(0).props('outlined')).toBe(false)
		})

		it('is outlined when only the conversation carries one', () => {
			const icons = mountRow({ hasTask: false, hasTaskInThread: true })
				.findAllComponents({ name: 'TasksAppIcon' })

			expect(icons).toHaveLength(1)
			expect(icons.at(0).props('outlined')).toBe(true)
		})

		it('shows exactly one, never both', () => {
			// v-if/v-else-if, not two independent conditions: a message that
			// has a task is also in a thread that has one, and stacking the
			// filled and outlined marks in the same corner would be a mess.
			const icons = mountRow({ hasTask: true, hasTaskInThread: true })
				.findAllComponents({ name: 'TasksAppIcon' })

			expect(icons).toHaveLength(1)
		})

		it('shows none when there is no task anywhere', () => {
			expect(mountRow({}).findAllComponents({ name: 'TasksAppIcon' })).toHaveLength(0)
		})
	})
})
