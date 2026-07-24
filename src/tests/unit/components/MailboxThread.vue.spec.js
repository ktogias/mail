/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import MailboxThread from '../../../components/MailboxThread.vue'
import LoadMoreSentinelMixin from '../../../mixins/LoadMoreSentinelMixin.js'
import Nextcloud from '../../../mixins/Nextcloud.js'
import { WorkClass } from '../../../service/RequestCoordinator.js'
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

	it('shares the existing SearchMessages unread filter and preserves Priority partitioning', () => {
		store.preferences['sort-favorites'] = 'true'
		const wrapper = mountThread()

		wrapper.vm.onUpdateSearchQuery('flags:unread match:allof')

		expect(wrapper.vm.priorityUnreadOnly).toBe(true)
		expect(wrapper.vm.searchQuery).toBe('flags:unread match:allof not:starred')
		expect(wrapper.vm.appendToSearch(wrapper.vm.favoriteQuery))
			.toBe('flags:unread match:allof is:starred')
		expect(wrapper.vm.appendToSearch(priorityImportantQuery))
			.toBe(`flags:unread match:allof not:starred ${priorityImportantQuery}`)

		wrapper.vm.onUpdateSearchQuery('match:allof')
		expect(wrapper.vm.priorityUnreadOnly).toBe(false)
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

	describe('load-more sentinel (replaces the old v-infinite-scroll directive)', () => {
		// See util/loadMoreSentinelObserver.js: a scroll-position-math
		// directive on the whole list was replaced with an
		// IntersectionObserver watching a sentinel element placed after
		// everything currently rendered.

		// Each test below spies on LoadMoreSentinelMixin.methods directly
		// (a module-level object, shared across every test in this file)
		// -- restore it afterward so a leftover spy doesn't linger into
		// unrelated tests.
		afterEach(() => {
			vi.restoreAllMocks()
		})

		it('registers the rendered sentinel element with onScroll as the callback on mount', () => {
			// Spies on the MIXIN's own methods object, not MailboxThread's:
			// Vue merges mixin methods into the component instance at
			// mount time, reading from this exact object, so overwriting
			// it here before mounting is what actually intercepts the
			// call -- spying on MailboxThread.methods wouldn't, since
			// this method was never copied onto that object.
			const registerSpy = vi.spyOn(LoadMoreSentinelMixin.methods, 'registerLoadMoreSentinel')

			const wrapper = mountThread()

			expect(registerSpy).toHaveBeenCalledWith(wrapper.vm.$refs.loadMoreSentinel, wrapper.vm.onScroll)
			expect(wrapper.vm.$refs.loadMoreSentinel).toBeTruthy()
		})

		it('unregisters the sentinel observer on destroy', () => {
			const unregisterSpy = vi.spyOn(LoadMoreSentinelMixin.methods, 'unregisterLoadMoreSentinel')

			const wrapper = mountThread()
			wrapper.destroy()

			expect(unregisterSpy).toHaveBeenCalled()
		})

		it("onScroll still emits 'load-more' on the bus, same as the directive used to trigger", () => {
			const wrapper = mountThread()
			const bus = wrapper.vm.bus
			const emitSpy = vi.spyOn(bus, 'emit')

			wrapper.vm.onScroll()

			expect(emitSpy).toHaveBeenCalledWith('load-more')
		})
	})

	describe('pull-to-refresh (owned here, not per Mailbox section)', () => {
		// The list stacks several Mailbox sections, each preceded by a
		// section title inside one shared scroller, so a per-section "am I
		// at the scroller top" check never armed. Ownership is here, on the
		// single scroller owner. The spinner is bound to the ACTUAL sync
		// completing (not a fixed timer), so it doesn't declare "done"
		// before new mail lands.
		afterEach(() => {
			vi.useRealTimers()
		})

		it('keeps the spinner up until the real sync resolves -- past the min-visible window, not on a fixed timer', async () => {
			vi.useFakeTimers()
			const wrapper = mountThread()
			let resolveSync
			store.syncEnvelopes = vi.fn().mockReturnValue(new Promise((r) => {
				resolveSync = r
			}))
			store.syncMailboxesForAccount = vi.fn().mockResolvedValue()

			const done = wrapper.vm.onPullToRefresh()

			// Past the min-visible window, but the sync is still pending, so
			// the spinner must NOT have retracted (the whole point of the fix).
			await vi.advanceTimersByTimeAsync(1500)
			expect(store.syncEnvelopes).toHaveBeenCalledWith({
				mailboxId: wrapper.vm.mailbox.databaseId,
				workClass: WorkClass.EXPLICIT_HEAVY,
			})
			expect(wrapper.vm.pullToRefreshSpinning).toBe(true)

			// Sync resolves -> the whole refresh settles and the spinner clears.
			resolveSync()
			await vi.advanceTimersByTimeAsync(0)
			await done

			expect(store.syncMailboxesForAccount).toHaveBeenCalled()
			expect(wrapper.vm.pullToRefreshSpinning).toBe(false)
		})

		it('retracts at the max cap if the sync never resolves (no infinite spin)', async () => {
			vi.useFakeTimers()
			const wrapper = mountThread()
			store.syncEnvelopes = vi.fn().mockReturnValue(new Promise(() => {})) // never resolves
			store.syncMailboxesForAccount = vi.fn().mockResolvedValue()

			const done = wrapper.vm.onPullToRefresh()

			await vi.advanceTimersByTimeAsync(20 * 1000)
			await done

			expect(wrapper.vm.pullToRefreshSpinning).toBe(false)
		})

		it('clears the spinner even when the sync rejects (does not hang)', async () => {
			vi.useFakeTimers()
			const wrapper = mountThread()
			store.syncEnvelopes = vi.fn().mockRejectedValue(new Error('network error'))
			store.syncMailboxesForAccount = vi.fn().mockResolvedValue()

			const done = wrapper.vm.onPullToRefresh()
			await vi.advanceTimersByTimeAsync(700)
			await done

			expect(wrapper.vm.pullToRefreshSpinning).toBe(false)
		})
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

	describe('sortFavorites watcher (toggling the preference live, not on initial mount)', () => {
		// Regression: the ternary's branches were backwards. Turning the
		// preference on with an ALREADY-active search query discarded it
		// outright (replaced with the bare 'not:starred', silently
		// dropping whatever the user had typed); turning it on with NO
		// active query produced the literal string "undefined
		// not:starred" (this.searchQuery, still unset, coerced to a
		// string by the + concatenation) -- the exact same "poisoned
		// query" class of bug appendToSearch()'s own comment documents
		// elsewhere in this file, just reachable by toggling the setting
		// live instead of by mounting.
		it('appends not:starred to an existing search query instead of discarding it', async () => {
			const wrapper = mountThread()
			await wrapper.setData({ searchQuery: 'mentions:false match:allof' })

			store.savePreferenceMutation({ key: 'sort-favorites', value: 'true' })
			await wrapper.vm.$nextTick()

			expect(wrapper.vm.searchQuery).toBe('mentions:false match:allof not:starred')
		})

		it('sets the bare not:starred, not "undefined not:starred", when there is no existing query', async () => {
			const wrapper = mountThread()
			expect(wrapper.vm.searchQuery).toBeUndefined()

			store.savePreferenceMutation({ key: 'sort-favorites', value: 'true' })
			await wrapper.vm.$nextTick()

			expect(wrapper.vm.searchQuery).toBe('not:starred')
		})

		it('removes not:starred again when the preference is turned back off, normalizing back to undefined rather than an empty string', async () => {
			store.savePreferenceMutation({ key: 'sort-favorites', value: 'true' })
			const wrapper = mountThread()
			expect(wrapper.vm.searchQuery).toBe('not:starred')

			store.savePreferenceMutation({ key: 'sort-favorites', value: 'false' })
			await wrapper.vm.$nextTick()

			expect(wrapper.vm.searchQuery).toBeUndefined()
		})
	})

	describe('backfill-progress banner ("still importing older messages")', () => {
		// Lives here in the parent (not the child Mailbox) so it renders above
		// every section -- inside the child it landed below the Favorites list
		// (reported live). Shown for a real, non-priority mailbox that's
		// genuinely still backfilling (mailbox metadata isCached === false)
		// once there's a list to sit above, until dismissed. Priority gating is
		// the template's (the v-else branch has no banner), so those cases are
		// asserted on the rendered DOM, the rest on showBackfillBanner directly.
		function mountThreadFor(mailbox) {
			return shallowMount(MailboxThread, {
				propsData: {
					account: store.accountsUnmapped[0],
					mailbox,
				},
				store,
				localVue,
				mocks: { $route: { params: {} } },
				stubs: {
					AppContent: { template: '<div><slot name="list" /><slot /></div>' },
					AppContentList: { template: '<div><slot /></div>' },
				},
			})
		}

		function regularMailbox(overrides = {}) {
			return { databaseId: 38, name: 'Junk', envelopeLists: {}, isCached: false, total: 98000, cached: 5000, ...overrides }
		}

		beforeEach(() => {
			// A non-empty list under the banner (hasEnvelopes true).
			store.getEnvelopes = vi.fn().mockReturnValue([{ databaseId: 1 }])
		})

		it('shows while the mailbox is incomplete and has messages', () => {
			const wrapper = mountThreadFor(regularMailbox())

			expect(wrapper.vm.showBackfillBanner).toBe(true)
			expect(wrapper.find('.backfill-banner').exists()).toBe(true)
			// Text is produced (exact number formatting depends on locale/t());
			// the count-carrying branch is exercised (cached present, not null).
			expect(typeof wrapper.vm.backfillBannerText).toBe('string')
			expect(wrapper.vm.backfillBannerText.length).toBeGreaterThan(0)
		})

		it('falls back to the count-less text when cached is unknown', () => {
			const wrapper = mountThreadFor(regularMailbox({ cached: null }))

			expect(wrapper.vm.showBackfillBanner).toBe(true)
			expect(typeof wrapper.vm.backfillBannerText).toBe('string')
		})

		it('hides once the backfill is complete (isCached true)', () => {
			const wrapper = mountThreadFor(regularMailbox({ isCached: true }))

			expect(wrapper.vm.showBackfillBanner).toBe(false)
			expect(wrapper.find('.backfill-banner').exists()).toBe(false)
		})

		it('is not rendered in the Priority Inbox (virtual mailbox -- an X-of-Y figure is meaningless there)', () => {
			// The priority mailbox takes the v-else template branch, which has
			// no banner at all -- regardless of its metadata.
			const priority = store.mailboxes[PRIORITY_INBOX_ID]
			priority.isCached = false
			priority.total = 98000
			priority.cached = 5000

			const wrapper = mountThreadFor(priority)

			expect(wrapper.find('.backfill-banner').exists()).toBe(false)
		})

		it('hides when the mailbox metadata has not loaded (isCached undefined, not false)', () => {
			const wrapper = mountThreadFor(regularMailbox({ isCached: undefined }))

			expect(wrapper.vm.showBackfillBanner).toBe(false)
		})

		it('hides after the user dismisses it for the session', () => {
			const mailbox = regularMailbox()
			const wrapper = mountThreadFor(mailbox)
			expect(wrapper.vm.showBackfillBanner).toBe(true)

			wrapper.vm.dismissBackfillBanner()

			expect(store.backfillBannerDismissed[mailbox.databaseId]).toBe(true)
			expect(wrapper.vm.showBackfillBanner).toBe(false)
		})
	})
})
