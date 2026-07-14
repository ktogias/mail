/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ThreadEnvelope from '../../../components/ThreadEnvelope.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'
import * as ViewportPrefetchObserver from '../../../util/viewportPrefetchObserver.js'

vi.mock('../../../util/viewportPrefetchObserver.js')

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

	describe('marking as read is anchored to content actually rendering, not the data fetch resolving', () => {
		// Confirmed live: after today's message-body caching landed, a
		// cache hit can resolve fetchMessage()'s data near-instantly
		// while the actual rendered content (Message.vue's own @load
		// event) still takes its normal time to display -- the unread
		// marker was clearing while the loading skeleton was still
		// showing, before the user could have possibly seen anything.
		let store

		beforeEach(() => {
			vi.useFakeTimers()
			store = useMainStore()
			store.toggleEnvelopeSeen = vi.fn()
			store.getAccount = vi.fn().mockReturnValue({ name: 'Test', emailAddress: 'test@test.com' })
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		function mountThreadEnvelope(expanded, hasHtmlBody) {
			store.fetchMessage = vi.fn().mockResolvedValue({
				databaseId: 999,
				hasHtmlBody,
				attachments: [],
				dkimValid: true,
				itineraries: [],
			})
			return shallowMount(ThreadEnvelope, {
				propsData: {
					account: {},
					mailbox: { specialRole: '' },
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
					threadIndex: 0,
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

		it('does not mark as read merely because the data fetch resolved -- rendering is still pending', async () => {
			mountThreadEnvelope(true, true) // hasHtmlBody: true -> waits on Message.vue's own @load
			await vi.advanceTimersByTimeAsync(0)

			// The data is in hand, but nothing has told us the content
			// actually rendered yet -- advancing well past the 2s
			// mark-as-read delay must not fire it.
			await vi.advanceTimersByTimeAsync(5000)

			expect(store.toggleEnvelopeSeen).not.toHaveBeenCalled()
		})

		it('marks as read 2s after the content actually finishes rendering', async () => {
			const view = mountThreadEnvelope(true, true)
			await vi.advanceTimersByTimeAsync(0)

			view.vm.onMessageLoaded()
			await vi.advanceTimersByTimeAsync(1999)
			expect(store.toggleEnvelopeSeen).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(1)
			expect(store.toggleEnvelopeSeen).toHaveBeenCalledWith({
				envelope: expect.objectContaining({ databaseId: 999 }),
			})
		})

		it('still marks as read for a body-less message, which reaches Done synchronously with no @load to wait for', async () => {
			mountThreadEnvelope(true, false) // hasHtmlBody: false -> Done immediately
			await vi.advanceTimersByTimeAsync(2000)

			expect(store.toggleEnvelopeSeen).toHaveBeenCalled()
		})

		it('does not start the timer when collapsing before the content ever finished rendering', async () => {
			const view = mountThreadEnvelope(true, true)
			await vi.advanceTimersByTimeAsync(0)

			// Collapse before Message.vue's own @load (onMessageLoaded)
			// ever fires -- the expanded watcher's own else-branch also
			// sets loading to Done (just to reset local state), which
			// must not be mistaken for "the content was actually seen".
			await view.setProps({ expanded: false })
			await vi.advanceTimersByTimeAsync(5000)

			expect(store.toggleEnvelopeSeen).not.toHaveBeenCalled()
		})
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

			expect(store.fetchMessage).toHaveBeenCalledWith(999, { speculative: true })
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

		it('prefetches the collapsed message on touchstart past the (shorter) touch delay', async () => {
			const view = mountThreadEnvelope(false)

			view.vm.onEnvelopeTouchStart()
			expect(store.fetchMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(60)

			expect(store.fetchMessage).toHaveBeenCalledWith(999, { speculative: true })
		})

		it('does not prefetch when touchmove happens before the delay elapses', async () => {
			const view = mountThreadEnvelope(false)

			view.vm.onEnvelopeTouchStart()
			view.vm.cancelHoverPrefetch()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('does not additionally prefetch an already-expanded message on touchstart', async () => {
			const view = mountThreadEnvelope(true)
			await vi.advanceTimersByTimeAsync(0)
			const callsAfterMount = store.fetchMessage.mock.calls.length
			expect(callsAfterMount).toBeGreaterThan(0)

			view.vm.onEnvelopeTouchStart()
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).toHaveBeenCalledTimes(callsAfterMount)
		})
	})

	describe('viewport prefetch', () => {
		let store

		beforeEach(() => {
			vi.useFakeTimers()
			vi.clearAllMocks()
			store = useMainStore()
			store.getAccount = vi.fn().mockReturnValue({ name: 'Test', emailAddress: 'test@test.com' })
			// Fuller shape needed for the expanded=true case: mounted()'s
			// own fetchMessage() drives follow-up itineraries/dkim checks
			// that read these fields (same shape as the hover-prefetch
			// block above).
			store.fetchMessage = vi.fn().mockResolvedValue({
				databaseId: 999,
				hasHtmlBody: false,
				attachments: [],
				dkimValid: true,
				itineraries: [],
			})
			ViewportPrefetchObserver.runIfViewportPrefetchSlotAvailable.mockImplementation((fn) => fn())
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

		it('registers its own element for viewport visibility on mount, when collapsed', () => {
			const view = mountThreadEnvelope(false)

			expect(ViewportPrefetchObserver.observeViewportVisibility).toHaveBeenCalledWith(view.vm.$el, expect.any(Function))
		})

		it('does not register an already-expanded message -- mounted() already fetched it', async () => {
			mountThreadEnvelope(true)
			await vi.advanceTimersByTimeAsync(0)

			expect(ViewportPrefetchObserver.observeViewportVisibility).not.toHaveBeenCalled()
		})

		it('prefetches the collapsed message once continuously visible past the settle delay', async () => {
			mountThreadEnvelope(false)
			const onIntersect = ViewportPrefetchObserver.observeViewportVisibility.mock.calls[0][1]

			onIntersect(true)
			expect(store.fetchMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(300)

			expect(store.fetchMessage).toHaveBeenCalledWith(999, { speculative: true })
		})

		it('does not prefetch if the row leaves the viewport before the settle delay elapses', async () => {
			mountThreadEnvelope(false)
			const onIntersect = ViewportPrefetchObserver.observeViewportVisibility.mock.calls[0][1]

			onIntersect(true)
			onIntersect(false)
			await vi.advanceTimersByTimeAsync(500)

			expect(store.fetchMessage).not.toHaveBeenCalled()
		})

		it('unobserves its element on destroy', () => {
			const view = mountThreadEnvelope(false)
			const el = view.vm.$el

			view.destroy()

			expect(ViewportPrefetchObserver.unobserveViewportVisibility).toHaveBeenCalledWith(el)
		})
	})

	describe('onDelete()/onArchive() request them from Thread.vue instead of calling the store directly', () => {
		// Thread.vue owns the undo-window bookkeeping now (same mechanism
		// EnvelopeList.vue's own delete already goes through for the
		// mailbox list view) -- this component's job is just to say what
		// the user asked for.
		let store

		beforeEach(() => {
			store = useMainStore()
			store.getAccount = vi.fn().mockReturnValue({ name: 'Test', emailAddress: 'test@test.com' })
			store.deleteMessage = vi.fn()
			store.moveMessage = vi.fn()
		})

		function mountThreadEnvelope() {
			return shallowMount(ThreadEnvelope, {
				propsData: {
					account: {},
					mailbox: { specialRole: '' },
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
					threadIndex: 0,
					expanded: false,
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

		it('onDelete() emits delete (for navigation) and request-delete (for the actual deferred deletion), never calling the store itself', () => {
			const view = mountThreadEnvelope()

			view.vm.onDelete()

			expect(view.emitted().delete[0]).toEqual([999])
			expect(view.emitted()['request-delete'][0]).toEqual([view.vm.envelope])
			expect(store.deleteMessage).not.toHaveBeenCalled()
		})

		it('onArchive() emits request-archive, never calling the store itself', () => {
			const view = mountThreadEnvelope()

			view.vm.onArchive()

			expect(view.emitted()['request-archive'][0]).toEqual([view.vm.envelope])
			expect(store.moveMessage).not.toHaveBeenCalled()
		})
	})
})
