<!--
  - SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<AppContentDetails id="mail-message">
		<!-- Show outer loading screen only if we have no data about the thread -->
		<Loading v-if="loading && thread.length === 0" :hint="t('mail', 'Loading thread')" />
		<Error
			v-else-if="errorTitle || errorMessage"
			:error="errorTitle ? errorTitle : t('mail', 'Not found')"
			:message="errorMessage" />
		<template v-else>
			<div id="mail-thread-header">
				<div id="mail-thread-header-fields">
					<h2 dir="auto" :title="threadSubject">
						{{ threadSubject }}
					</h2>
				</div>
				<div v-if="listNavigation" id="mail-thread-list-navigation">
					<ButtonVue
						data-test="newer-message"
						type="tertiary-no-background"
						:aria-label="t('mail', 'Newer message')"
						:title="t('mail', 'Newer message')"
						:disabled="!listNavigation.hasPrevious"
						@click="navigateList('prev')">
						<template #icon>
							<ChevronLeftIcon :size="20" />
						</template>
					</ButtonVue>
					<ButtonVue
						data-test="older-message"
						type="tertiary-no-background"
						:aria-label="t('mail', 'Older message')"
						:title="t('mail', 'Older message')"
						:disabled="!listNavigation.hasNext"
						@click="navigateList('next')">
						<template #icon>
							<ChevronRightIcon :size="20" />
						</template>
					</ButtonVue>
				</div>
			</div>
			<ThreadSummary v-if="showSummaryBox" :loading="summaryLoading" :summary="summaryText" />
			<ThreadEnvelope
				v-for="(env, index) in visibleThread"
				:key="env.databaseId"
				:envelope="env"
				:mailbox-id="$route.params.mailboxId"
				:thread-subject="threadSubject"
				:expanded="expandedThreads.includes(env.databaseId)"
				:full-height="thread.length === 1"
				:thread-index="index"
				@delete="$emit('delete', env.databaseId)"
				@request-delete="onRequestDeleteOne"
				@request-archive="onRequestArchiveOne"
				@request-toggle-junk-one="onRequestToggleJunkOne"
				@request-move="onRequestMove"
				@request-snooze="onRequestSnooze"
				@loaded="addLoadedThread"
				@move="onMove(env.databaseId)"
				@toggle-expand="toggleExpand(env.databaseId)"
				@print="print" />
		</template>
	</AppContentDetails>
</template>

<script>
import { showError } from '@nextcloud/dialogs'
import { loadState } from '@nextcloud/initial-state'
import { NcAppContentDetails as AppContentDetails, NcButton as ButtonVue } from '@nextcloud/vue'
import { mapStores } from 'pinia'
import ChevronLeftIcon from 'vue-material-design-icons/ChevronLeft.vue'
import ChevronRightIcon from 'vue-material-design-icons/ChevronRight.vue'
import Error from './Error.vue'
import Loading from './Loading.vue'
import ThreadEnvelope from './ThreadEnvelope.vue'
import ThreadSummary from './ThreadSummary.vue'
import { matchError } from '../errors/match.js'
import NoTrashMailboxConfiguredError from '../errors/NoTrashMailboxConfiguredError.js'
import logger from '../logger.js'
import UndoableActionMixin from '../mixins/UndoableActionMixin.js'
import { summarizeThread } from '../service/AiIntergrationsService.js'
import useMainStore from '../store/mainStore.js'
import { getRandomMessageErrorMessage } from '../util/ErrorMessageFactory.js'
import { formatDateTimeFromUnix } from '../util/formatDateTime.js'

export default {
	name: 'Thread',
	components: {
		ThreadSummary,
		AppContentDetails,
		ButtonVue,
		ChevronLeftIcon,
		ChevronRightIcon,
		Error,
		Loading,
		ThreadEnvelope,
	},

	mixins: [UndoableActionMixin],

	data() {
		return {
			summaryLoading: false,
			loading: true,
			message: undefined,
			errorMessage: '',
			errorTitle: '',
			expandedThreads: [],
			enabledThreadSummary: loadState('mail', 'llm_summaries_available', false),
			summaryText: '',
			summaryError: false,
			loadedThreads: 0,
			// Set when fetchThread() fails on a network-shaped error (no
			// HTTP response at all -- a lost connection, or the browser
			// itself killing an in-flight request when the tab is
			// backgrounded on mobile) rather than a definitive 403/500
			// from the server. onVisibilityChange() retries automatically
			// once the tab is visible again, instead of leaving the user
			// stuck on an error for something that was never really about
			// this thread not existing.
			retryOnVisible: false,
		}
	},

	computed: {
		...mapStores(useMainStore),
		threadId() {
			return parseInt(this.$route.params.threadId, 10)
		},

		// This is the same context Thread.vue already uses for neighbor
		// prefetching. It is the only reliable way to identify the source
		// list when Priority Inbox renders several lists for one route.
		listNavigation() {
			const openedFrom = this.mainStore.lastOpenedFromList
			if (!openedFrom || !this.mainStore.getMailbox(openedFrom.mailboxId)) {
				return undefined
			}

			const list = this.mainStore.getEnvelopes(openedFrom.mailboxId, openedFrom.query)
			const openIndex = list.findIndex((envelope) => envelope?.databaseId === this.threadId)
			if (openIndex === -1) {
				return undefined
			}

			return {
				hasPrevious: list[openIndex - 1] !== undefined,
				hasNext: list[openIndex + 1] !== undefined,
			}
		},

		thread() {
			const envelope = this.mainStore.getEnvelope(this.threadId)
			if (envelope === undefined) {
				return []
			}

			if (this.mainStore.getPreference('layout-message-view', 'threaded') === 'singleton') {
				return [envelope]
			}

			const envelopes = this.mainStore.getEnvelopesByThreadRootId(envelope.accountId, envelope.threadRootId)
			if (envelopes.length === 0) {
				return []
			}

			const currentMailbox = this.mainStore.getMailbox(envelope.mailboxId)
			const trashMailbox = this.mainStore.getMailboxes(envelope.accountId).find((mailbox) => mailbox.specialRole === 'trash')
			const junkMailbox = this.mainStore.getMailboxes(envelope.accountId).find((mailbox) => mailbox.specialRole === 'junk')

			let limitEnvelopesToCurrentMailbox = false
			const mailboxesToIgnore = []

			if (trashMailbox !== undefined) {
				if (currentMailbox.databaseId === trashMailbox.databaseId) {
					limitEnvelopesToCurrentMailbox = true
				}
				mailboxesToIgnore.push(trashMailbox.databaseId)
			}

			if (junkMailbox !== undefined) {
				if (currentMailbox.databaseId === junkMailbox.databaseId) {
					limitEnvelopesToCurrentMailbox = true
				}
				mailboxesToIgnore.push(junkMailbox.databaseId)
			}

			if (limitEnvelopesToCurrentMailbox) {
				return this.dedupeFolderCopies(envelopes.filter((envelope) => envelope.mailboxId === currentMailbox.databaseId))
			} else {
				return this.dedupeFolderCopies(envelopes.filter((envelope) => !mailboxesToIgnore.includes(envelope.mailboxId)))
			}
		},

		// Messages pending an undoable delete/archive (see
		// UndoableActionMixin) are hidden here immediately, same
		// reasoning as EnvelopeList.vue's own sortedEnvelops filter: the
		// message should look gone right away, not linger for the full
		// undo window just because nothing irreversible has actually
		// happened yet.
		visibleThread() {
			return this.thread.filter((envelope) => !this.isPendingUndo(envelope.databaseId))
		},

		threadSubject() {
			const thread = this.thread
			if (thread.length === 0) {
				logger.warn('thread is empty')
				return ''
			}
			return thread[0].subject || this.t('mail', 'No subject')
		},

		threadParticipants() {
			const seen = new Set()
			return this.thread.flatMap((envelope) => [
				...(envelope.from ?? []),
				...(envelope.to ?? []),
			]).filter(({ email }) => {
				if (seen.has(email)) {
					return false
				}
				seen.add(email)
				return true
			})
		},

		showSummaryBox() {
			return this.thread.length > 2 && this.enabledThreadSummary && !this.summaryError
		},
	},

	watch: {
		$route(to, from) {
			// Mirrored unconditionally, even when the guard below skips
			// resetThread() -- store-level consumers (the idle-tail-trim
			// cache GC, the open-thread proactive prefetch, see
			// actions.js) need this correct on every route change, not
			// just the ones that actually change threads.
			this.mainStore.setCurrentOpenThreadIdMutation(parseInt(to.params.threadId, 10) || undefined)

			if (
				from.name === to.name
				&& from.params.mailboxId === to.params.mailboxId
				&& from.params.threadId === to.params.threadId
				&& from.params.filter === to.params.filter
			) {
				logger.debug('navigated but the thread is still the same')
				return
			}
			logger.debug('navigated to another thread', { to, from })
			this.resetThread()
		},
	},

	created() {
		this.mainStore.setCurrentOpenThreadIdMutation(this.threadId || undefined)
		this.resetThread()
		window.addEventListener('keydown', this.handleKeyDown)
		document.addEventListener('visibilitychange', this.onVisibilityChange)
	},

	beforeDestroy() {
		// This pane is v-if-gated (MailboxThread.vue), so a real
		// destroy here genuinely means no thread is open anymore --
		// clear it so store-level consumers don't keep treating a
		// closed thread as still on screen.
		this.mainStore.setCurrentOpenThreadIdMutation(undefined)
		window.removeEventListener('keydown', this.handleKeyDown)
		document.removeEventListener('visibilitychange', this.onVisibilityChange)
	},

	methods: {
		navigateList(direction) {
			if ((direction === 'prev' && !this.listNavigation?.hasPrevious)
				|| (direction === 'next' && !this.listNavigation?.hasNext)) {
				return
			}

			// Mailbox.vue remains the single owner of neighbor-route
			// navigation. MailboxThread forwards this event through the
			// same bus payload used by the existing arrow-key shortcuts.
			this.$emit('navigate-list', { srcKey: direction })
		},

		// The same physical email can exist as one row per folder within
		// the account -- on Gmail, INBOX / "All Mail" / Important are
		// folder VIEWS of one message, each synced as its own copy with
		// its own, independently-refreshed flags. Without dedup the
		// thread view rendered the same email several times, and after a
		// flag toggle the untouched copies kept their stale flags --
		// confirmed live: unmarking the INBOX copy left a still-flagged
		// [Gmail]/Important copy rendered as a seemingly separate,
		// still-important "second message" while the whole thread had
		// correctly moved to Other. Keep exactly one row per Message-ID:
		// the copy the user actually opened wins (their actions must
		// target the row they clicked), then the inbox copy, then a
		// plain folder over special views, with a deterministic
		// tie-break. Rows without a messageId cannot be grouped and are
		// kept as-is.
		dedupeFolderCopies(envelopes) {
			const rank = (envelope) => {
				if (envelope.databaseId === this.threadId) {
					return 0
				}
				const mailbox = this.mainStore.getMailbox(envelope.mailboxId)
				if (mailbox?.specialRole === 'inbox') {
					return 1
				}
				if (!mailbox?.specialRole && (mailbox?.specialUse ?? []).length === 0) {
					return 2
				}
				return 3
			}

			const seen = new Map()
			const result = []
			for (const envelope of envelopes) {
				if (!envelope.messageId) {
					result.push(envelope)
					continue
				}
				const existingIndex = seen.get(envelope.messageId)
				if (existingIndex === undefined) {
					seen.set(envelope.messageId, result.length)
					result.push(envelope)
					continue
				}
				const existing = result[existingIndex]
				if (rank(envelope) < rank(existing)
					|| (rank(envelope) === rank(existing) && envelope.databaseId < existing.databaseId)) {
					result[existingIndex] = envelope
				}
			}
			return result
		},

		async updateSummary() {
			if (this.thread.length <= 2 || !this.enabledThreadSummary) {
				return
			}

			this.summaryLoading = true
			try {
				this.summaryText = await summarizeThread(this.thread[0].databaseId)
			} catch (error) {
				this.summaryError = true
				showError(t('mail', 'Summarizing thread failed.'))
				logger.error('Summarizing thread failed', { error })
			} finally {
				this.summaryLoading = false
			}
		},

		toggleExpand(threadId) {
			if (this.thread.length === 1) {
				return
			}
			if (!this.expandedThreads.includes(threadId)) {
				logger.debug(`expand thread ${threadId}`)
				this.expandedThreads.push(threadId)
			} else {
				logger.debug(`collapse thread ${threadId}`)
				this.expandedThreads = this.expandedThreads.filter((t) => t !== threadId)
			}
		},

		onMove(threadId) {
			if (threadId === this.threadId) {
				this.$router.replace({
					name: 'mailbox',
					params: {
						mailboxId: this.$route.params.mailboxId,
					},
				})
			} else {
				this.expandedThreads = this.expandedThreads.filter((id) => id !== threadId)
				this.fetchThread()
			}
		},

		// ThreadEnvelope.vue's own delete/archive actions request them
		// here instead of calling the store directly, so a message
		// deleted/archived from within an open thread goes through the
		// same undo window as the mailbox list's delete
		// (EnvelopeList.vue's onRequestDeleteOne()).
		onRequestDeleteOne(envelope) {
			this.performActionWithUndo({
				ids: [envelope.databaseId],
				message: t('mail', 'Message deleted'),
				action: async () => {
					await this.mainStore.deleteMessage({
						id: envelope.databaseId,
					})
				},
			}).catch(async (error) => {
				showError(await matchError(error, {
					[NoTrashMailboxConfiguredError.getName()]() {
						return t('mail', 'No trash folder configured')
					},
					default(error) {
						logger.error('could not delete message', error)
						return t('mail', 'Could not delete message')
					},
				}))
			})
		},

		onRequestArchiveOne(envelope) {
			const account = this.mainStore.getAccount(envelope.accountId)
			this.performActionWithUndo({
				ids: [envelope.databaseId],
				message: t('mail', 'Message archived'),
				action: async () => {
					await this.mainStore.moveMessage({
						id: envelope.databaseId,
						destMailboxId: account.archiveMailboxId,
					})
				},
			}).catch((error) => {
				logger.error('could not archive message', error)
				showError(t('mail', 'Could not archive message'))
			})
		},

		// ThreadEnvelope.vue's and MenuEnvelope.vue's own junk-toggle
		// actions both request it here instead of calling the store
		// directly -- same mechanism EnvelopeList.vue's
		// onRequestToggleJunkOne() applies for the mailbox list view.
		onRequestToggleJunkOne({ envelope, removeEnvelope, isImportant }) {
			const wasJunk = envelope.flags.$junk
			this.performActionWithUndo({
				ids: removeEnvelope ? [envelope.databaseId] : [],
				message: wasJunk ? t('mail', 'Marked as not spam') : t('mail', 'Marked as spam'),
				action: async () => {
					if (isImportant) {
						await this.mainStore.toggleEnvelopeImportant(envelope)
					}
					if (!envelope.flags.seen) {
						await this.mainStore.toggleEnvelopeSeen({ envelope })
					}
					await this.mainStore.toggleEnvelopeJunk({ envelope, removeEnvelope })
				},
			}).catch((error) => {
				logger.error('could not toggle junk status', { error })
				showError(t('mail', 'Could not update spam status'))
			})
		},

		// ThreadEnvelope.vue's own "Move to folder..." dialog
		// (MoveModal.vue) requests it here instead of calling the store
		// directly -- same mechanism EnvelopeList.vue's onRequestMove()
		// applies for the mailbox list view.
		onRequestMove({ envelopes, destMailboxId, moveThread }) {
			this.performActionWithUndo({
				ids: envelopes.map((envelope) => envelope.databaseId),
				message: t('mail', 'Message moved'),
				action: async () => {
					await Promise.all(envelopes.map((envelope) => (moveThread
						? this.mainStore.moveThread({ envelope, destMailboxId })
						: this.mainStore.moveMessage({ id: envelope.databaseId, destMailboxId }))))
					await this.mainStore.syncEnvelopes({ mailboxId: destMailboxId })
				},
			}).catch((error) => {
				logger.error('could not move message', { error })
				showError(t('mail', 'Could not move message'))
			})
		},

		// MenuEnvelope.vue's own snooze action (via ThreadEnvelope.vue's
		// re-emit) requests it here instead of calling the store
		// directly -- same mechanism EnvelopeList.vue's
		// onRequestSnooze() applies for the mailbox list view. The
		// snooze mailbox itself, if it needed creating, was already
		// created eagerly by the caller.
		onRequestSnooze({ envelope, isThreaded, unixTimestamp, destMailboxId }) {
			this.performActionWithUndo({
				ids: [envelope.databaseId],
				message: t('mail', 'Message snoozed'),
				action: async () => {
					if (isThreaded) {
						await this.mainStore.snoozeThread({ envelope, unixTimestamp, destMailboxId })
					} else {
						await this.mainStore.snoozeMessage({ id: envelope.databaseId, unixTimestamp, destMailboxId })
					}
				},
			}).catch((error) => {
				logger.error('could not snooze message', { error })
				showError(t('mail', 'Could not snooze message'))
			})
		},

		// Which message to auto-expand (and scroll to) when the thread
		// opens: the first (oldest) unread message, like Gmail -- not
		// always the newest, which may well have already been read while
		// an earlier reply in the same thread hasn't. Falls back to the
		// clicked/newest message (threadId) once nothing in the thread is
		// unread. Relies on this.thread's ascending date order (see the
		// getEnvelopesByThreadRootId getter) to find the earliest one.
		initiallyExpandedEnvelopeId() {
			// Requires an explicit `false`, not just falsy/missing flags,
			// so an envelope whose flags haven't loaded yet is never
			// mistaken for unread.
			const firstUnread = this.thread.find((envelope) => envelope.flags?.seen === false)
			return firstUnread ? firstUnread.databaseId : this.threadId
		},

		// Proactively prefetch a small, ordered neighborhood around the
		// message that just got auto-expanded, rather than waiting on
		// each sibling ThreadEnvelope's own viewport-prefetch to notice
		// it's scrolled into view: the immediately-previous message
		// (most likely to be re-read for context while reading the
		// current one), then the thread's first message (often the
		// original question/context in a long back-and-forth) -- the
		// rest of the thread is left to normal viewport-prefetch.
		// Speculative like every other prefetch trigger: if the user
		// navigates to a different thread before these resolve,
		// cancelSpeculativeFetchesExcept() (called at the top of the
		// NEXT resetThread()) aborts them same as any other.
		prefetchThreadNeighborhood(openId) {
			const openIndex = this.thread.findIndex((envelope) => envelope.databaseId === openId)
			if (openIndex === -1) {
				return
			}

			const candidates = []
			if (openIndex > 0) {
				candidates.push(this.thread[openIndex - 1])
			}
			if (openIndex !== 0) {
				candidates.push(this.thread[0])
			}

			// A short thread (e.g. exactly 2 messages) can make
			// "previous" and "first" the same envelope -- fetchMessage()
			// dedupes per id regardless, but skip the redundant call.
			const seen = new Set()
			for (const envelope of candidates) {
				if (seen.has(envelope.databaseId)) {
					continue
				}
				seen.add(envelope.databaseId)
				this.mainStore.fetchMessage(envelope.databaseId, { speculative: true }).catch(() => {})
			}
		},

		// The reading time between opening a message and the user's next
		// action is otherwise idle -- established pattern (Superhuman
		// markets exactly this as a speed feature): while the user reads,
		// speculatively prefetch the previous/next message in the LIST
		// they opened this one from, not just siblings within its own
		// thread (prefetchThreadNeighborhood above). Both directions,
		// since navigation could go either way.
		//
		// Works uniformly for every list -- a regular folder, its own
		// Favorites sub-list, any Priority Inbox section, the unified
		// inbox's merged view, or a search/filter's results -- because it
		// reads mainStore.lastOpenedFromList (set by Envelope.vue's own
		// onClick(), the only place that unambiguously knows which of
		// several possibly-simultaneously-rendered lists a row belongs
		// to) instead of trying to reconstruct "the" list from route
		// params, which multiple lists can share.
		prefetchListNeighborhood(openId) {
			const openedFrom = this.mainStore.lastOpenedFromList
			// Absent for any navigation that didn't go through a list
			// click at all (a direct URL, a bookmark, browser back/
			// forward, a notification) -- nothing to prefetch against.
			if (!openedFrom) {
				return
			}

			// Guards both a genuinely stale recording (e.g. the mailbox
			// was since removed) and, in tests, a fixture that never
			// registered it -- getEnvelopes() itself has no such guard
			// (getMailbox() returning undefined would throw reading its
			// .envelopeLists).
			if (!this.mainStore.getMailbox(openedFrom.mailboxId)) {
				return
			}

			const list = this.mainStore.getEnvelopes(openedFrom.mailboxId, openedFrom.query)
			const openIndex = list.findIndex((envelope) => envelope.databaseId === openId)
			if (openIndex === -1) {
				return
			}

			const neighbors = [list[openIndex - 1], list[openIndex + 1]].filter(Boolean)
			for (const envelope of neighbors) {
				this.mainStore.fetchMessage(envelope.databaseId, { speculative: true }).catch(() => {})
			}
		},

		async resetThread() {
			// Opening a message is a direct user action -- give it
			// priority over the background watched-mailbox poller (see
			// setInteractionPriorityMutation() in the store).
			this.mainStore.setInteractionPriorityMutation()

			// Every OTHER in-flight speculative (hover/touch/viewport
			// prefetch-triggered) fetch is now provably wasted work --
			// the user just committed to opening THIS thread, not
			// whatever else was being prefetched from list scrolling.
			// Aborting them frees the mail-pool workers/IMAP connections
			// they're holding for the fetches below that actually matter
			// now. Confirmed live: unbounded scroll-triggered prefetch
			// queued a real thread open behind ~20 unrelated messages'
			// body fetches for nearly a minute (thread 926521,
			// 2026-07-12) before this existed.
			this.mainStore.cancelSpeculativeFetchesExcept(this.threadId)

			// Doesn't need the thread to resolve first (unlike
			// prefetchThreadNeighborhood(), which needs this.thread) --
			// firing it here rather than after fetchThread() gives it a
			// head start during exactly the reading time it's meant to
			// use.
			this.prefetchListNeighborhood(this.threadId)

			this.expandedThreads = [this.initiallyExpandedEnvelopeId()]
			this.errorMessage = ''
			this.errorTitle = ''
			if (this.mainStore.getPreference('layout-message-view', 'threaded') === 'threaded') {
				// Start fetching the clicked message's body in parallel
				// with the thread listing, instead of waiting for the
				// thread to resolve and ThreadEnvelope.vue to mount
				// before firing it -- removes one full round trip from
				// the critical path in the common case (a single-message
				// thread, or the clicked message is already the one that
				// ends up auto-expanded). Not wasted even when
				// initiallyExpandedEnvelopeId() picks an earlier unread
				// message instead: this message is still part of the
				// rendered thread. Errors are swallowed here --
				// ThreadEnvelope.vue's own fetchMessage() call handles
				// the real error path; fetchMessage() dedupes concurrent
				// calls for the same id, so that call reuses this one
				// instead of firing a second request.
				this.mainStore.fetchMessage(this.threadId).catch(() => {})
				await this.fetchThread()
			}
			this.updateSummary()
			this.loadedThreads = 0
		},

		async fetchThread() {
			this.loading = true
			this.errorMessage = ''
			this.errorTitle = ''
			this.retryOnVisible = false
			const threadId = this.threadId

			try {
				const thread = await this.mainStore.fetchThread(threadId)
				logger.debug(`thread for envelope ${threadId} fetched`, { thread })
				// TODO: add timeout so that envelope isn't flagged when only viewed
				//       for a few seconds
				if (threadId !== parseInt(this.$route.params.threadId, 10)) {
					logger.debug("User navigated away, loaded envelope won't be shown nor flagged as seen", {
						oldId: threadId,
						newId: this.$route.params.threadId,
					})
					return
				}

				if (thread.length === 0) {
					logger.info('thread could not be found and is empty', { threadId })
					this.errorMessage = getRandomMessageErrorMessage()
					this.loading = false
					return
				}

				// resetThread()'s initial guess only had whatever was
				// already cached locally to go on -- now that the full
				// thread is loaded, correct it if that guess turns out to
				// have been wrong (e.g. an unread message elsewhere in the
				// thread wasn't cached yet).
				const target = this.initiallyExpandedEnvelopeId()
				if (!this.expandedThreads.includes(target)) {
					this.expandedThreads = [target]
				}

				this.prefetchThreadNeighborhood(target)

				this.loading = false
			} catch (error) {
				// Same staleness check as the success path above -- without
				// it, a fetchThread() call superseded by a newer one could
				// reject after the user had already navigated elsewhere and
				// unconditionally stomp errorMessage for whatever thread is
				// now open.
				if (threadId !== parseInt(this.$route.params.threadId, 10)) {
					logger.debug('A stale fetchThread() rejected after the user navigated away; ignoring', {
						oldId: threadId,
						newId: this.$route.params.threadId,
						error,
					})
					return
				}

				// this.thread reads straight from the shared store, not
				// from anything only this call would have populated -- the
				// store's fetchThread() action has no caching/dedup at all
				// (unlike fetchMessage()), so hover-prefetch (Envelope.vue)
				// firing its own independent fetchThread() for the same id
				// can race this one: if THAT call already succeeded and
				// committed the thread to the store, the data is already
				// correctly loaded and rendering regardless of why this
				// specific, now-redundant call rejected. Confirmed live: a
				// thread that visibly loaded fine flipped to "Δεν βρέθηκε"
				// moments later, only reproducible on desktop (hover exists
				// there, not on mobile touch).
				if (this.thread.length > 0) {
					logger.debug('fetchThread() rejected, but the thread is already loaded (a concurrent call must have succeeded); ignoring', {
						threadId,
						error,
					})
					this.loading = false
					return
				}

				logger.error('could not load envelope thread', { threadId, error })
				if (error?.response?.status === 403) {
					this.errorTitle = t('mail', 'Could not load your message thread')
					this.errorMessage = t('mail', 'The thread doesn\'t exist or has been deleted')
					this.loading = false
				} else if (error?.response?.status === 500) {
					this.error = { message: t('mail', 'Email was not able to be opened') }
					this.loading = false
				} else {
					// No HTTP response at all -- a network-shaped failure
					// (lost connection, or the browser killing an
					// in-flight request when the tab is backgrounded on
					// mobile), not a definitive answer about this thread.
					// Confirmed live: previously left `loading` stuck true
					// forever here -- the one branch in this otherwise-
					// consistent set that never reset it -- so the
					// template's loading/error v-if chain kept showing
					// the spinner forever instead of ever reaching the
					// error message this branch had just set.
					// retryOnVisible lets onVisibilityChange() retry
					// automatically rather than leaving the user stuck.
					this.errorMessage = t('mail', 'Could not load your message thread')
					this.loading = false
					this.retryOnVisible = true
				}
			}
		},

		// Mirrors App.vue's own visibilitychange handling (background
		// sync tiering) -- same Page Visibility API, different purpose
		// here: a thread that failed to load on a network-shaped error
		// while the tab was backgrounded gets one automatic retry the
		// moment the user actually looks at it again, instead of being
		// left on an error (or, before the fix above, a stuck spinner)
		// for something that was never really about this thread.
		onVisibilityChange() {
			if (document.visibilityState === 'visible' && this.retryOnVisible) {
				this.retryOnVisible = false
				logger.debug('Retrying thread load after the tab became visible again following a network-shaped failure', {
					threadId: this.threadId,
				})
				this.resetThread()
			}
		},

		async handleKeyDown(event) {
			if ((event.ctrlKey || event.metaKey) && event.key === 'p') {
				event.preventDefault()

				try {
					this.thread.forEach((thread) => {
						if (!this.expandedThreads.includes(thread.databaseId)) {
							this.expandedThreads.push(thread.databaseId)
						}
					})

					while (true) {
						if (this.loadedThreads === this.thread.length) {
							break
						}
						await new Promise((resolve) => setTimeout(resolve, 100))
					}

					const virtualIframe = document.createElement('iframe')
					virtualIframe.style.position = 'absolute'
					document.body.appendChild(virtualIframe)
					const virtualIframeDocument = virtualIframe.contentDocument || virtualIframe.contentWindow.document
					virtualIframeDocument.open()
					virtualIframeDocument.write(`<html><head><title>${t('mail', 'Print')}</title></head><body></body></html>`)
					virtualIframeDocument.close()

					virtualIframeDocument.body.appendChild(this.addThreadInfo(virtualIframeDocument))

					const messageContainers = document.querySelectorAll('#message-container')
					for (const [index, messageContainer] of messageContainers.entries()) {
						const iframe = messageContainer.querySelector('iframe')

						this.addMessageInfo(virtualIframeDocument, index)

						if (!iframe) {
							const div = virtualIframeDocument.createElement('div')
							div.innerHTML = messageContainer.innerHTML
							virtualIframeDocument.body.appendChild(div)
							continue
						}

						if (iframe.contentWindow.document.readyState !== 'complete') {
							await new Promise((resolve) => {
								iframe.contentWindow.onload = resolve
							})
						}

						const iframeDocument = iframe.contentDocument || iframe.contentWindow.document
						const iframeContent = iframeDocument.body.innerHTML
						const div = virtualIframeDocument.createElement('div')

						div.innerHTML = iframeContent
						virtualIframeDocument.body.appendChild(div)
					}

					const images = virtualIframeDocument.querySelectorAll('img')
					let imagesLoaded = 0

					images.forEach((img) => {
						img.addEventListener('load', () => {
							imagesLoaded++
							if (imagesLoaded === images.length) {
								virtualIframe.contentWindow.print()
								this.removeIframe(virtualIframe)
							}
						})
						img.addEventListener('error', () => {
							imagesLoaded++
							if (imagesLoaded === images.length) {
								virtualIframe.contentWindow.print()
								this.removeIframe(virtualIframe)
							}
						})
					})

					if (images.length === 0) {
						virtualIframe.contentWindow.print()
						this.removeIframe(virtualIframe)
					}
				} catch (error) {
					logger.error('Could not print message', { error })
					showError(t('mail', 'Could not print message'))
				}
			}
		},

		removeIframe(virtualIframe) {
			setTimeout(() => {
				document.body.removeChild(virtualIframe)
			}, 500)
		},

		addMessageInfo(virtualIframeDocument, index) {
			const hr = virtualIframeDocument.createElement('hr')
			hr.style.border = '1px solid black'

			const subjectSpan = virtualIframeDocument.createElement('p')
			subjectSpan.style.fontWeight = 'bold'
			subjectSpan.textContent = t('mail', 'Subject') + ': ' + this.thread[index].subject

			const senderSpan = virtualIframeDocument.createElement('p')
			senderSpan.style.fontWeight = 'bold'
			senderSpan.textContent = t('mail', 'From') + ': ' + this.thread[index].from[0].label + ' <' + this.thread[index].from[0].email + '>'

			const dateSpan = virtualIframeDocument.createElement('p')
			dateSpan.style.fontWeight = 'bold'
			dateSpan.textContent = t('mail', 'Date') + ': ' + formatDateTimeFromUnix(this.thread[index].dateInt)

			const recipientSpan = virtualIframeDocument.createElement('p')
			recipientSpan.style.fontWeight = 'bold'
			recipientSpan.textContent = t('mail', 'To') + ': ' + this.thread[index].to[0].label + this.thread[index].to[0].email

			virtualIframeDocument.body.appendChild(hr)
			virtualIframeDocument.body.appendChild(subjectSpan)
			virtualIframeDocument.body.appendChild(senderSpan)
			virtualIframeDocument.body.appendChild(dateSpan)
			virtualIframeDocument.body.appendChild(recipientSpan)
		},

		addThreadInfo(document) {
			const threadInfo = document.createElement('div')
			threadInfo.style.marginTop = '20px'
			threadInfo.style.marginBottom = '20px'
			threadInfo.className = 'mail-thread-info'

			const subjectLine = document.createElement('h2')
			subjectLine.textContent = `${this.threadSubject}`
			threadInfo.appendChild(subjectLine)

			const participantsLine = document.createElement('p')
			participantsLine.textContent = this.threadParticipants
				.map((participant) => `${participant.label} <${participant.email}>`)
				.join(', ')
			threadInfo.appendChild(participantsLine)

			return threadInfo
		},

		addLoadedThread() {
			this.loadedThreads++
		},

		print(threadIndex) {
			setTimeout(() => {
				try {
					const messages = Array.from(document.querySelectorAll('.html-message-body, .mail-message-body'))

					let message

					if (threadIndex !== undefined) {
						message = messages[threadIndex * 2] ?? messages.pop()
					} else {
						// By default, we print the last opened message in the thread
						message = messages.pop()
					}

					const iframe = message.querySelector('iframe')

					if (iframe === null) {
						// Handle plain text messages
						const messageContainer = message.querySelector('#message-container')

						if (messageContainer) {
							// Create a new iframe
							const newIframe = document.createElement('iframe')
							newIframe.style.display = 'none' // Hide the iframe
							document.body.appendChild(newIframe)

							// Insert the message content into the iframe
							const iframeDocument = newIframe.contentDocument || newIframe.contentWindow.document
							iframeDocument.open()
							iframeDocument.write(`
								<html>
									<head>
										<title></title>
									</head>
									<body>
										<div class="message-container">${messageContainer.innerHTML}</div>
									</body>
								</html>
							`)
							iframeDocument.title = this.threadSubject

							const threadInfo = this.addThreadInfo(iframeDocument)
							iframeDocument.body.insertBefore(threadInfo, iframeDocument.body.firstChild)

							setTimeout(() => {
								threadInfo.remove()
							}, 5000)

							iframeDocument.close()

							newIframe.contentWindow.print()

							// Clean up: remove the iframe after printing
							setTimeout(() => {
								document.body.removeChild(newIframe)
							}, 500)
						}

						return
					}

					const iframeDocument = iframe.contentDocument || iframe.contentWindow.document

					const threadInfo = this.addThreadInfo(iframeDocument)
					iframeDocument.body.insertBefore(threadInfo, iframeDocument.body.firstChild)

					setTimeout(() => {
						threadInfo.remove()
					}, 200)

					iframe.contentWindow.print()
				} catch (error) {
					logger.error('Could not print message', { error })
					showError(t('mail', 'Could not print message'))
				}
			}, 100)
		},
	},
}
</script>

<style lang="scss">
@use '../../css/variables.scss';

#mail-message {
	width: 100%;
	max-width: 100%;

	.icon-loading {
		&:only-child:after {
			margin-top: calc(var(--default-line-height) - var(--default-grid-baseline));
		}
	}
}

.mail-message-body {
	flex: 1;
	margin-bottom: 0;
	position: relative;
	border-radius: 5px;
}

#mail-thread-header {
	display: flex;
	flex-direction: row;
	justify-content: space-between;
	align-items: center;
	padding: 0 0 calc(var(--default-grid-baseline) * 2) 0;
	// somehow ios doesn't care about this !important rule
	// so we have to manually set left/right padding to chidren
	// for 100% to be used
	box-sizing: content-box !important;
	width: 100%;

	z-index: 100;
	position: fixed; // ie fallback
	position: -webkit-sticky; // ios/safari fallback
	position: sticky;
	top: 0;
	margin-bottom: 5px;

	&::before {
		content: '';
		position: absolute;
		top: 0;
		inset-inline-start: 50%;
		transform: translateX(-50%);
		width: 100vw;
		height: 100%;
		background: var(--color-main-background);
		border-bottom: var(--border-width-input-focused) solid var(--color-border);
		z-index: -1;
	}
}

@media only screen and (max-width: #{variables.$breakpoint-mobile}) {
    #mail-thread-header {
        position: sticky !important;
        top: 29px !important;
    }
}

#mail-thread-header-fields {
	// initial width
	width: 0;
	// while scrolling, the back button overlaps with subject on small screen
	// envelope margin (2×baseline) + border (2px) + header padding (--border-radius-container) + avatar (10×baseline) + sender margin (2×baseline)
	padding-inline-start: calc(var(--default-grid-baseline) * 14 + var(--border-radius-container) + 2px);
	// grow and try to fill 100%
	flex: 1 1 auto;
	background: var(--color-main-background);
	margin-inline-end: 5px;
	h2,
	p {
		padding-bottom: calc(var(--default-grid-baseline) * 2);
		margin-bottom: 0;
		// some h2 styling coming from server add some space on top
		margin-top: var(--default-grid-baseline);
	}

	p {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.transparency {
		opacity: 0.6;
		a {
			font-weight: bold;
		}
	}
}

#mail-thread-list-navigation {
	display: flex;
	flex: 0 0 auto;
	gap: var(--default-grid-baseline);
	margin-inline-end: var(--default-grid-baseline);
}

@media only screen and (max-width: #{variables.$breakpoint-mobile}) {
    #mail-thread-header-fields {
        padding-inline-start: 48px;
    }
}

@media only screen and (max-width: #{variables.$breakpoint-mobile}) {
	#mail-thread-header-fields {
		margin-top: -32px;
	}
}

.attachment-popover {
	position: sticky;
	bottom: calc(var(--default-grid-baseline) * 3);
	text-align: center;
}

.tooltip-inner {
	text-align: start;
}

#mail-content {
	margin: calc(var(--default-grid-baseline) * 2) calc(var(--default-grid-baseline) * 10) 0 calc(var(--default-grid-baseline) * 14);
}

@media only screen and (max-width: #{variables.$breakpoint-mobile}) {
    #mail-content {
        margin: calc(var(--default-grid-baseline) * 2) calc(var(--default-grid-baseline) * 3) 0 calc(var(--default-grid-baseline) * 3);
    }
}

#mail-content iframe {
	width: 100%;
}

#show-images-text {
	display: none;
}

#mail-content a,
.mail-signature a {
	color: #07d;
	border-bottom: var(--border-width-input) dotted #07d;
	text-decoration: none;
	overflow-wrap: break-word;
}

/* Show action button label and move icon to the left
   on screens larger than 600px */
@media only screen and (max-width: 600px) {
	.action-label {
		display: none;
	}
}
@media only screen and (min-width: 600px) {
	.icon-reply-white,
	.icon-reply-all-white {
		background-position: calc(var(--default-grid-baseline) * 3) center;
	}
}

.app-content-list-item-star.icon-starred {
	display: none;
}

.v-popper__popper--shown .user-bubble__wrapper {
	margin-inline-end: 0 !important;

	.user-bubble__content {
		padding: calc(var(--default-grid-baseline));
	}

	.user-bubble__wrapper {
		padding: 0;
	}
}

.user-bubble__title {
	cursor: pointer;
}
</style>
