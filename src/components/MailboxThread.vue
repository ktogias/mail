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
						:mailbox="mailbox"
						:account-id="account.accountId"
						@search-changed="onUpdateSearchQuery" />
				</div>
				<AppContentList
					v-shortkey.once="shortkeys"
					class="envelope-list"
					:show-details="showThread"
					role="heading"
					:aria-level="2"
					@shortkey.native="onShortcut">
					<template v-if="!mailbox.isPriorityInbox">
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
							:search-query="appendToSearch(favoriteQuery)"
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
							:search-query="appendToSearch(favoriteQuery)"
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
							paginate="manual"
							:is-priority-inbox="true"
							:initial-page-size="followUpMessagesInitialPageSize"
							:collapsible="true"
							:bus="bus" />
						<div v-show="hasImportantEnvelopes" class="app-content-list-item">
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
							:search-query="appendToSearch(priorityImportantQuery)"
							paginate="manual"
							:is-priority-inbox="true"
							:initial-page-size="importantMessagesInitialPageSize"
							:collapsible="true"
							:bus="bus" />
						<SectionTitle
							v-show="hasOtherEnvelopes"
							class="app-content-list-item section-title other"
							:name="t('mail', 'Other')" />
						<Mailbox
							v-show="hasOtherEnvelopes"
							class="nameother"
							:load-more-label="t('mail', 'Load more other messages')"
							:account="unifiedAccount"
							:mailbox="unifiedInbox"
							:search-query="appendToSearch(priorityOtherQuery)"
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
import { NcAppContent as AppContent, NcAppContentList as AppContentList, NcButton as ButtonVue, isMobile, NcPopover } from '@nextcloud/vue'
import addressParser from 'address-rfc2822'
import mitt from 'mitt'
import { mapStores } from 'pinia'
import IconInfo from 'vue-material-design-icons/InformationOutline.vue'
import EmptyMailboxSection from './EmptyMailboxSection.vue'
import Mailbox from './Mailbox.vue'
import NoMessageSelected from './NoMessageSelected.vue'
import SearchMessages from './SearchMessages.vue'
import SectionTitle from './SectionTitle.vue'
import Thread from './Thread.vue'
import logger from '../logger.js'
import LoadMoreSentinelMixin from '../mixins/LoadMoreSentinelMixin.js'
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
	priorityOtherQuery,
} from '../util/priorityInbox.js'
import { detect, toHtml, toPlain } from '../util/text.js'

const START_MAILBOX_DEBOUNCE = 5 * 1000

export default {
	name: 'MailboxThread',

	components: {
		AppContent,
		AppContentList,
		ButtonVue,
		EmptyMailboxSection,
		IconInfo,
		Mailbox,
		NoMessageSelected,
		NcPopover,
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
				return this.mainStore.getEnvelopes(this.mailbox.databaseId, this.appendToSearch(priorityImportantQuery)).length > 0
					|| this.mainStore.getEnvelopes(this.mailbox.databaseId, this.appendToSearch(priorityOtherQuery)).length > 0
			}
			return this.mainStore.getEnvelopes(this.mailbox.databaseId, this.query).length > 0
		},

		// The has*Envelopes computeds gate each section's v-show. They
		// deliberately count an in-flight fetch as "has": with a pending
		// search every section's list is empty, so all sections (and the
		// loading skeletons inside their Mailbox components) used to be
		// hidden at once -- the user typed a term and stared at a blank
		// white list until the results landed.
		hasImportantEnvelopes() {
			const query = this.appendToSearch(this.priorityImportantQuery)
			if (this.mainStore.isFetchingEnvelopes(this.unifiedInbox.databaseId, query)) {
				return true
			}
			const map = this.mainStore.getEnvelopes(this.unifiedInbox.databaseId, query)
			const envelopes = Array.isArray(map) ? map : Array.from(map?.values() || [])
			return envelopes.length > 0
		},

		hasOtherEnvelopes() {
			const query = this.appendToSearch(this.priorityOtherQuery)
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

		hasFavoriteEnvelopes() {
			if (!this.sortFavorites) {
				return false
			}
			const mailbox = this.mailbox.isPriorityInbox ? this.unifiedInbox : this.mailbox
			const query = this.appendToSearch(this.favoriteQuery)
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
	},

	watch: {
		async $route(to) {
			// The store can't read the router directly (importing it
			// installs vue-router globally, which breaks $route mocking
			// in every component test) -- mirror the open mailbox into
			// the store for its view-aware decisions instead.
			this.mainStore.setCurrentViewMailboxIdMutation(to.params?.mailboxId)
			this.handleMailto()
			if (to.name === 'mailbox' && to.params.mailboxId === PRIORITY_INBOX_ID) {
				await this.onPriorityMailboxOpened()
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
				// Upstream fixed the same bug independently (569dfa45c);
				// kept its more defensive else-branch below (optional
				// chaining plus trimming back to undefined) over this
				// fork's original, which could throw on an unset
				// searchQuery and left a stray empty string behind.
				this.searchQuery = this.searchQuery ? (this.searchQuery + ' not:starred') : 'not:starred'
			} else if (this.searchQuery?.includes('not:starred')) {
				this.searchQuery = this.searchQuery.replace('not:starred', '').trim() || undefined
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
	},

	created() {
		this.mainStore.setCurrentViewMailboxIdMutation(this.$route?.params?.mailboxId)
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
	},

	beforeDestroy() {
		clearTimeout(this.startMailboxTimer)
		this.unregisterLoadMoreSentinel()
	},

	methods: {
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

		async onPriorityMailboxOpened() {
			logger.debug('Priority inbox was opened')

			await this.mainStore.checkFollowUpReminders({ query: this.followUpQuery })
		},

		deleteMessage(id) {
			this.bus.emit('delete', id)
		},

		onScroll(event) {
			logger.debug('scroll', { event })

			this.bus.emit('load-more')
		},

		onShortcut(e) {
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
			// 502s/504s attributed to "mailbox 149 being slow".
			if (str === undefined || str === null) {
				return this.searchQuery
			}

			// Upstream's !this.searchQuery (catches '' and null too, not
			// just undefined) is more defensive than this fork's original
			// strict-equality check; adopted it on merge.
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
			this.searchQuery = query
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
}

:deep(.app-details-toggle) {
	opacity: 1;
}

:deep(.app-content-wrapper.app-content-wrapper--no-split.app-content-wrapper--show-details) {
	overflow-y: scroll !important;
}
</style>
