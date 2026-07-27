<!--
  - SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<AppContent
		:pane-config-key="'mail-' + layoutMode"
		:layout="layoutMode"
		:show-details="isThreadShown"
		:list-min-width="horizontalListMinWidth"
		:list-max-width="horizontalListMaxWidth"
		@update:showDetails="hideMessage">
		<template #list>
			<div :class="{ list__wrapper: !showThread || !isMobile }">
				<div v-if="!showThread || !isMobile" class="sticky-header">
					<SearchMessages
						ref="searchMessages"
						:mailbox="mailbox"
						:account-id="account.accountId"
						:persistent-filters="mailbox.isPriorityInbox"
						@search-changed="onUpdateSearchQuery" />
					<PriorityInboxOverview
						v-if="mailbox.isPriorityInbox"
						:stats="priorityInboxStats"
						:new-counts="priorityInboxNewCounts"
						:show-favorites="sortFavorites"
						:loading="mainStore.priorityInboxStatsLoading"
						@select="selectPrioritySection" />
				</div>
				<div ref="pullToRefreshIndicator" class="pull-to-refresh-indicator" aria-hidden="true">
					<IconLoading v-if="pullToRefreshSpinning" :size="20" />
					<IconRefresh v-else :size="20" />
				</div>
				<AppContentList
					ref="envelopeList"
					v-shortkey.once="shortkeys"
					class="envelope-list"
					:show-details="showThread"
					role="heading"
					:aria-level="2"
					@shortkey.native="onShortcut">
					<template v-if="!mailbox.isPriorityInbox">
						<!-- Persistent, dismissable status banner: this folder
						     is still importing its older messages in the
						     background (BackfillJob). Rendered here in the
						     parent, above every section (Favorites and the rest),
						     so it sits at the very top of the folder -- inside a
						     child Mailbox it landed below the Favorites list. -->
						<div v-if="showBackfillBanner" class="backfill-banner">
							<IconLoading :size="18" class="backfill-banner__spinner" />
							<span class="backfill-banner__text">{{ backfillBannerText }}</span>
							<ButtonVue
								type="tertiary"
								:aria-label="t('mail', 'Dismiss')"
								:title="t('mail', 'Dismiss')"
								@click="dismissBackfillBanner">
								<template #icon>
									<IconClose :size="20" />
								</template>
							</ButtonVue>
						</div>
						<div
							v-if="sortFavorites"
							v-show="hasFavoriteEnvelopes"
							class="app-content-list-item">
							<SectionTitle
								class="section-title"
								:name="t('mail', 'Favorites')" />
							<NcPopover trigger="hover focus">
								<template #trigger>
									<ButtonVue
										type="tertiary-no-background"
										:aria-label="t('mail', 'Favorites info')"
										class="button">
										<template #icon>
											<IconInfo :size="20" />
										</template>
									</ButtonVue>
								</template>
								<p class="section-header-info">
									{{ favoritesInfo }}
								</p>
							</NcPopover>
						</div>
						<Mailbox
							v-if="sortFavorites"
							v-show="hasFavoriteEnvelopes"
							:load-more-label="t('mail', 'Load more favorites')"
							:account="account"
							:mailbox="mailbox"
							:search-query="prioritySectionQueries.favorite"
							paginate="manual"
							:is-priority-inbox="true"
							:initial-page-size="favoriteInitialPageSize"
							:collapsible="true"
							:bus="bus" />
						<Mailbox
							:account="account"
							:mailbox="mailbox"
							:search-query="query"
							:bus="bus"
							:open-first="mailbox.specialRole !== 'drafts'"
							:group-envelopes="groupEnvelopes"
							:initial-page-size="messagesOrderBydate"
							:collapsible="true" />
						<!-- Replaces the old v-infinite-scroll directive on
							AppContentList itself -- see
							util/loadMoreSentinelObserver.js. Placed after
							every section so it only comes within range once
							the user has actually scrolled past everything
							currently rendered. -->
						<div ref="loadMoreSentinel" class="load-more-sentinel" />
					</template>

					<template v-else>
						<div
							v-if="sortFavorites"
							v-show="hasFavoriteEnvelopes"
							ref="prioritySectionFavorite"
							class="app-content-list-item">
							<SectionTitle
								class="section-title"
								:name="t('mail', 'Favorites')" />
							<NcPopover trigger="hover focus">
								<template #trigger>
									<ButtonVue
										type="tertiary-no-background"
										:aria-label="t('mail', 'Favorites info')"
										class="button">
										<template #icon>
											<IconInfo :size="20" />
										</template>
									</ButtonVue>
								</template>
								<p class="section-header-info">
									{{ favoritesInfo }}
								</p>
							</NcPopover>
						</div>
						<Mailbox
							v-if="sortFavorites"
							v-show="hasFavoriteEnvelopes"
							:load-more-label="t('mail', 'Load more favorites')"
							:account="unifiedAccount"
							:mailbox="unifiedInbox"
							:search-query="prioritySectionQueries.favorite"
							skip-initial-load
							paginate="manual"
							:is-priority-inbox="true"
							:initial-page-size="favoriteInitialPageSize"
							:collapsible="true"
							:bus="bus" />
						<div
							v-show="hasFollowUpEnvelopes"
							class="app-content-list-item">
							<SectionTitle
								class="section-title"
								:name="t('mail', 'Follow up')" />
							<NcPopover trigger="hover focus">
								<template #trigger>
									<ButtonVue
										type="tertiary-no-background"
										:aria-label="t('mail', 'Follow up info')"
										class="button">
										<template #icon>
											<IconInfo :size="20" />
										</template>
									</ButtonVue>
								</template>
								<p class="section-header-info">
									{{ followupInfo }}
								</p>
							</NcPopover>
						</div>
						<Mailbox
							v-if="followUpQuery"
							v-show="hasFollowUpEnvelopes"
							:load-more-label="t('mail', 'Load more follow ups')"
							:account="unifiedAccount"
							:mailbox="followUpMailbox"
							:search-query="appendToSearch(followUpQuery)"
							skip-initial-sync
							paginate="manual"
							:is-priority-inbox="true"
							:initial-page-size="followUpMessagesInitialPageSize"
							:collapsible="true"
							:bus="bus" />
						<div v-show="hasImportantEnvelopes" ref="prioritySectionImportant" class="app-content-list-item">
							<SectionTitle
								class="section-title important"
								:name="t('mail', 'Important')" />
							<NcPopover trigger="hover focus">
								<template #trigger>
									<ButtonVue
										type="tertiary-no-background"
										:aria-label="t('mail', 'Important info')"
										class="button">
										<template #icon>
											<IconInfo :size="20" />
										</template>
									</ButtonVue>
								</template>
								<p class="section-header-info">
									{{ importantInfo }}
								</p>
							</NcPopover>
						</div>
						<Mailbox
							v-show="hasImportantEnvelopes"
							class="nameimportant"
							:load-more-label="t('mail', 'Load more important messages')"
							:account="unifiedAccount"
							:mailbox="unifiedInbox"
							:search-query="prioritySectionQueries.important"
							skip-initial-load
							paginate="manual"
							:is-priority-inbox="true"
							:initial-page-size="importantMessagesInitialPageSize"
							:collapsible="true"
							:bus="bus" />
						<SectionTitle
							v-show="hasOtherEnvelopes"
							ref="prioritySectionOther"
							class="app-content-list-item section-title other"
							:name="t('mail', 'Other')" />
						<Mailbox
							v-show="hasOtherEnvelopes"
							class="nameother"
							:load-more-label="t('mail', 'Load more other messages')"
							:account="unifiedAccount"
							:mailbox="unifiedInbox"
							:search-query="prioritySectionQueries.other"
							skip-initial-load
							:is-priority-inbox="true"
							:bus="bus" />
						<!-- Every section hides itself when its list is
							empty and nothing is fetching (see the
							has*Envelopes computeds), so without a page-level
							empty state a search with no matches rendered a
							blank white list. -->
						<EmptyMailboxSection
							v-if="!hasFavoriteEnvelopes && !hasFollowUpEnvelopes && !hasImportantEnvelopes && !hasOtherEnvelopes"
							key="empty" />
						<div ref="loadMoreSentinel" class="load-more-sentinel" />
					</template>
				</AppContentList>
			</div>
		</template>

		<Thread
			v-if="showThread"
			@delete="deleteMessage"
			@navigate-list="onShortcut" />
		<NoMessageSelected v-else-if="hasEnvelopes" />
	</AppContent>
</template>

<script>
import { NcAppContent as AppContent, NcAppContentList as AppContentList, NcButton as ButtonVue, NcLoadingIcon as IconLoading, isMobile, NcPopover } from '@nextcloud/vue'
import addressParser from 'address-rfc2822'
import mitt from 'mitt'
import { mapStores } from 'pinia'
import IconClose from 'vue-material-design-icons/Close.vue'
import IconInfo from 'vue-material-design-icons/InformationOutline.vue'
import IconRefresh from 'vue-material-design-icons/Refresh.vue'
import EmptyMailboxSection from './EmptyMailboxSection.vue'
import Mailbox from './Mailbox.vue'
import NoMessageSelected from './NoMessageSelected.vue'
import PriorityInboxOverview from './PriorityInboxOverview.vue'
import SearchMessages from './SearchMessages.vue'
import SectionTitle from './SectionTitle.vue'
import Thread from './Thread.vue'
import { getScrollEventTarget, getScrollTop } from '../directives/infinite-scroll.js'
import logger from '../logger.js'
import LoadMoreSentinelMixin from '../mixins/LoadMoreSentinelMixin.js'
import { WorkClass } from '../service/RequestCoordinator.js'
import {
	FOLLOW_UP_MAILBOX_ID,
	PRIORITY_INBOX_ID,
	UNIFIED_ACCOUNT_ID,
	UNIFIED_INBOX_ID,
} from '../store/constants.js'
import useMainStore from '../store/mainStore.js'
import { groupEnvelopesByDate } from '../util/groupedEnvelopes.js'
import {
	priorityImportantQuery,
	priorityInboxSectionQueries,
	priorityOtherQuery,
} from '../util/priorityInbox.js'
import { enablePullToRefresh } from '../util/pullToRefresh.js'
import { detect, toHtml, toPlain } from '../util/text.js'

const START_MAILBOX_DEBOUNCE = 5 * 1000

// The pull-to-refresh spinner is bound to the ACTUAL refresh completing --
// not a fixed timer -- so it doesn't declare "done" seconds before new mail
// actually lands (reported live). A short minimum avoids a flash on a fast/
// cached sync; a generous cap keeps it from spinning forever if a sync hangs
// (this NAS has documented slow-sync/502 episodes).
const PULL_REFRESH_MIN_SPINNER_MS = 600
const PULL_REFRESH_MAX_SPINNER_MS = 20 * 1000

export default {
	name: 'MailboxThread',

	components: {
		AppContent,
		AppContentList,
		ButtonVue,
		EmptyMailboxSection,
		IconClose,
		IconInfo,
		IconLoading,
		IconRefresh,
		Mailbox,
		NoMessageSelected,
		NcPopover,
		PriorityInboxOverview,
		SectionTitle,
		SearchMessages,
		Thread,
	},

	mixins: [isMobile, LoadMoreSentinelMixin],
	props: {
		account: {
			type: Object,
			required: true,
		},

		mailbox: {
			type: Object,
			required: true,
		},
	},

	data() {
		return {

			importantInfo: t('mail', 'Messages will automatically be marked as important using AI. The system learns from which messages you interact with or mark as important. In the beginning you might have to manually change the importance to teach it, but it will improve over time'),
			favoritesInfo: t('mail', 'Messages that you marked as favorite will be shown at the top of folders. You can disable this behavior in the app settings'),
			followupInfo: t('mail', 'AI identifies messages sent by you that likely require a reply but did not receive one after a couple of days and shows them here'),
			bus: mitt(),
			searchQuery: undefined,
			shortkeys: {
				del: ['del'],
				arch: ['a'],
				flag: ['s'],
				next: ['arrowright'],
				prev: ['arrowleft'],
				refresh: ['r'],
				unseen: ['u'],
			},

			priorityImportantQuery,
			priorityOtherQuery,
			favoriteQuery: 'is:starred',
			favoriteInitialPageSize: 5,
			startMailboxTimer: undefined,
			hasContent: false,
			pullToRefreshTeardown: undefined,
			pullToRefreshSpinning: false,
			prioritySectionObserver: undefined,
		}
	},

	computed: {
		...mapStores(useMainStore),

		layoutMode() {
			return this.mainStore.getPreference('layout-mode', 'vertical-split')
		},

		horizontalListMinWidth() {
			return this.layoutMode === 'horizontal-split' ? 40 : 30
		},

		horizontalListMaxWidth() {
			return this.layoutMode === 'horizontal-split' ? 60 : 50
		},

		unifiedAccount() {
			return this.mainStore.getAccount(UNIFIED_ACCOUNT_ID)
		},

		unifiedInbox() {
			return this.mainStore.getMailbox(UNIFIED_INBOX_ID)
		},

		followUpMailbox() {
			return this.mainStore.getMailbox(FOLLOW_UP_MAILBOX_ID)
		},

		/**
		 * @return {string|undefined}
		 */
		followUpQuery() {
			const tag = this.mainStore.getFollowUpTag
			if (!tag) {
				logger.warn('No follow-up tag available')
				return undefined
			}

			const notAfter = new Date()
			notAfter.setDate(notAfter.getDate() - 4)
			const dateToTimestamp = (date) => Math.round(date.getTime() / 1000)
			return `tags:${tag.id} end:${dateToTimestamp(notAfter)}`
		},

		hasEnvelopes() {
			if (this.mailbox.isPriorityInbox) {
				return this.mainStore.getEnvelopes(this.mailbox.databaseId, this.prioritySectionQueries.important).length > 0
					|| this.mainStore.getEnvelopes(this.mailbox.databaseId, this.prioritySectionQueries.other).length > 0
			}
			return this.mainStore.getEnvelopes(this.mailbox.databaseId, this.query).length > 0
		},

		// The has*Envelopes computeds gate each section's v-show. They
		// deliberately count an in-flight fetch as "has": with a pending
		// search every section's list is empty, so all sections (and the
		// loading skeletons inside their Mailbox components) used to be
		// hidden at once -- the user typed a term and stared at a blank
		// white list until the results landed.
		//
		// The unread count replaced the section total here when the totals were
		// dropped: a section with unread messages is worth showing before its
		// rows arrive. A section whose messages are all read is shown by the
		// rows themselves once they land, and by priorityViewIsLoading until
		// they do -- which is why dropping the total does not leave a gap.
		//
		// priorityInboxViewLoading is the same signal for the page-level
		// refresh, which owns the request the sections themselves never make
		// (they render Mailbox with skip-initial-load). Without it a cold
		// reload showed the page-level "No messages" instead of skeletons.
		priorityViewIsLoading() {
			return this.mainStore.priorityInboxViewLoading
		},

		hasImportantEnvelopes() {
			if (this.priorityViewIsLoading) {
				return true
			}
			if (this.prioritySectionStats('important').unread > 0) {
				return true
			}
			const query = this.prioritySectionQueries.important
			if (this.mainStore.isFetchingEnvelopes(this.unifiedInbox.databaseId, query)) {
				return true
			}
			const map = this.mainStore.getEnvelopes(this.unifiedInbox.databaseId, query)
			const envelopes = Array.isArray(map) ? map : Array.from(map?.values() || [])
			return envelopes.length > 0
		},

		hasOtherEnvelopes() {
			if (this.priorityViewIsLoading) {
				return true
			}
			if (this.prioritySectionStats('other').unread > 0) {
				return true
			}
			const query = this.prioritySectionQueries.other
			if (this.mainStore.isFetchingEnvelopes(this.unifiedInbox.databaseId, query)) {
				return true
			}
			const map = this.mainStore.getEnvelopes(this.unifiedInbox.databaseId, query)
			const envelopes = Array.isArray(map) ? map : Array.from(map?.values() || [])
			return envelopes.length > 0
		},

		sortFavorites() {
			return this.mainStore.getPreference('sort-favorites', 'false') === 'true' && this.$route.params.filter !== 'starred'
		},

		/**
		 * The exact envelope-list keys this view renders.
		 *
		 * Built by the shared utility rather than by appendToSearch(), which
		 * simply concatenates the section token onto the search query and so
		 * omits the `not:starred` partition that priorityInboxSectionQueries()
		 * adds to Important and Other when favourites are sorted separately.
		 *
		 * That divergence made refreshPriorityInboxView() publish into
		 * "... not:starred is:pi-important" while this component read
		 * "... is:pi-important". Confirmed live on 2026-07-27 with
		 * sort-favorites enabled: Important rendered "No messages" beside a
		 * header reading "2 unread of 130", and the database agreed with the
		 * header. Favourites was unaffected because its key happens to be
		 * identical in both compositions.
		 *
		 * It only became visible in .27, which made that publish the single
		 * population path -- the per-section sync loop it replaced iterated
		 * over the keys that were ALREADY loaded, so it kept refreshing
		 * whatever this component had created, mismatch and all.
		 *
		 * @return {object} the favorite/important/other list keys
		 */
		prioritySectionQueries() {
			return priorityInboxSectionQueries(this.searchQuery, this.sortFavorites)
		},

		hasFavoriteEnvelopes() {
			if (!this.sortFavorites) {
				return false
			}
			if (this.mailbox.isPriorityInbox && this.priorityViewIsLoading) {
				return true
			}
			if (this.mailbox.isPriorityInbox && this.prioritySectionStats('favorite').unread > 0) {
				return true
			}
			const mailbox = this.mailbox.isPriorityInbox ? this.unifiedInbox : this.mailbox
			const query = this.prioritySectionQueries.favorite
			if (this.mainStore.isFetchingEnvelopes(mailbox.databaseId, query)) {
				// See hasImportantEnvelopes() -- pending fetch counts as
				// "has" so the section's loading skeleton is visible.
				return true
			}
			const envelopes = this.mainStore.getEnvelopes(mailbox.databaseId, query)
			return envelopes.length > 0
		},

		/**
		 * @return {boolean}
		 */
		hasFollowUpEnvelopes() {
			if (!this.followUpQuery) {
				return false
			}

			// The fetch key matches what the section's Mailbox actually
			// requests (appendToSearch), unlike the envelope-list lookup
			// below which predates the search append.
			if (this.mainStore.isFetchingEnvelopes(FOLLOW_UP_MAILBOX_ID, this.appendToSearch(this.followUpQuery))) {
				// See hasImportantEnvelopes().
				return true
			}
			const map = this.mainStore.getEnvelopes(FOLLOW_UP_MAILBOX_ID, this.followUpQuery)
			const envelopes = Array.isArray(map) ? map : Array.from(map?.values() || [])
			return envelopes.length > 0
		},

		importantMessagesInitialPageSize() {
			if (window.innerHeight > 1024) {
				return 7
			}
			if (window.innerHeight > 750) {
				return 5
			}
			return 3
		},

		/**
		 * @return {number}
		 */
		messagesOrderBydate() {
			return 10
		},

		/**
		 * @return {number}
		 */
		followUpMessagesInitialPageSize() {
			return 5
		},

		showThread() {
			return this.$route.name === 'message'
				&& this.$route.params.threadId !== 'mailto'
		},

		query() {
			if (this.$route.params.filter === 'starred') {
				return this.appendToSearch('is:starred')
			}
			return this.searchQuery
		},

		isThreadShown() {
			return !!this.$route.params.threadId
		},

		groupEnvelopes() {
			const allEnvelopes = this.mainStore.getEnvelopes(this.mailbox.databaseId, this.query)
			return this.getGroupedEnvelopes(allEnvelopes, this.mainStore.syncTimestamp, this.sortOrder)
		},

		sortOrder() {
			return this.mainStore.getPreference('sort-order', 'newest')
		},

		priorityInboxStats() {
			return this.mainStore.priorityInboxStats
		},

		priorityStatsComplete() {
			return this.priorityInboxStats?.complete !== false
		},

		priorityInboxNewCounts() {
			return {
				favorite: Object.keys(this.mainStore.priorityInboxNewMessageIds.favorite).length,
				important: Object.keys(this.mainStore.priorityInboxNewMessageIds.important).length,
				other: Object.keys(this.mainStore.priorityInboxNewMessageIds.other).length,
			}
		},

		priorityInboxNewCountsSignature() {
			return Object.values(this.priorityInboxNewCounts).join(':')
		},

		priorityInboxViewRevision() {
			return this.mainStore.priorityInboxViewRevision
		},

		// The "still importing older messages" banner. Reads straight off the
		// mailbox metadata (Mailbox::jsonSerialize's isCached/total, plus the
		// controller-added `cached` for incomplete mailboxes) -- NOT the sync
		// response, which for an uncached mailbox throws before it can carry
		// any stats (exactly the mailboxes that need this banner). Rendered by
		// this parent, not the child Mailbox, so it sits above every section
		// (Favorites and the rest) at the very top of the folder. Only while
		// the folder is genuinely still backfilling (isCached === false --
		// gate on === false, not falsy, so a mailbox whose metadata hasn't
		// loaded yet doesn't flash it), only once there's a list to sit above
		// (hasEnvelopes), and only until the user dismisses it. The
		// non-priority template branch already guarantees this is a real,
		// single mailbox (the virtual unified/Priority Inbox, where a single
		// X-of-Y across many folders is meaningless, is the other branch).
		showBackfillBanner() {
			return this.mailbox?.isCached === false
				&& (this.mailbox?.total ?? 0) > 0
				&& this.hasEnvelopes
				&& !this.mainStore.backfillBannerDismissed[this.mailbox.databaseId]
		},

		backfillBannerText() {
			const cached = this.mailbox?.cached
			if (cached === null || cached === undefined) {
				return t('mail', 'Still importing older messages …')
			}
			return t('mail', 'Still importing older messages ({cached} of {total})', {
				cached: cached.toLocaleString(),
				total: (this.mailbox?.total ?? 0).toLocaleString(),
			})
		},
	},

	watch: {
		async $route(to) {
			// The store can't read the router directly (importing it
			// installs vue-router globally, which breaks $route mocking
			// in every component test) -- mirror the open mailbox into
			// the store for its view-aware decisions instead.
			this.mainStore.setCurrentViewMailboxIdMutation(to.params?.mailboxId)
			this.mainStore.setCurrentViewFilterMutation(to.params?.filter)
			this.handleMailto()
			if (to.name === 'mailbox' && to.params.mailboxId === PRIORITY_INBOX_ID) {
				await this.onPriorityMailboxOpened({ refreshView: true })
			} else if (this.isThreadShown) {
				await this.fetchEnvelopes()
			}
		},

		sortFavorites(enabled) {
			if (enabled) {
				// Was backwards: an existing searchQuery got discarded and
				// replaced with the bare 'not:starred' (silently dropping
				// whatever the user had actually typed), while having no
				// existing query yet produced the literal string
				// "undefined not:starred" (JS coercing the unset
				// this.searchQuery to a string before concatenating) --
				// the same class of leak documented elsewhere in this file
				// (see appendToSearch()'s own comment), just triggered by
				// toggling this preference live instead of by mounting.
				// Upstream fixed the same bug independently (569dfa45c) with
				// this exact line; kept its more defensive else-branch below
				// (optional chaining plus trimming back to undefined) over
				// this fork's original, which could throw on an unset
				// searchQuery and left a stray empty string behind.
				this.searchQuery = this.searchQuery ? this.searchQuery + ' not:starred' : 'not:starred'
			} else if (this.searchQuery?.includes('not:starred')) {
				this.searchQuery = this.searchQuery.replace('not:starred', '').trim() || undefined
			}
			if (this.mailbox.isPriorityInbox) {
				this.mainStore.setCurrentPriorityInboxSearchQueryMutation(this.searchQuery)
			}
		},

		async hasFollowUpEnvelopes(value) {
			if (!value) {
				return
			}

			await this.onPriorityMailboxOpened()
		},

		mailbox() {
			clearTimeout(this.startMailboxTimer)
			setTimeout(this.saveStartMailbox, START_MAILBOX_DEBOUNCE)
			this.fetchEnvelopes()
		},

		priorityInboxNewCountsSignature() {
			this.$nextTick(this.clearVisiblePriorityNewMessages)
		},

		priorityInboxViewRevision() {
			if (!this.mailbox.isPriorityInbox) {
				return
			}
			// Child Mailbox instances own their query-local endReached flag;
			// the parent owns the one sentinel after all Priority sections.
			// Reset both halves after a same-query authoritative replacement.
			this.bus.emit('priority-inbox-view-replaced')
			this.$nextTick(() => {
				this.rearmLoadMoreSentinel(this.$refs.loadMoreSentinel, this.onScroll)
			})
		},
	},

	created() {
		this.mainStore.setCurrentViewMailboxIdMutation(this.$route?.params?.mailboxId)
		this.mainStore.setCurrentViewFilterMutation(this.$route?.params?.filter)
		this.handleMailto()
		// Set here, not in mounted(): Vue mounts children bottom-up
		// (child created+mounted, THEN parent mounted), so setting this
		// in mounted() meant every child Mailbox instance's OWN initial
		// mount fetch always ran first with the stale, un-filtered
		// searchQuery, immediately followed by a second, corrected fetch
		// once this component's mounted() set 'not:starred' and the prop
		// change hit each child's searchQuery watcher -- one wasted
		// request per section, every single page load with "sort
		// favorites separately" enabled (confirmed live via HAR:
		// is:pi-important/is:pi-other requests aborted and immediately
		// re-issued with not:starred added). Setting it here, in
		// created() (which DOES run before any child's created/mounted),
		// makes every child's very first request already carry the
		// correct filter.
		if (this.sortFavorites) {
			this.searchQuery = 'not:starred'
		}
		if (this.mailbox.isPriorityInbox) {
			this.mainStore.setCurrentPriorityInboxSearchQueryMutation(this.searchQuery)
		}
	},

	async mounted() {
		setTimeout(this.saveStartMailbox, START_MAILBOX_DEBOUNCE)
		if (this.isThreadShown) {
			await this.fetchEnvelopes()
		}
		// Replaces the old v-infinite-scroll directive -- see
		// util/loadMoreSentinelObserver.js. Only one of the two
		// mutually-exclusive template branches' sentinels is ever
		// actually rendered, so $refs.loadMoreSentinel resolves to
		// whichever one is currently active.
		this.registerLoadMoreSentinel(this.$refs.loadMoreSentinel, this.onScroll)

		// Pull-to-refresh lives here, on the ONE component that owns the
		// scroller -- not per Mailbox section. The list stacks several
		// Mailbox instances (Favorites/Important/Other) each preceded by a
		// section title inside the same scroller, so no single section's
		// top ever sits at the scroller's top edge; a per-section "am I the
		// topmost" check never armed (the original bug). Here the condition
		// is simply "scrolled to the very top", and the refresh broadcasts
		// to every section via the same bus the `r` shortcut already uses.
		const scroller = this.$refs.envelopeList?.$el
		if (scroller) {
			const container = getScrollEventTarget(scroller)
			this.pullToRefreshTeardown = enablePullToRefresh(container, this.$refs.pullToRefreshIndicator, {
				// Firefox may retain a fractional/sub-pixel scrollTop at the
				// visual top. Treat that as top instead of silently refusing
				// to arm the gesture forever.
				canStart: () => getScrollTop(container) <= 1,
				onRefresh: () => this.onPullToRefresh(),
			})
		}
		if (this.mailbox.isPriorityInbox) {
			await this.onPriorityMailboxOpened({ refreshView: true })
			this.registerPrioritySectionObserver()
		}
	},

	beforeDestroy() {
		clearTimeout(this.startMailboxTimer)
		this.unregisterLoadMoreSentinel()
		this.pullToRefreshTeardown?.()
		this.prioritySectionObserver?.disconnect()
	},

	methods: {
		// Keeps the spinner up until the refresh genuinely finishes (new
		// mail fetched AND classified into the sections), bounded by a min
		// (no flash) and a max (no hang). See the constants above.
		async onPullToRefresh() {
			this.pullToRefreshSpinning = true
			const minVisible = new Promise((resolve) => setTimeout(resolve, PULL_REFRESH_MIN_SPINNER_MS))
			const cap = new Promise((resolve) => setTimeout(resolve, PULL_REFRESH_MAX_SPINNER_MS))
			const refreshed = this.refreshCurrentView().catch((error) => {
				logger.error('pull-to-refresh sync failed', { error })
			})
			try {
				await Promise.all([Promise.race([refreshed, cap]), minVisible])
			} finally {
				this.pullToRefreshSpinning = false
			}
		},

		// The exact awaitable sync path the manual refresh button
		// (NewMessageButtonHeader) uses: fetch new envelopes for the current
		// (possibly virtual/priority) mailbox -- the fan-out surfaces new mail
		// into every section's bucket via the client-side classifier -- then
		// refresh mailbox metadata/counts. Awaiting BOTH is what makes the
		// pull-to-refresh spinner reflect real completion.
		async refreshCurrentView() {
			this.mainStore.setInteractionPriorityMutation()
			if (this.mailbox.isPriorityInbox) {
				await this.mainStore.refreshPriorityInboxView({
					searchQuery: this.searchQuery,
					workClass: WorkClass.EXPLICIT_HEAVY,
					syncSources: true,
				})
				// Follow-up is sourced from Sent rather than Inbox, so it is
				// intentionally outside the exact Priority split above.
				// Refresh it once here instead of once per child component.
				if (this.followUpQuery) {
					await this.mainStore.syncEnvelopes({
						mailboxId: FOLLOW_UP_MAILBOX_ID,
						query: this.appendToSearch(this.followUpQuery),
						workClass: WorkClass.EXPLICIT_HEAVY,
					})
				}
			} else {
				await this.mainStore.syncEnvelopes({
					mailboxId: this.mailbox.databaseId,
					workClass: WorkClass.EXPLICIT_HEAVY,
				})
			}
			await this.mainStore.syncMailboxesForAccount(this.account, WorkClass.EXPLICIT_HEAVY)
		},

		getGroupedEnvelopes(envelopes, syncTimestamp) {
			return groupEnvelopesByDate(envelopes, syncTimestamp, this.sortOrder)
		},

		async fetchEnvelopes() {
			const existingEnvelopes = this.mainStore.getEnvelopes(this.mailbox.databaseId, this.query)
			if (!existingEnvelopes.length) {
				await this.mainStore.fetchEnvelopes({
					mailboxId: this.mailbox.databaseId,
					query: this.query,
				})
			}
		},

		async onPriorityMailboxOpened({ refreshView = false } = {}) {
			logger.debug('Priority inbox was opened')

			await Promise.all([
				this.mainStore.checkFollowUpReminders({ query: this.followUpQuery }),
				refreshView
					? this.mainStore.refreshPriorityInboxView({
							searchQuery: this.searchQuery,
							workClass: WorkClass.ACTIVE_CONTENT,
							syncSources: false,
						}).catch(() => {})
					: this.mainStore.refreshPriorityInboxStats(WorkClass.ACTIVE_CONTENT).catch(() => {}),
			])
		},

		prioritySectionStats(section) {
			return this.priorityInboxStats?.sections?.[section] ?? { unread: 0 }
		},

		prioritySectionElement(section) {
			const refName = {
				favorite: 'prioritySectionFavorite',
				important: 'prioritySectionImportant',
				other: 'prioritySectionOther',
			}[section]
			const ref = this.$refs[refName]
			return ref?.$el ?? ref
		},

		selectPrioritySection(section) {
			const target = this.prioritySectionElement(section)
			target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
			this.mainStore.clearPriorityInboxNewMessagesMutation(section)
		},

		registerPrioritySectionObserver() {
			if (typeof IntersectionObserver === 'undefined') {
				return
			}
			this.prioritySectionObserver?.disconnect()
			const scroller = this.$refs.envelopeList?.$el
			const root = scroller ? getScrollEventTarget(scroller) : null
			this.prioritySectionObserver = new IntersectionObserver((entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						this.mainStore.clearPriorityInboxNewMessagesMutation(entry.target.dataset.prioritySection)
					}
				})
			}, { root, threshold: 0.6 })
			;['favorite', 'important', 'other'].forEach((section) => {
				const element = this.prioritySectionElement(section)
				if (!element) {
					return
				}
				element.dataset.prioritySection = section
				this.prioritySectionObserver.observe(element)
			})
		},

		clearVisiblePriorityNewMessages() {
			const scroller = this.$refs.envelopeList?.$el
			if (!scroller) {
				return
			}
			const root = getScrollEventTarget(scroller)
			const rootRect = root.getBoundingClientRect()
			;['favorite', 'important', 'other'].forEach((section) => {
				const element = this.prioritySectionElement(section)
				if (!element) {
					return
				}
				const rect = element.getBoundingClientRect()
				if (rect.bottom > rootRect.top && rect.top < rootRect.bottom) {
					this.mainStore.clearPriorityInboxNewMessagesMutation(section)
				}
			})
		},

		deleteMessage(id) {
			this.bus.emit('delete', id)
		},

		onScroll(event) {
			logger.debug('scroll', { event })

			this.bus.emit('load-more')
		},

		onShortcut(e) {
			// Priority Inbox stacks several Mailbox children. Broadcasting
			// refresh makes every child start its own sync wave; the parent
			// owns the exact, awaitable refresh for the composite view.
			if (this.mailbox.isPriorityInbox && e.srcKey === 'refresh') {
				void this.refreshCurrentView().catch((error) => {
					logger.error('Could not refresh Priority Inbox from shortcut', { error })
				})
				return
			}
			this.bus.emit('shortcut', e)
		},

		appendToSearch(str) {
			// followUpQuery is undefined when no follow-up tag exists on
			// the instance -- concatenating it produced the literal string
			// "... undefined", which the backend's query parser treats as
			// a free-text search term. That fired the heaviest query the
			// app has (threaded self-join + two recipients JOINs +
			// ILIKE '%undefined%') against every priority-inbox section
			// on every load: confirmed live as 16 concurrent copies each
			// running for 38-51 MINUTES on a 27k-message INBOX, pinning
			// the DB at 300% CPU and starving every other request -- the
			// actual root cause behind the recurring mailbox sync
			// 502s/504s attributed to "mailbox 149 being slow". Upstream
			// v5.10.9 doesn't have this guard at all -- kept in full.
			if (str === undefined || str === null) {
				return this.searchQuery
			}

			if (!this.searchQuery) {
				return str
			}

			if (this.sortFavorites && str === this.favoriteQuery && this.searchQuery.includes('not:starred')) {
				return this.searchQuery.replace('not:starred', str)
			}
			return this.searchQuery + ' ' + str
		},

		hideMessage() {
			this.$router.replace({
				name: 'mailbox',
				params: {
					mailboxId: this.$route.params.mailboxId,
					filter: this.$route.params?.filter,
				},
			})
		},

		handleMailto() {
			if (this.$route.name === 'message' && this.$route.params.threadId === 'mailto') {
				let accountId
				// Only preselect an account when we're not in a unified mailbox
				if (this.$route.params.accountId !== 0 && this.$route.params.accountId !== '0') {
					accountId = parseInt(this.$route.params.accountId, 10)
				}

				const body = detect(this.$route.query.body ?? '')

				this.mainStore.startComposerSession({
					data: {
						accountId,
						to: this.stringToRecipients(this.$route.query.to),
						cc: this.stringToRecipients(this.$route.query.cc),
						bcc: this.stringToRecipients(this.$route.query.bcc),
						subject: this.$route.query.subject || '',
						isHtml: body.format === 'html',
						bodyHtml: toHtml(body).value,
						bodyPlain: toPlain(body).value,
					},
				})
			}
		},

		async saveStartMailbox() {
			const currentStartMailboxId = this.mainStore.getPreference('start-mailbox-id')
			if (currentStartMailboxId === this.mailbox.databaseId) {
				return
			}
			logger.debug(`Saving folder ${this.mailbox.databaseId} as start folder`)

			try {
				await this.mainStore.savePreference({
					key: 'start-mailbox-id',
					value: this.mailbox.databaseId,
				})
			} catch (error) {
				// Catch and log. This is not critical.
				logger.warn('Could not update start folder id', {
					error,
				})
			}
		},

		stringToRecipients(str) {
			if (str === undefined) {
				return []
			}

			let addresses = []
			try {
				addresses = addressParser.parse(str)
			} catch (error) {
				logger.debug('could not parse string into email addresses', { str, error })
			}

			return addresses.map((address) => {
				const result = {
					label: address.name(),
					email: address.address,
				}

				if (result.label === '') {
					result.label = result.email
				}

				return result
			})
		},

		onUpdateSearchQuery(query) {
			const tokens = (query ?? '').split(/\s+/).filter(Boolean)
			// `not:starred` is structural Priority Inbox partitioning, not a
			// user search control, so SearchMessages correctly knows nothing
			// about it. Re-attach it to every canonical search query while the
			// separate-Favorites preference is active.
			if (this.mailbox.isPriorityInbox && this.sortFavorites && !tokens.includes('not:starred')) {
				tokens.push('not:starred')
			}
			this.searchQuery = tokens.join(' ') || undefined
			if (this.mailbox.isPriorityInbox) {
				this.mainStore.setCurrentPriorityInboxSearchQueryMutation(this.searchQuery)
			}
		},

		dismissBackfillBanner() {
			this.mainStore.dismissBackfillBannerMutation(this.mailbox.databaseId)
		},
	},
}
</script>

<style lang="scss" scoped>
.section-title {
	:deep(h2) {
		margin: 0 !important;
	}
}

:deep(.app-content-list) {
	flex: 1 1 auto;
	min-height: 0;
	overflow: scroll;
	width: 100% !important;
}

:deep(.app-content-wrapper) {
	display: flex;
	flex-direction: column;
	height: 100%;
	overflow: hidden;
}

.v-popover > .trigger > * {
	z-index: 1;
}

.section-header-info {
	max-width: 230px;
	padding: 16px;
}

.app-content-list {
	// Required for centering the loading indicator
	display: flex;
}

.app-content-list-item:hover {
	background: transparent;
}

.app-content-list-item {
	flex: 0;
}

.button {
	background-color: var(--color-main-background);
	margin-bottom: 3px;
	inset-inline-end: 2px;

	&:hover,
	&:focus {
		background-color: var(--color-background-dark);
	}
}

.envelope-list {
	flex: 1 1 auto;
	overflow-y: auto;
	min-height: 0;
	contain: none !important;
	// Suppresses the browser's own native pull-to-refresh/bounce at this
	// container's scroll boundaries so it doesn't race our own touch-driven
	// pull-to-refresh gesture (onPullToRefresh via util/pullToRefresh.js).
	overscroll-behavior-y: contain;
}

.load-more-sentinel {
	// Purely an IntersectionObserver target (see
	// util/loadMoreSentinelObserver.js) -- 1px tall so it's a real,
	// observable element rather than collapsing to nothing, invisible and
	// out of the way otherwise.
	height: 1px;
}

.information-icon {
	opacity: .7;
}
@media only screen and (max-width: 1024px) {
	.information-icon {
		margin-bottom: 20px;
	}
}

.list__wrapper {
	display: flex;
	flex: 1 1 auto;
	flex-direction: column;
	height: 100%;
	overflow: hidden;
	// Positioning context for the pull-to-refresh indicator below.
	position: relative;
}

// Material-style pull-to-refresh spinner: hidden at rest, it emerges from
// behind the top of the list and slides down as the user pulls (transform/
// opacity driven by util/pullToRefresh.js), spins in place while refreshing,
// then retracts. The list content itself does not move (the Android/web
// convention; iOS instead rubber-bands the content).
.pull-to-refresh-indicator {
	position: absolute;
	top: 0;
	inset-inline-start: 50%;
	margin-inline-start: calc(var(--default-clickable-area) / -2);
	opacity: 0;
	z-index: 100;
	pointer-events: none;
	display: flex;
	align-items: center;
	justify-content: center;
	width: var(--default-clickable-area);
	height: var(--default-clickable-area);
	border-radius: 50%;
	background-color: var(--color-main-background);
	box-shadow: 0 0 4px 0 var(--color-box-shadow);
}

:deep(.app-details-toggle) {
	opacity: 1;
}

:deep(.app-content-wrapper.app-content-wrapper--no-split.app-content-wrapper--show-details) {
	overflow-y: scroll !important;
}

// "Still importing older messages" status banner -- a quiet info bar at the
// very top of the folder (above every section), not an alert. Muted
// background/text so it reads as ambient status, not something demanding
// action.
.backfill-banner {
	display: flex;
	align-items: center;
	gap: var(--default-grid-baseline);
	padding: calc(var(--default-grid-baseline) * 2);
	padding-inline-start: calc(var(--default-grid-baseline) * 3);
	background-color: var(--color-background-hover);
	border-radius: var(--border-radius-element, var(--border-radius-large));
	margin: var(--default-grid-baseline);
	color: var(--color-text-maxcontrast);
	font-size: var(--default-font-size);

	&__spinner {
		flex: 0 0 auto;
	}

	&__text {
		flex: 1 1 auto;
		min-width: 0;
	}
}
</style>
