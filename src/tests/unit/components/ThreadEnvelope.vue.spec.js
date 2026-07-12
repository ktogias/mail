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

		it('prefetches the collapsed message on touchstart past the (shorter) touch delay', async () => {
			const view = mountThreadEnvelope(false)

			view.vm.onEnvelopeTouchStart()
			expect(store.fetchMessage).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(60)

			expect(store.fetchMessage).toHaveBeenCalledWith(999)
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

			expect(store.fetchMessage).toHaveBeenCalledWith(999)
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
})
