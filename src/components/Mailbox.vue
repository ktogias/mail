<!--
  - SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<div
		class="mailbox"
		:class="{ 'empty-content': (!hasMessages && !isLoadingList) || error }">
		<div
			v-if="deepSearchState"
			class="deep-search-banner"
			:class="{ 'deep-search-banner--failed': deepSearchState.status === 'failed' }"
			role="status">
			<IconLoading
				v-if="deepSearchState.status === 'running'"
				:size="18"
				class="deep-search-banner__spinner" />
			<span class="deep-search-banner__text">{{ deepSearchStatusText }}</span>
		</div>
		<Error
			v-if="error"
			:error="errorTitle"
			:message="errorMessage"
			role="alert" />
		<!-- A unified/Priority list is published progressively as each
		     constituent inbox answers. Keep the full skeleton only until
		     the first useful rows arrive; once they do, render them at once
		     while the slower accounts continue filling the list. -->
		<LoadingSkeleton v-else-if="isLoadingList && !hasMessages" :number-of-lines="skeletonLines" />
		<Loading
			v-else-if="loadingCacheInitialization"
			:hint="t('mail', 'Loading messages …')"
			:slow-hint="t('mail', 'Indexing your messages. This can take a bit longer for larger folders.')" />
		<EmptyMailboxSection v-else-if="(isPriorityInbox || searchQuery) && !hasMessages" key="empty" />
		<EmptyMailbox v-else-if="!hasMessages" key="empty" />
		<template v-else-if="hasGroupedEnvelopes && !isPriorityInbox">
			<div v-for="[label, group] in visibleGroupEnvelopes" :key="label">
				<SectionTitle class="section-title" :name="getLabelForGroup(label)" />
				<EnvelopeList
					:account="account"
					:mailbox="mailbox"
					:search-query="searchQuery"
					:envelopes="group"
					:loading-more="false"
					:load-more-button="false"
					:skip-transition="skipListTransition"
					@delete="onDelete" />
			</div>
		</template>
		<EnvelopeList
			v-else
			:account="account"
			:load-more-label="loadMoreLabel"
			:mailbox="mailbox"
			:search-query="searchQuery"
			:envelopes="visibleEnvelopesToShow"
			:loading-more="loadingMore || loadingEnvelopes"
			:load-more-button="showLoadMore"
			:collapse-button="showCollapse"
			:skip-transition="skipListTransition"
			@delete="onDelete"
			@load-more="loadMore"
			@collapse="collapse" />
	</div>
</template>

<script>
import { NcLoadingIcon as IconLoading } from '@nextcloud/vue'
import { mapStores } from 'pinia'
import { findIndex, propEq } from 'ramda'
import EmptyMailbox from './EmptyMailbox.vue'
import EmptyMailboxSection from './EmptyMailboxSection.vue'
import EnvelopeList from './EnvelopeList.vue'
import Error from './Error.vue'
import Loading from './Loading.vue'
import LoadingSkeleton from './LoadingSkeleton.vue'
import SectionTitle from './SectionTitle.vue'
import MailboxLockedError from '../errors/MailboxLockedError.js'
import MailboxNotCachedError from '../errors/MailboxNotCachedError.js'
import { matchError } from '../errors/match.js'
import NoTrashMailboxConfiguredError
	from '../errors/NoTrashMailboxConfiguredError.js'
import logger from '../logger.js'
import IdleTailTrimMixin from '../mixins/IdleTailTrimMixin.js'
import ReturnScrollAnchorMixin from '../mixins/ReturnScrollAnchorMixin.js'
import UndoableActionMixin from '../mixins/UndoableActionMixin.js'
import useMainStore from '../store/mainStore.js'
import { mailboxHasRights } from '../util/acl.js'
import { showError, showWarning } from '../util/toast.js'
import { wait } from '../util/wait.js'

export default {
	name: 'Mailbox',
	components: {
		EmptyMailboxSection,
		EmptyMailbox,
		EnvelopeList,
		Error,
		IconLoading,
		Loading,
		LoadingSkeleton,
		SectionTitle,
	},

	mixins: [UndoableActionMixin, IdleTailTrimMixin, ReturnScrollAnchorMixin],

	props: {
		groupEnvelopes: {
			type: Array,
			required: false,
			default: () => [],
		},

		loadMoreLabel: {
			type: String,
			default: undefined,
		},

		account: {
			type: Object,
			required: true,
		},

		mailbox: {
			type: Object,
			required: true,
		},

		bus: {
			type: Object,
			required: true,
		},

		paginate: {
			type: String,
			default: 'scroll',
		},

		initialPageSize: {
			type: Number,
			default: 20,
		},

		searchQuery: {
			type: String,
			required: false,
			default: undefined,
		},

		isPriorityInbox: {
			type: Boolean,
			required: false,
			default: false,
		},

		// Whether an expanded manual-paginate section can be shrunk back
		// to its initial page size with a "Show less" control -- the
		// inverse of "Load more". MailboxThread.vue was ALREADY passing
		// this for the Favorites/Follow-up/Important sections, but no such
		// prop existed here: once a section was expanded, the only way
		// back to the compact view was a full page reload (reported live).
		collapsible: {
			type: Boolean,
			required: false,
			default: false,
		},

		// Composite views may let their parent populate several structural
		// sections with one exact snapshot. Tests also use this to drive
		// loadEnvelopes()/initializeCache() explicitly.
		skipInitialLoad: {
			type: Boolean,
			required: false,
			default: false,
		},

		// Load the cached database view, but leave remote synchronization to
		// a parent coordinator. Priority Inbox uses this for Follow-up so its
		// Sent source does not compete with initial message content requests.
		skipInitialSync: {
			type: Boolean,
			required: false,
			default: false,
		},
	},

	data() {
		return {
			error: false,
			refreshing: false,
			loadingMore: false,
			loadingEnvelopes: false,
			loadingCacheInitialization: false,
			loadMailboxInterval: undefined,
			expanded: false,
			endReached: false,
			// The list length at which a refill last came back empty. Reset
			// with endReached, for the same reason: a different query has its
			// own supply of older messages.
			refillExhaustedAt: -1,
			loadMoreRequested: false,
			syncedMailboxes: new Set(),
			skipListTransition: false,
			// Aborts the previous loadEnvelopes() when a newer one starts
			// (e.g. the user refined a search term): the superseded
			// requests would otherwise keep occupying server workers and
			// their late responses would repaint over the newer results.
			loadEnvelopesAbortController: undefined,
		}
	},

	computed: {
		...mapStores(useMainStore),
		sortOrder() {
			return this.mainStore.getPreference('sort-order', 'newest')
		},

		/**
		 * Whether this list is waiting for rows it does not yet have.
		 *
		 * A Priority section cannot answer that from `loadingEnvelopes`: it is
		 * rendered with skip-initial-load, so this component never fetches and
		 * that flag stays false for its whole life. The page-level refresh in
		 * refreshPriorityInboxView() owns the request, so the section has to
		 * read its flag -- otherwise it falls straight through to the empty
		 * state and claims "No messages" while the fetch is still running.
		 *
		 * Reported live on 2026-07-27: five to six seconds of "Κανένα μήνυμα"
		 * under every section header on each reload, with the counts already
		 * filled in beside them from the independent stats request.
		 *
		 * @return {boolean} true while rows are still on their way
		 */
		isLoadingList() {
			return this.loadingEnvelopes
				|| (this.isPriorityInbox && this.mainStore.priorityInboxViewLoading)
		},

		/**
		 * A Priority section occupies a slice of one screen, not a whole one.
		 * Twenty skeleton rows per section pushed the sections below it out of
		 * sight and made the page jump when the real rows replaced them.
		 *
		 * @return {number} how many skeleton rows to draw
		 */
		skeletonLines() {
			return this.isPriorityInbox ? 3 : 20
		},

		deepSearchState() {
			if (!this.searchQuery) {
				return undefined
			}
			return this.mainStore.getDeepSearchState(this.mailbox.databaseId, this.searchQuery)
		},

		deepSearchStatusText() {
			if (this.deepSearchState?.status === 'running') {
				if (this.deepSearchState.chunksCompleted > 0) {
					return t('mail', 'Searching older messages in the background ({count} archive ranges checked) …', {
						count: this.deepSearchState.chunksCompleted,
					})
				}
				return t('mail', 'Searching older messages in the background …')
			}
			if (this.deepSearchState?.status === 'failed') {
				return t('mail', 'The search through older messages could not be completed.')
			}
			if (this.deepSearchState?.resultCount > 0) {
				return t('mail', 'Search through older messages complete. Older results were added.')
			}
			return t('mail', 'Search through older messages complete. No older matches were found.')
		},

		envelopes() {
			return this.mainStore.getEnvelopes(this.mailbox.databaseId, this.searchQuery)
		},

		envelopesToShow() {
			if (this.paginate === 'manual' && !this.expanded) {
				return this.envelopes.slice(0, this.initialPageSize)
			}
			return this.envelopes
		},

		// Envelopes pending an undoable delete/archive from a keyboard
		// shortcut (see UndoableActionMixin) are hidden here, immediately,
		// same reasoning as EnvelopeList.vue's own sortedEnvelops filter:
		// the message should look gone right away, not linger for the
		// full undo window just because nothing irreversible has actually
		// happened yet.
		visibleEnvelopesToShow() {
			return this.envelopesToShow.filter((envelope) => !this.isPendingUndo(envelope.databaseId))
		},

		// The same visibility rule must govern keyboard/header previous-next
		// navigation, not only row rendering. During the undo window the raw
		// store list intentionally still contains a deleted thread; allowing
		// navigation to use that raw list opened its stale route again and
		// produced a header with an empty message body.
		navigationEnvelopes() {
			return this.envelopes.filter((envelope) => !this.isPendingUndo(envelope.databaseId))
		},

		visibleGroupEnvelopes() {
			return this.groupEnvelopes.map(([label, group]) => [
				label,
				group.filter((envelope) => !this.isPendingUndo(envelope.databaseId)),
			])
		},

		hasGroupedEnvelopes() {
			return this.groupEnvelopes && this.groupEnvelopes.length > 0
		},

		hasMessages() {
			if (this.hasGroupedEnvelopes) {
				return this.groupEnvelopes.some(([, group]) => group.length > 0)
			}
			return this.envelopesToShow?.length > 0
		},

		showLoadMore() {
			return !this.endReached && this.paginate === 'manual'
		},

		// Only once there's genuinely something to hide: expanded, and
		// more envelopes loaded than the initial page would show.
		showCollapse() {
			return this.paginate === 'manual'
				&& this.collapsible
				&& this.expanded
				&& this.envelopes.length > this.initialPageSize
		},

		// A search-in-body term is the one search mode that isn't a local
		// database query -- it makes a live IMAP round-trip to the mail
		// server (see MailSearch::getIdsLocally() server-side), an order
		// of magnitude slower than everything else search does, and
		// prone to hit the server's 20s timeout on a large mailbox. The
		// generic "Could not open folder" left no way to tell that apart
		// from a genuine failure (confirmed live: a 504 on a body search
		// looked identical to any other broken folder).
		isBodySearchTimeout() {
			return this.error?.response?.status === 504 && (this.searchQuery ?? '').includes('body:')
		},

		errorTitle() {
			if (this.isBodySearchTimeout) {
				return this.t('mail', 'Message body search is taking too long')
			}
			return this.t('mail', 'Could not open folder')
		},

		errorMessage() {
			if (this.isBodySearchTimeout) {
				return this.t('mail', 'Searching message content contacts the mail server directly and can be slow on large mailboxes. Try again, or search without message content.')
			}
			return ''
		},
	},

	watch: {
		/**
		 * Top a collapsed section back up when rows leave it.
		 *
		 * Deleting already did this, through onDelete(). Nothing else did --
		 * so unmarking the first two of three Important messages left the
		 * section showing one until the next background tick replaced the
		 * whole page, seconds later. Reclassification is not the only cause
		 * either: a sync can report a message vanished, or a filter can stop
		 * matching it.
		 *
		 * Which is why this watches the LIST rather than hooking each cause.
		 * The component that renders the page is the one that knows it is
		 * short, and it does not need to know why.
		 *
		 * Only collapsed manual-paginate sections: an infinitely scrolled
		 * folder still has its next page behind the scroll sentinel, and
		 * losing one row out of twenty leaves no visible hole.
		 *
		 * @param {number} length how many envelopes the list holds now
		 * @param {number} previousLength how many it held before
		 */
		'envelopes.length': function(length, previousLength) {
			this.refillCollapsedSection(length, previousLength)
		},

		mailbox() {
			// endReached remembers "the PREVIOUS query's list had no more
			// pages" -- switching folders, changing the search query, or
			// changing sort order all mean a different result set is
			// about to be fetched from scratch, which may well have more
			// pages of its own. Without resetting it here, loadMore()'s
			// own guard (this.endReached, below) stays permanently true
			// from whatever query last exhausted it -- confirmed live:
			// searching "unread only" inside a mailbox until scrolling
			// reaches the end (correctly setting endReached), then
			// clearing the search, left scroll-triggered pagination
			// silently doing nothing for the rest of the session, even
			// though the unfiltered mailbox has plenty more older
			// messages to load.
			this.endReached = false
			this.refillExhaustedAt = -1
			this.loadEnvelopes()
				.then(() => {
					logger.debug(`syncing mailbox ${this.mailbox.databaseId} (${this.query}) after folder change`)
					this.sync(false)
				})
		},

		searchQuery() {
			this.endReached = false
			this.loadEnvelopes()
		},

		sortOrder() {
			this.endReached = false
			this.loadEnvelopes()
		},
	},

	created() {
		this.bus.on('load-more', this.onScroll)
		this.bus.on('priority-inbox-view-replaced', this.onPriorityInboxViewReplaced)
		this.bus.on('delete', this.onDelete)
		this.bus.on('archive', this.onArchive)
		this.bus.on('shortcut', this.handleShortcut)
		this.loadMailboxInterval = setInterval(this.loadMailbox, 60000)
	},

	async mounted() {
		if (this.skipInitialLoad) {
			return
		}

		// Cold boot landing directly on a specific thread (a hard
		// refresh, a bookmarked/shared thread URL): Thread.vue mounts at
		// roughly the same moment as this component and fires its own
		// thread/html/body fetches. Without this, this folder's listing
		// fetch competes with those for the same handful of mail FPM
		// workers at the exact same instant. A short head start here
		// lets the thread's requests get issued and queued first,
		// instead of racing for the pool. Confirmed live via HAR + docker
		// stats: a burst of ~23 concurrent requests on a hard refresh
		// queued behind each other on a 4-worker pool while the DB
		// container was itself CPU-saturated, and the thread's own /html
		// fetch was among the ones still queued when nginx's upstream
		// read timeout hit -- a genuine 504, not a frontend rendering
		// issue. Deliberately short (not the full interaction-priority
		// window): this only needs to win the race to be queued first,
		// not to fully finish first. Applied per instance, not gated on
		// hasFetchedInitialEnvelopes below: every simultaneously-mounting
		// section sharing the same open thread (e.g. Priority Inbox's
		// Favorites/Follow-up/Important/Other) should equally defer to
		// it, and they run concurrently anyway, so this costs one ~300ms
		// wait overall, not one per section.
		if (this.$route.params.threadId) {
			this.mainStore.setInteractionPriorityMutation()
			await wait(300)
		}

		// By default every standalone Mailbox instance owns its cached load
		// and remote sync. A parent-owned composite section can opt out of
		// the remote phase without reviving the old global
		// hasFetchedInitialEnvelopes gate that skipped unrelated instances.
		await this.loadEnvelopes()
		if (!this.skipInitialSync) {
			logger.debug(`syncing folder ${this.mailbox.databaseId} (${this.searchQuery}) after mount`)
			await this.sync(false)
		}

		// prefetchOtherMailboxes(), unlike the two calls above, speculatively
		// warms the cache for every OTHER subscribed mailbox in this same
		// account -- every simultaneously-mounted sibling instance would
		// enumerate and prefetch the exact same set, so this part alone is
		// genuinely meant to run once per account per session, not once per
		// instance. Claiming the flag synchronously, before the first
		// `await` inside the guard, is what actually makes this race-free:
		// nothing yields between the check and the set, so whichever
		// instance's mounted() reaches this line first (in program order,
		// not wall-clock time) is the only one that ever sees it as false.
		if (!this.mainStore.hasFetchedInitialEnvelopes) {
			this.mainStore.setHasFetchedInitialEnvelopesMutation(true)
			await this.prefetchOtherMailboxes()
		}
	},

	destroyed() {
		this.bus.off('load-more', this.onScroll)
		this.bus.off('priority-inbox-view-replaced', this.onPriorityInboxViewReplaced)
		this.bus.off('delete', this.onDelete)
		this.bus.off('archive', this.onArchive)
		this.bus.off('shortcut', this.handleShortcut)
		this.stopInterval()
		this.loadEnvelopesAbortController?.abort()
	},

	methods: {
		initializeCache() {
			this.loadingCacheInitialization = true
			this.error = false

			logger.debug(`syncing folder ${this.mailbox.databaseId} (${this.query}) during cache initalization`)
			// Missing `return` and `.catch()` here previously meant: (1) the
			// caller's `await this.initializeCache()` awaited `undefined`,
			// not this chain, so its own try/catch never engaged either;
			// (2) if the forced sync failed for ANY reason -- a lock
			// conflict from a second bucket racing the same mailbox's
			// initial sync is a completely ordinary occurrence, not an edge
			// case -- the `.then()` that clears loadingCacheInitialization
			// never ran. Nothing else ever resets that flag, so the
			// "Loading messages…" screen stayed up forever, even after the
			// mailbox got cached moments later by the racing caller or a
			// background poller. Confirmed live on ktogias@isi.gr's Junk
			// folder: a 409 on the forced sync, then indefinite loading
			// with zero further envelope fetches for that view.
			return this.sync(true)
				.then(() => {
					this.loadingCacheInitialization = false

					return this.loadEnvelopes()
				})
				.catch((error) => {
					this.loadingCacheInitialization = false
					throw error
				})
		},

		async loadEnvelopes() {
			// Opening/switching a folder is a direct user action -- give
			// it priority over the background watched-mailbox poller (see
			// setInteractionPriorityMutation() in the store). Deliberately
			// NOT armed in loadMailbox() below, which is the 60s
			// background-refresh interval, not a user action.
			this.mainStore.setInteractionPriorityMutation()
			logger.debug(`Fetching envelopes for folder ${this.mailbox.databaseId} (${this.searchQuery})`, this.mailbox)
			if (!this.syncedMailboxes.has(this.mailbox.databaseId + (this.searchQuery ?? ''))) {
				// Only trigger skeleton if we didn't sync envelopes yet
				this.loadingEnvelopes = true
			} else {
				this.skipListTransition = true
				this.$nextTick(() => {
					this.skipListTransition = false
				})
			}

			this.loadingCacheInitialization = false
			this.error = false

			this.loadEnvelopesAbortController?.abort()
			const abortController = new AbortController()
			this.loadEnvelopesAbortController = abortController

			try {
				const envelopes = await this.mainStore.fetchEnvelopes({
					mailboxId: this.mailbox.databaseId,
					query: this.searchQuery,
					limit: this.initialPageSize,
					signal: abortController.signal,
				})

				logger.debug(envelopes.length + ' envelopes fetched', { envelopes })

				this.syncedMailboxes.add(this.mailbox.databaseId + (this.searchQuery ?? ''))
				this.loadingEnvelopes = false
			} catch (error) {
				if (abortController.signal.aborted) {
					// Superseded by a newer loadEnvelopes() (or the
					// component was destroyed) -- the newer call owns the
					// loading/error state now, don't touch it.
					return
				}
				if (error?.code === 'ERR_CANCELED') {
					// The request coordinator declined to run this fetch --
					// offline, connectivity recovering, speculative work shed
					// under foreground pressure, or a stale running request
					// reclaimed (see RequestCoordinator's cancellationError()).
					// That is a deliberate scheduling decision about WHEN to
					// fetch, not evidence that the folder is broken, and the
					// component's own AbortController is not involved, so the
					// guard above does not cover it.
					//
					// Confirmed live on 2026-07-26: two section fetches were
					// cancelled during a resume burst (nginx logged them as
					// 499, every server-side request in the window returned
					// 200), and the Favorites section rendered "Could not open
					// folder" from then on.
					logger.debug(`Envelope fetch for folder ${this.mailbox.databaseId} (${this.searchQuery}) was cancelled by the request coordinator`, { error })
					this.loadingEnvelopes = false
					return
				}
				await matchError(error, {
					[MailboxLockedError.getName()]: async (error) => {
						logger.info(`Mailbox ${this.mailbox.databaseId} (${this.searchQuery}) is locked`, { error })
						await wait(15 * 1000)
						// Keep trying
						await this.loadEnvelopes()
					},
					[MailboxNotCachedError.getName()]: async (error) => {
						logger.info(`Mailbox ${this.mailbox.databaseId} (${this.searchQuery}) not cached. Triggering initialization`, { error })
						this.loadingEnvelopes = false

						try {
							await this.initializeCache()
						} catch (error) {
							logger.error(`Could not initialize cache of folder ${this.mailbox.databaseId} (${this.searchQuery})`, { error })
							this.error = error
						}
					},
					default: (error) => {
						logger.error(`Could not fetch envelopes of folder ${this.mailbox.databaseId} (${this.searchQuery})`, { error })
						this.loadingEnvelopes = false
						this.error = error
					},
				})
			}
		},

		async loadMore() {
			if (!this.expanded && this.envelopesToShow.length < this.envelopes.length) {
				logger.debug('expanding envelope list')
				this.expanded = true
				return
			}

			// Neither guard existed before (confirmed identical upstream) --
			// scroll-triggered pagination relied entirely on network latency
			// to naturally pace repeated calls, which stopped being true
			// once other fixes made real syncs/fetches noticeably faster:
			// confirmed live, Priority Inbox appended pages with no visible
			// limit while scrolling. loadingMore already existed as state
			// but was never actually consulted before firing again; endReached
			// was only ever read by the MANUAL button's visibility
			// (showLoadMore), never by this, the scroll-triggered path.
			if (this.loadingMore) {
				// Re-arming the sentinel after a list refresh can intersect
				// while the previous page request is still settling. Keep one
				// trailing request instead of losing that only observer event.
				this.loadMoreRequested = true
				logger.debug('loadMore() already in flight, queueing one trailing attempt')
				return
			}
			if (this.endReached) {
				logger.debug('loadMore() already in flight or the list is exhausted, ignoring')
				return
			}

			logger.debug('fetching next envelope page')
			this.loadingMore = true

			try {
				const envelopes = await this.mainStore.fetchNextEnvelopePage({
					mailboxId: this.mailbox.databaseId,
					query: this.searchQuery,
				})
				if (envelopes.length === 0) {
					logger.info('envelope list end reached')
					this.endReached = true
				}
			} catch (error) {
				// An incomplete fan-out is not evidence about the list: a
				// source was cancelled or failed, so we do not know whether
				// older messages exist. Marking the list exhausted here ended
				// scrolling permanently until the component was recreated.
				//
				// Confirmed live on 2026-07-27: during a stall two constituent
				// page fetches were cancelled, the assembled page jumped from
				// today straight to May, and the list would not scroll again.
				if (error?.mailPageIncomplete) {
					// Deliberately NOT re-queued here: the finally block below
					// re-runs loadMore() whenever loadMoreRequested is set, so
					// retrying from this catch spins on a persistent failure
					// with no backoff at all. Leaving endReached false is
					// enough -- the next scroll or "Load more" tap tries again.
					logger.debug('next envelope page was incomplete; not treating it as the end of the list', { error })
				} else {
					logger.error('could not fetch next envelope page', { error })
				}
			} finally {
				this.loadingMore = false
				if (this.loadMoreRequested) {
					this.loadMoreRequested = false
					this.loadMore()
				}
			}
		},

		onPriorityInboxViewReplaced() {
			if (!this.isPriorityInbox) {
				return
			}
			// The same query now has a new authoritative head. A previous
			// empty pagination result is no longer sufficient evidence that
			// this refreshed result set has no older page.
			this.endReached = false

			// A section that failed to load stayed failed forever: this
			// component only fetches from created() and from the mailbox/
			// searchQuery/sortOrder watchers, so neither a tab resume, nor
			// pull-to-refresh, nor this very view refresh ever retried it.
			// Confirmed live on 2026-07-26: the Favorites section showed
			// "Could not open folder" across two resumes and a manual
			// refresh while every server request returned 200 and the
			// counters beside it kept updating normally.
			//
			// A refresh is exactly the moment to try again, so a transient
			// failure heals itself instead of needing a full page reload.
			if (this.error) {
				this.loadEnvelopes()
			}
		},

		// The inverse of loadMore()'s expand step: shrink the section back
		// to its initial page size. The already-fetched tail stays in the
		// store (re-expanding is instant, and the idle-tail-trim mechanism
		// handles its memory in due course) -- this only changes what's
		// rendered. Collapsing removes dozens of rows at once, so the
		// transition-group leave animation is suppressed for the same
		// reason trimIdleTailNow() suppresses it.
		collapse() {
			this.skipListTransition = true
			this.expanded = false
			this.$nextTick(() => {
				this.skipListTransition = false
			})
		},

		async prefetchOtherMailboxes() {
			for (const mailbox of this.mainStore.getRecursiveMailboxIterator(this.account.id)) {
				if (mailbox.databaseId === this.mailbox.databaseId) {
					continue
				}

				if (!mailbox.isSubscribed) {
					continue
				}

				try {
					const envelopes = await this.mainStore.fetchEnvelopes({
						mailboxId: mailbox.databaseId,
						limit: this.initialPageSize,
						includeCacheBuster: true,
					})
					this.syncedMailboxes.add(mailbox.databaseId + (this.searchQuery ?? ''))
					logger.debug(`Prefetched ${envelopes.length} envelopes for folder ${mailbox.displayName} (${mailbox.databaseId})`)
				} catch (error) {
					if (error instanceof MailboxNotCachedError) {
						// Just ignore
						continue
					}

					logger.error(`Failed to prefetch envelopes for folder ${mailbox.displayName} (${mailbox.databaseId}): ${error}`, {
						error,
					})
				}
			}
		},

		hasDeleteAcl() {
			return mailboxHasRights(this.mailbox, 'x')
		},

		hasSeenAcl() {
			return mailboxHasRights(this.mailbox, 's')
		},

		hasArchiveAcl() {
			return mailboxHasRights(this.mailbox, 'te')
		},

		async handleShortcut(e) {
			const envelopes = this.navigationEnvelopes
			const currentId = parseInt(this.$route.params.threadId, 10)

			const env = envelopes.find((e) => e.databaseId === currentId)
			const idx = envelopes.indexOf(env)
			let next

			if (e.srcKey !== 'refresh' && !env) {
				logger.debug('envelope is not in the list, ignoring shortcut', {
					srcKey: e.srcKey,
				})
				return
			}

			switch (e.srcKey) {
				case 'next':
				case 'prev':
					if (e.srcKey === 'next') {
						next = envelopes[idx + 1]
					} else {
						next = envelopes[idx - 1]
					}

					if (!next) {
						logger.debug('ignoring shortcut: head or tail of envelope list reached', {
							envelopes,
							idx,
							srcKey: e.srcKey,
						})
						return
					}

					// Keep the selected account-mailbox combination, but navigate to a different message
					// (it's not a bug that we don't use next.accountId and next.mailboxId here)
					this.mainStore.setLastOpenedFromListMutation({
						mailboxId: this.mailbox.databaseId,
						query: this.searchQuery,
						databaseId: next.databaseId,
					})
					this.$router.push({
						name: 'message',
						params: {
							mailboxId: this.$route.params.mailboxId,
							filter: this.$route.params.filter ? this.$route.params.filter : undefined,
							threadId: next.databaseId,
						},
					})
					break
				case 'del':
					if (!this.hasDeleteAcl()) {
						return
					}
					logger.debug('deleting', { env })
					this.onDelete(env.databaseId)
					// Not awaited: same reasoning as EnvelopeList.vue's
					// deleteAllSelected() -- the real delete is deferred
					// behind an undo window (UndoableActionMixin), and
					// shouldn't block navigating to the next/prev message,
					// which onDelete() above already handles immediately.
					this.performActionWithUndo({
						ids: [env.databaseId],
						message: t('mail', 'Message deleted'),
						action: async () => {
							await this.mainStore.deleteThread({
								envelope: env,
							})
						},
					}).catch(async (error) => {
						logger.error('could not delete envelope', {
							env,
							error,
						})

						showError(await matchError(error, {
							[NoTrashMailboxConfiguredError.getName()]() {
								return t('mail', 'No trash folder configured')
							},
							default() {
								return t('mail', 'Could not delete message')
							},
						}))
					})

					break
				case 'arch': {
					logger.debug('archiving via shortcut')

					// In unified mailboxes this.account is the unified account which
					// has no archive mailbox, so resolve the envelope's actual account
					const account = this.mainStore.getAccount(env.accountId)

					if (account.archiveMailboxId === null) {
						showWarning(t('mail', 'To archive a message please configure an archive folder in account settings'))
						return
					}

					if (!this.hasArchiveAcl()) {
						showWarning(t('mail', 'You are not allowed to move this message to the archive folder and/or delete this message from the current folder'))
						return
					}

					if (env.mailboxId === account.archiveMailboxId) {
						logger.debug('message is already in archive folder')
						return
					}

					logger.debug('archiving', { env })
					this.onDelete(env.databaseId)
					// destMailboxId reads the locally-resolved `account` (the
					// envelope's own account, above) -- NOT this.account, which
					// in a unified mailbox is the unified pseudo-account with no
					// archive folder of its own. Merge conflict with upstream's
					// own fix for the same reference (see the comment above)
					// surfaced that our own undo-window wrapping had
					// accidentally regressed to `this.account.archiveMailboxId`
					// here; keeping the undo support, fixing the reference.
					this.performActionWithUndo({
						ids: [env.databaseId],
						message: t('mail', 'Message archived'),
						action: async () => {
							await this.mainStore.moveThread({
								envelope: env,
								destMailboxId: account.archiveMailboxId,
							})
						},
					}).catch((error) => {
						logger.error('could not archive envelope', {
							env,
							error,
						})

						showError(t('mail', 'Could not archive message'))
					})
					break
				}
				case 'flag':
					logger.debug('flagging envelope via shortkey', { env })
					// The shortcut acts on the focused ROW, so it means what the
					// row means -- same action the row's own star icon uses.
					this.mainStore.markEnvelopeFavoriteOrUnfavorite({
						envelope: env,
						favFlag: !env.flags.flagged,
					}).catch((error) => logger.error('could not flag envelope via shortkey', {
						env,
						error,
					}))
					break
				case 'refresh':
					logger.debug(`syncing folder ${this.mailbox.databaseId} (${this.searchQuery}) per shortcut`)
					this.sync(false)

					break
				case 'unseen':
					logger.debug('marking as seen/unseen via shortcut')

					if (!this.hasSeenAcl()) {
						showWarning(t('mail', 'Your IMAP server does not support storing the seen/unseen state.'))
						return
					}

					logger.debug('marking as seen/unseen', { env })
					try {
						await this.mainStore.toggleEnvelopeSeen({ envelope: env })
					} catch (error) {
						logger.error('could not mark envelope as seen/unseen via shortkey', {
							env,
							error,
						})
						showError(t('mail', 'Could not mark message as seen/unseen'))
					}
					break
				default:
					logger.warn('shortcut ' + e.srcKey + ' is unknown. ignoring.')
			}
		},

		async sync(init = false) {
			if (this.refreshing) {
				logger.debug(`already sync'ing folder ${this.mailbox.databaseId} (${this.searchQuery}), aborting`, { init })
				return
			}

			this.refreshing = true
			try {
				await this.mainStore.syncEnvelopes({
					mailboxId: this.mailbox.databaseId,
					query: this.searchQuery,
					init,
				})
			} catch (error) {
				matchError(error, {
					[MailboxLockedError.getName()](error) {
						logger.info('Background sync failed because the folder is locked', {
							error,
							init,
						})
					},
					default(error) {
						logger.error('Could not sync envelopes: ' + error.message, {
							error,
							init,
						})
					},
				})
				throw error
			} finally {
				this.refreshing = false
				logger.debug(`finished sync'ing folder ${this.mailbox.databaseId} (${this.searchQuery})`, { init })

				this.mainStore.updateSyncTimestamp()
			}
		},

		// onDelete(id): Load more message and navigate to other message if needed
		// id: The id of the message being delete
		refillCollapsedSection(length, previousLength) {
			if (length >= previousLength || this.paginate !== 'manual' || this.expanded) {
				return
			}
			if (this.endReached || length >= this.initialPageSize) {
				return
			}
			// A refill that came back with nothing means the section really is
			// this short; asking again on every further removal would be one
			// wasted round trip per click.
			if (length <= this.refillExhaustedAt) {
				return
			}
			const quantity = this.initialPageSize - length
			this.mainStore.scheduleEnvelopeRefill({
				mailboxId: this.mailbox.databaseId,
				query: this.searchQuery,
				quantity,
			}).then((envelopes) => {
				if (!envelopes || envelopes.length === 0) {
					this.refillExhaustedAt = length
				}
			}).catch((error) => {
				logger.debug('deferred section refill failed', { error })
			})
		},

		onDelete(id) {
			// Several deletes in one gesture used to issue one independent
			// cross-account `limit=1` fan-out each. Coalesce a short burst into
			// one low-priority refill for the total number removed; navigation
			// below stays immediate and never waits for it.
			this.mainStore.scheduleEnvelopeRefill({
				mailboxId: this.mailbox.databaseId,
				query: this.searchQuery,
				quantity: 1,
			}).catch((error) => {
				logger.debug('deferred envelope-list refill failed', { error })
			})
			// Locate the removed row in the raw list: it has already entered
			// the shared pending-removal set synchronously, so it is correctly
			// absent from navigationEnvelopes by the time this event arrives.
			const idx = findIndex(propEq(id, 'databaseId'), this.envelopes)
			if (idx === -1) {
				logger.debug('envelope to delete does not exist in envelope list')
				return
			}
			if (id !== this.$route.params.threadId) {
				logger.debug('other message open, not jumping to the next/previous message')
				return
			}

			// Where to go after the open message is removed. Directions are
			// sort-agnostic: "next"/"previous" mean the neighbour below/above in
			// the list as currently sorted, each falling back to the other end
			// when there's no neighbour that way; "list" returns to the mailbox.
			const autoAdvance = this.mainStore.getPreference('auto-advance', 'next')
			const navigableBefore = this.envelopes
				.slice(0, idx)
				.filter((envelope) => !this.isPendingUndo(envelope.databaseId))
			const navigableAfter = this.envelopes
				.slice(idx + 1)
				.filter((envelope) => !this.isPendingUndo(envelope.databaseId))
			const next = autoAdvance === 'previous'
				? (navigableBefore[navigableBefore.length - 1] ?? navigableAfter[0])
				: (navigableAfter[0] ?? navigableBefore[navigableBefore.length - 1])
			if (autoAdvance === 'list' || !next) {
				// Replace the deleted thread's history entry. Browser Back
				// must not resurrect a route whose content is intentionally
				// gone (or merely hidden during the undo window).
				this.$router.replace({
					name: 'mailbox',
					params: {
						mailboxId: this.$route.params.mailboxId,
						filter: this.$route.params.filter ? this.$route.params.filter : undefined,
					},
				})
				return
			}

			// Keep the selected mailbox, but navigate to a different message
			// (it's not a bug that we don't use next.mailboxId here)
			this.mainStore.setLastOpenedFromListMutation({
				mailboxId: this.mailbox.databaseId,
				query: this.searchQuery,
				databaseId: next.databaseId,
			})
			this.$router.replace({
				name: 'message',
				params: {
					mailboxId: this.$route.params.mailboxId,
					filter: this.$route.params.filter ? this.$route.params.filter : undefined,
					threadId: next.databaseId,
				},
			})
		},

		onScroll() {
			if (this.paginate !== 'scroll') {
				logger.debug('ignoring scroll pagination')
				return
			}

			this.loadMore()
		},

		async loadMailbox() {
			// When the account is unified or inbox, return nothing, else sync the mailbox
			if (this.account.isUnified || this.mailbox.specialRole === 'inbox') {
				return
			}
			try {
				logger.debug(`syncing folder ${this.mailbox.databaseId} (${this.searchQuery}) in background`)
				await this.sync(false)
			} catch (error) {
				logger.error('Background sync failed: ' + error.message, { error })
			}
		},

		stopInterval() {
			clearInterval(this.loadMailboxInterval)
			this.loadMailboxInterval = undefined
		},

		getLabelForGroup(group) {
			switch (group) {
				case 'lastHour':
					return t('mail', 'Last hour')
				case 'today':
					return t('mail', 'Today')
				case 'yesterday':
					return t('mail', 'Yesterday')
				case 'lastWeek':
					return t('mail', 'Last week')
				case 'lastMonth':
					return t('mail', 'Last month')
				default:
					return group
			}
		},
	},
}
</script>

<style lang="scss" scoped>
// height: 100% here (unconditional, since :class only ADDS
// 'empty-content' on top of this always-present class) made every
// single Mailbox instance -- including each of the priority inbox's
// four stacked sections -- fight to be 100% of .app-content-list's
// own height, an ambiguous quantity: that ancestor (Nextcloud core)
// is itself an auto-sized flex column with max-height/overflow-y:auto,
// not a fixed height. A percentage height on a flex item inside an
// indeterminate-height flex container is a well-known, browser-
// inconsistent CSS footgun, particularly across incremental reflows
// (adding rows via "Load more", a resize-driven layout-mode switch)
// vs. a full one -- confirmed live as envelope rows permanently
// overlapping, present even on a fresh hard refresh (so not a
// transition/timing issue), fixed by an actual window resize (forces
// a full flex recalculation) but not by scrolling (touches no flex
// sizing at all). The empty/error state's own centering already has
// its own height: 100% below -- this rule was redundant there and
// actively harmful for the normal, non-empty case.

// Fix vertical space between sections in priority inbox
.nameimportant {
	:deep(#load-more-mail-messages) {
		margin-top: 0;
	}
}

.empty-content {
	height: 100%;
	display: flex;
	justify-content: center;
}

// Durable archive-search progress belongs to the individual query section,
// while the unrelated mailbox-backfill banner lives in MailboxThread above
// all sections. Keep the two status surfaces visually consistent without
// coupling their component-scoped styles.
.deep-search-banner {
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

	&--failed {
		color: var(--color-error-text);
	}
}
</style>
