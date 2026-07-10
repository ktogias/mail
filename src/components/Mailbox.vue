<!--
  - SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<div class="mailbox"
		:class="{ 'empty-content': (!hasMessages && !loadingEnvelopes) || error }">
		<Error
			v-if="error"
			:error="t('mail', 'Could not open folder')"
			message=""
			role="alert" />
		<LoadingSkeleton v-else-if="loadingEnvelopes" :number-of-lines="20" />
		<Loading
			v-else-if="loadingCacheInitialization"
			:hint="t('mail', 'Loading messages …')"
			:slow-hint="t('mail', 'Indexing your messages. This can take a bit longer for larger folders.')" />
		<EmptyMailboxSection v-else-if="(isPriorityInbox || searchQuery) && !hasMessages" key="empty" />
		<EmptyMailbox v-else-if="!hasMessages" key="empty" />
		<template v-else-if="hasGroupedEnvelopes && !isPriorityInbox">
			<div v-for="[label, group] in groupEnvelopes" :key="label">
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
			:envelopes="envelopesToShow"
			:loading-more="loadingMore"
			:load-more-button="showLoadMore"
			:skip-transition="skipListTransition"
			@delete="onDelete"
			@load-more="loadMore" />
	</div>
</template>

<script>
import { showError, showWarning } from '@nextcloud/dialogs'
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
import useMainStore from '../store/mainStore.js'
import { mailboxHasRights } from '../util/acl.js'
import { wait } from '../util/wait.js'

export default {
	name: 'Mailbox',
	components: {
		EmptyMailboxSection,
		EmptyMailbox,
		EnvelopeList,
		Error,
		Loading,
		LoadingSkeleton,
		SectionTitle,
	},

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

		envelopes() {
			return this.mainStore.getEnvelopes(this.mailbox.databaseId, this.searchQuery)
		},

		envelopesToShow() {
			if (this.paginate === 'manual' && !this.expanded) {
				return this.envelopes.slice(0, this.initialPageSize)
			}
			return this.envelopes
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
	},

	watch: {
		mailbox() {
			this.loadEnvelopes()
				.then(() => {
					logger.debug(`syncing mailbox ${this.mailbox.databaseId} (${this.query}) after folder change`)
					this.sync(false)
				})
		},

		searchQuery() {
			this.loadEnvelopes()
		},

		sortOrder() {
			this.loadEnvelopes()
		},
	},

	created() {
		this.bus.on('load-more', this.onScroll)
		this.bus.on('delete', this.onDelete)
		this.bus.on('archive', this.onArchive)
		this.bus.on('shortcut', this.handleShortcut)
		this.loadMailboxInterval = setInterval(this.loadMailbox, 60000)
	},

	async mounted() {
		if (this.mainStore.hasFetchedInitialEnvelopes) {
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
		// not to fully finish first.
		if (this.$route.params.threadId) {
			this.mainStore.setInteractionPriorityMutation()
			await wait(300)
		}

		await this.loadEnvelopes()
		logger.debug(`syncing folder ${this.mailbox.databaseId} (${this.searchQuery}) after mount`)
		await this.sync(false)

		await this.prefetchOtherMailboxes()

		this.mainStore.setHasFetchedInitialEnvelopesMutation(true)
	},

	destroyed() {
		this.bus.off('load-more', this.onScroll)
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
				logger.error('could not fetch next envelope page', { error })
			} finally {
				this.loadingMore = false
			}
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
			const envelopes = this.envelopes
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
					try {
						await this.mainStore.deleteThread({
							envelope: env,
						})
					} catch (error) {
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
					}

					break
				case 'arch':
					logger.debug('archiving via shortcut')

					if (this.account.archiveMailboxId === null) {
						showWarning(t('mail', 'To archive a message please configure an archive folder in account settings'))
						return
					}

					if (!this.hasArchiveAcl()) {
						showWarning(t('mail', 'You are not allowed to move this message to the archive folder and/or delete this message from the current folder'))
						return
					}

					if (env.mailboxId === this.account.archiveMailboxId) {
						logger.debug('message is already in archive folder')
						return
					}

					logger.debug('archiving', { env })
					this.onDelete(env.databaseId)
					try {
						await this.mainStore.moveThread({
							envelope: env,
							destMailboxId: this.account.archiveMailboxId,
						})
					} catch (error) {
						logger.error('could not archive envelope', {
							env,
							error,
						})

						showError(t('mail', 'Could not archive message'))
					}
					break
				case 'flag':
					logger.debug('flagging envelope via shortkey', { env })
					this.mainStore.toggleEnvelopeFlagged(env).catch((error) => logger.error('could not flag envelope via shortkey', {
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
		onDelete(id) {
			// Get a new message
			this.mainStore.fetchNextEnvelopes({
				mailboxId: this.mailbox.databaseId,
				query: this.searchQuery,
				quantity: 1,
			})
			const idx = findIndex(propEq(id, 'databaseId'), this.envelopes)
			if (idx === -1) {
				logger.debug('envelope to delete does not exist in envelope list')
				return
			}
			if (id !== this.$route.params.threadId) {
				logger.debug('other message open, not jumping to the next/previous message')
				return
			}

			const next = this.envelopes[idx + 1] ?? this.envelopes[idx - 1]
			if (!next) {
				logger.debug('no next/previous envelope, not navigating')
				return
			}

			// Keep the selected mailbox, but navigate to a different message
			// (it's not a bug that we don't use next.mailboxId here)
			this.$router.push({
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
</style>
