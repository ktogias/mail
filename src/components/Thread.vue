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
			<div id="mail-thread-header" ref="threadHeader">
				<div id="mail-thread-header-top">
					<div id="mail-thread-header-fields">
						<h2
							dir="auto"
							:title="threadSubject"
							:class="{ 'thread-subject--expanded': subjectExpanded }"
							role="button"
							tabindex="0"
							:aria-expanded="subjectExpanded"
							@click="subjectExpanded = !subjectExpanded"
							@keydown.enter="subjectExpanded = !subjectExpanded"
							@keydown.space.prevent="subjectExpanded = !subjectExpanded">
							{{ threadSubject }}
						</h2>
					</div>
					<NcActions
						id="mail-thread-menu"
						:aria-label="t('mail', 'Thread actions')"
						:inline="threadSnoozeOpen ? 0 : threadInlineMenuSize"
						variant="tertiary">
						<template #icon>
							<DotsVerticalIcon :size="20" />
						</template>
						<template v-if="!threadSnoozeOpen">
							<!-- Only the two safe, reversible, frequently-used actions
							     (mark-all-read/unread, archive) are eligible to be
							     promoted out of the ⋮ menu onto the toolbar, and only
							     when there's room -- see threadInlineMenuSize. They are
							     first in this list so NcActions' :inline promotes
							     exactly them. The higher-blast-radius ones below
							     (move/snooze/junk/delete, each affecting every message
							     in the thread) always stay in the menu, behind a
							     deliberate click. -->
							<NcActionButton
								type="tertiary-no-background"
								class="action--primary"
								:close-after-click="true"
								@click="markThreadSeen(threadHasUnread)">
								<template #icon>
									<EmailReadIcon v-if="threadHasUnread" :size="20" />
									<EmailUnreadIcon v-else :size="20" />
								</template>
								{{ threadHasUnread ? t('mail', 'Mark all as read') : t('mail', 'Mark all as unread') }}
							</NcActionButton>
							<NcActionButton
								v-if="threadAccount && threadAccount.archiveMailboxId"
								type="tertiary-no-background"
								class="action--primary"
								:close-after-click="true"
								@click="archiveThread">
								<template #icon>
									<ArchiveIcon :size="20" />
								</template>
								{{ t('mail', 'Archive thread') }}
							</NcActionButton>
							<NcActionButton
								:close-after-click="true"
								@click="showMoveModal = true">
								<template #icon>
									<OpenInNewIcon :size="20" />
								</template>
								{{ t('mail', 'Move thread') }}
							</NcActionButton>
							<NcActionButton
								v-if="!isSnoozeDisabled && !isThreadInSnoozeMailbox"
								:close-after-click="false"
								@click="threadSnoozeOpen = true">
								<template #icon>
									<AlarmIcon :size="20" />
								</template>
								{{ t('mail', 'Snooze thread') }}
							</NcActionButton>
							<NcActionButton
								v-if="!isSnoozeDisabled && isThreadInSnoozeMailbox"
								:close-after-click="true"
								@click="unSnoozeThreadAction">
								<template #icon>
									<AlarmIcon :size="20" />
								</template>
								{{ t('mail', 'Unsnooze thread') }}
							</NcActionButton>
							<NcActionButton
								:close-after-click="true"
								@click="junkThread">
								<template #icon>
									<AlertOctagonIcon :size="20" />
								</template>
								{{ threadIsJunk ? t('mail', 'Mark thread as not spam') : t('mail', 'Mark thread as spam') }}
							</NcActionButton>
							<NcActionSeparator />
							<NcActionButton
								:close-after-click="true"
								@click="deleteThreadAction">
								<template #icon>
									<DeleteIcon :size="20" />
								</template>
								{{ t('mail', 'Delete thread') }}
							</NcActionButton>
						</template>
						<template v-else>
							<NcActionButton
								:close-after-click="false"
								@click="threadSnoozeOpen = false">
								<template #icon>
									<ChevronLeftIcon :size="20" />
								</template>
								{{ t('mail', 'Back') }}
							</NcActionButton>
							<NcActionButton
								v-for="option in reminderOptions"
								:key="option.key"
								:aria-label="option.ariaLabel"
								close-after-click
								@click.stop="snoozeThreadAt(option.timestamp)">
								{{ option.label }}
							</NcActionButton>
							<NcActionSeparator />
							<NcActionInput
								type="datetime-local"
								is-native-picker
								:model-value="customSnoozeDateTime"
								:min="new Date()"
								@change="setCustomSnoozeDateTime">
								<template #icon>
									<CalendarClockIcon :size="20" />
								</template>
							</NcActionInput>
							<NcActionButton
								:aria-label="t('mail', 'Set custom snooze')"
								close-after-click
								@click.stop="snoozeThreadAt(customSnoozeDateTime.valueOf())">
								<template #icon>
									<CheckIcon :size="20" />
								</template>
								{{ t('mail', 'Set custom snooze') }}
							</NcActionButton>
						</template>
					</NcActions>
				</div>
				<div id="mail-thread-header-meta">
					<span class="thread-meta">{{ threadMetaText }}</span>
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
			<MoveModal
				v-if="showMoveModal"
				:account="threadAccount"
				:envelopes="thread"
				:move-thread="true"
				@request-move="onThreadMove"
				@close="showMoveModal = false" />
		</template>
	</AppContentDetails>
</template>

<script>
import { showError } from '@nextcloud/dialogs'
import { loadState } from '@nextcloud/initial-state'
import moment from '@nextcloud/moment'
import { NcAppContentDetails as AppContentDetails, NcButton as ButtonVue, NcActionButton, NcActionSeparator } from '@nextcloud/vue'
import { mapStores } from 'pinia'
import NcActionInput from '@nextcloud/vue/components/NcActionInput'
import NcActions from '@nextcloud/vue/components/NcActions'
import AlarmIcon from 'vue-material-design-icons/Alarm.vue'
import AlertOctagonIcon from 'vue-material-design-icons/AlertOctagonOutline.vue'
import ArchiveIcon from 'vue-material-design-icons/ArchiveArrowDownOutline.vue'
import CalendarClockIcon from 'vue-material-design-icons/CalendarClockOutline.vue'
import CheckIcon from 'vue-material-design-icons/Check.vue'
import ChevronLeftIcon from 'vue-material-design-icons/ChevronLeft.vue'
import ChevronRightIcon from 'vue-material-design-icons/ChevronRight.vue'
import DotsVerticalIcon from 'vue-material-design-icons/DotsVertical.vue'
import EmailReadIcon from 'vue-material-design-icons/EmailOpenOutline.vue'
import EmailUnreadIcon from 'vue-material-design-icons/EmailOutline.vue'
import OpenInNewIcon from 'vue-material-design-icons/OpenInNew.vue'
import DeleteIcon from 'vue-material-design-icons/TrashCanOutline.vue'
import Error from './Error.vue'
import Loading from './Loading.vue'
import MoveModal from './MoveModal.vue'
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
		NcActions,
		NcActionButton,
		NcActionInput,
		NcActionSeparator,
		AlarmIcon,
		AlertOctagonIcon,
		ArchiveIcon,
		CalendarClockIcon,
		CheckIcon,
		ChevronLeftIcon,
		ChevronRightIcon,
		DeleteIcon,
		DotsVerticalIcon,
		EmailReadIcon,
		EmailUnreadIcon,
		OpenInNewIcon,
		Error,
		Loading,
		MoveModal,
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
			subjectExpanded: false,
			showMoveModal: false,
			threadSnoozeOpen: false,
			// Measured width of #mail-thread-header, kept up to date by
			// redrawMenuBar() (resize + mount). clientWidth isn't reactive on
			// its own, so mirroring it into data is what lets
			// threadInlineMenuSize recompute when the pane is resized.
			threadHeaderWidth: 0,
			customSnoozeDateTime: new Date(moment().add(2, 'hours').minute(0).second(0).valueOf()),
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

			// The raw list retains undoable removals until the toast expires.
			// They are not visible rows and therefore cannot be valid
			// previous/next destinations either.
			const list = this.mainStore.getEnvelopes(openedFrom.mailboxId, openedFrom.query)
				.filter((envelope) => !this.isPendingUndo(envelope.databaseId))
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
			// Keep header and body on the same visibility source. Previously
			// the body used visibleThread while the subject used raw thread,
			// producing exactly the stale-title/empty-body split during an
			// undoable removal.
			const thread = this.visibleThread
			if (thread.length === 0) {
				logger.warn('thread is empty')
				return ''
			}
			return thread[0].subject || this.t('mail', 'No subject')
		},

		// The account the open thread belongs to -- used for thread-level
		// actions (archive target, Move modal).
		threadAccount() {
			return this.visibleThread.length > 0
				? this.mainStore.getAccount(this.visibleThread[0].accountId)
				: undefined
		},

		threadHasUnread() {
			return this.visibleThread.some((envelope) => !envelope.flags?.seen)
		},

		// How many of the thread ⋮ menu's leading actions to promote onto the
		// toolbar as standalone buttons (NcActions :inline). Mirrors
		// ThreadEnvelope's own inlineMenuSize for a single message, but capped:
		// only the safe/reversible leading actions (mark-all-read, then archive
		// if this account has an archive mailbox) are ever eligible, so it never
		// exceeds how many of those are actually rendered -- the destructive
		// ones that follow them in the list can't be promoted no matter how wide
		// the pane is. 0 on a narrow reading pane (everything back in the menu).
		threadInlineMenuSize() {
			const promotable = 1 + ((this.threadAccount && this.threadAccount.archiveMailboxId) ? 1 : 0)
			const widthCap = this.threadHeaderWidth >= 700
				? 2
				: this.threadHeaderWidth >= 500
					? 1
					: 0
			return Math.min(widthCap, promotable)
		},

		threadIsJunk() {
			return this.thread.length > 0 && this.thread.every((envelope) => envelope.flags?.$junk)
		},

		isSnoozeDisabled() {
			return this.mainStore.isSnoozeDisabled
		},

		// True when the open thread already lives in the account's snooze
		// mailbox -- then the menu offers Unsnooze instead of Snooze.
		isThreadInSnoozeMailbox() {
			const account = this.threadAccount
			return account?.snoozeMailboxId !== undefined
				&& this.thread.some((envelope) => envelope.mailboxId === account.snoozeMailboxId)
		},

		// Snooze presets, mirroring MenuEnvelope.vue's per-message options.
		reminderOptions() {
			const currentDateTime = moment()
			const laterTodayTime = (currentDateTime.hour() < 18) ? moment().hour(18) : null
			const tomorrowTime = moment().add(1, 'days').hour(8)
			const thisWeekendTime = (currentDateTime.day() !== 6 && currentDateTime.day() !== 0)
				? moment().day(6).hour(8)
				: null
			const nextWeekTime = moment().add(1, 'weeks').day(1).hour(8)
			const getTimestamp = (momentObject) => momentObject?.minute(0).second(0).millisecond(0).valueOf() || null

			return [
				{
					key: 'laterToday',
					timestamp: getTimestamp(laterTodayTime),
					label: t('mail', 'Later today – {timeLocale}', { timeLocale: laterTodayTime?.format('LT') }),
					ariaLabel: t('mail', 'Snooze thread until later today'),
				},
				{
					key: 'tomorrow',
					timestamp: getTimestamp(tomorrowTime),
					label: t('mail', 'Tomorrow – {timeLocale}', { timeLocale: tomorrowTime?.format('ddd LT') }),
					ariaLabel: t('mail', 'Snooze thread until tomorrow'),
				},
				{
					key: 'thisWeekend',
					timestamp: getTimestamp(thisWeekendTime),
					label: t('mail', 'This weekend – {timeLocale}', { timeLocale: thisWeekendTime?.format('ddd LT') }),
					ariaLabel: t('mail', 'Snooze thread until this weekend'),
				},
				{
					key: 'nextWeek',
					timestamp: getTimestamp(nextWeekTime),
					label: t('mail', 'Next week – {timeLocale}', { timeLocale: nextWeekTime?.format('ddd LT') }),
					ariaLabel: t('mail', 'Snooze thread until next week'),
				},
			].filter((option) => option.timestamp !== null)
		},

		// Compact context line under the subject: "N messages · X people".
		// Reuses threadParticipants (distinct from+to addresses).
		threadMetaText() {
			const messages = this.n('mail', '%n message', '%n messages', this.visibleThread.length)
			const people = this.n('mail', '%n participant', '%n participants', this.threadParticipants.length || 1)
			return `${messages} · ${people}`
		},

		threadParticipants() {
			const seen = new Set()
			return this.visibleThread.flatMap((envelope) => [
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

	mounted() {
		// Keep threadInlineMenuSize responsive to pane width. Same shape as
		// ThreadEnvelope's own inline-menu sizing: measure on resize, plus a
		// short poll to catch the first non-zero width (the header may not be
		// laid out yet on the initial tick, especially on a cold open).
		window.addEventListener('resize', this.redrawMenuBar)
		this.redrawMenuBar()
		this.$menuSizeInterval = setInterval(() => {
			if (this.$refs.threadHeader?.clientWidth > 0) {
				this.redrawMenuBar()
				clearInterval(this.$menuSizeInterval)
				this.$menuSizeInterval = undefined
			}
		}, 100)
	},

	beforeDestroy() {
		// This pane is v-if-gated (MailboxThread.vue), so a real
		// destroy here genuinely means no thread is open anymore --
		// clear it so store-level consumers don't keep treating a
		// closed thread as still on screen.
		this.mainStore.setCurrentOpenThreadIdMutation(undefined)
		window.removeEventListener('keydown', this.handleKeyDown)
		document.removeEventListener('visibilitychange', this.onVisibilityChange)
		window.removeEventListener('resize', this.redrawMenuBar)
		if (this.$menuSizeInterval !== undefined) {
			clearInterval(this.$menuSizeInterval)
		}
	},

	methods: {
		// Re-measure the header width into reactive state so
		// threadInlineMenuSize recomputes. Deferred to nextTick so the read
		// happens after any layout change that triggered it.
		redrawMenuBar() {
			this.$nextTick(() => {
				this.threadHeaderWidth = this.$refs.threadHeader?.clientWidth ?? 0
			})
		},

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

		// --- thread-level actions (the header's ⋮ menu) ---

		// Leaves the reading pane back to the source mailbox. Used after a
		// whole-thread action removes the conversation from view.
		closeThread() {
			this.$router.replace({
				name: 'mailbox',
				params: {
					mailboxId: this.$route.params.mailboxId,
				},
			})
		},

		// After the whole thread is removed (deleted/moved/junked/snoozed),
		// advance exactly the way single-message removal already does: emit
		// 'delete', which MailboxThread forwards to the mailbox list's own
		// onDelete(). That advances using the list component's *own*
		// mailbox + query -- always correct, including in the unified/Priority
		// Inbox sections -- and honours the "auto-advance" preference
		// (next/previous/back-to-list) itself, so the logic lives in exactly
		// one place. (Thread's own listNavigation, by contrast, resolved empty
		// for Priority Inbox sections and sent every thread removal back to
		// the list.) When the thread wasn't opened from a list at all -- a
		// direct URL, bookmark or notification -- there's no list to advance
		// within, so just close the reading pane.
		advanceAfterRemoval() {
			if (this.mainStore.lastOpenedFromList) {
				this.$emit('delete', this.threadId)
				return
			}
			this.closeThread()
		},

		// Mark every message in the thread read (targetSeen=true) or unread
		// (false). Only the ones that actually differ are toggled. Reversible
		// and cheap, so no undo toast -- unlike the removal actions below.
		markThreadSeen(targetSeen) {
			Promise.all(this.thread
				.filter((envelope) => Boolean(envelope.flags.seen) !== targetSeen)
				.map((envelope) => this.mainStore.toggleEnvelopeSeen({ envelope }))).catch((error) => {
				logger.error('could not update thread read state', { error })
				showError(t('mail', 'Could not update read status'))
			})
		},

		archiveThread() {
			const account = this.threadAccount
			if (!account?.archiveMailboxId) {
				return
			}
			this.moveThreadOut(account.archiveMailboxId, t('mail', 'Thread archived'))
		},

		onThreadMove({ destMailboxId }) {
			this.showMoveModal = false
			this.moveThreadOut(destMailboxId, t('mail', 'Thread moved'))
		},

		// Shared by Archive and Move: relocate the whole thread, close the
		// reading pane immediately (per performActionWithUndo's contract:
		// navigate before awaiting), and offer an undo toast.
		moveThreadOut(destMailboxId, message) {
			const root = this.thread.find((envelope) => envelope.databaseId === this.threadId) || this.thread[0]
			if (!root) {
				return
			}
			const ids = this.thread.map((envelope) => envelope.databaseId)
			this.performActionWithUndo({
				ids,
				message,
				action: async () => {
					await this.mainStore.moveThread({ envelope: root, destMailboxId })
					await this.mainStore.syncEnvelopes({ mailboxId: destMailboxId })
				},
			}).catch((error) => {
				logger.error('could not move thread', { error })
				showError(t('mail', 'Could not move thread'))
			})
			this.advanceAfterRemoval()
		},

		deleteThreadAction() {
			const root = this.thread.find((envelope) => envelope.databaseId === this.threadId) || this.thread[0]
			if (!root) {
				return
			}
			const ids = this.thread.map((envelope) => envelope.databaseId)
			this.performActionWithUndo({
				ids,
				message: t('mail', 'Thread deleted'),
				action: async () => {
					await this.mainStore.deleteThread({ envelope: root })
				},
			}).catch(async (error) => {
				showError(await matchError(error, {
					[NoTrashMailboxConfiguredError.getName()]() {
						return t('mail', 'No trash folder configured')
					},
					default(error) {
						logger.error('could not delete thread', { error })
						return t('mail', 'Could not delete thread')
					},
				}))
			})
			this.advanceAfterRemoval()
		},

		// Mark every message in the thread as spam / not-spam. Junking moves
		// the messages to the account's Junk mailbox (and un-junking moves
		// them back to the inbox) whenever one is configured, so the thread
		// leaves the current list -- exactly like single-message junk and the
		// other whole-thread removal actions. Mirror them: hide it at once
		// behind the undo window and advance, instead of only flipping a flag
		// and lingering in the list until the server-side move syncs back tens
		// of seconds later. Only the messages whose state differs are toggled.
		junkThread() {
			const wasJunk = this.threadIsJunk
			const targetJunk = !wasJunk
			const envelopes = this.thread.filter((envelope) => Boolean(envelope.flags?.$junk) !== targetJunk)
			if (envelopes.length === 0) {
				return
			}
			// Whether this toggle actually moves folders (a Junk mailbox is
			// configured) -- if not, it's a pure flag change that stays put.
			const removeEnvelope = this.mainStore.junkMoveDestinationMailboxId(envelopes[0]) !== null
			this.performActionWithUndo({
				ids: removeEnvelope ? envelopes.map((envelope) => envelope.databaseId) : [],
				message: wasJunk ? t('mail', 'Thread marked as not spam') : t('mail', 'Thread marked as spam'),
				action: async () => {
					await Promise.all(envelopes.map((envelope) => this.mainStore.toggleEnvelopeJunk({ envelope, removeEnvelope })))
				},
			}).catch((error) => {
				logger.error('could not update thread spam status', { error })
				showError(t('mail', 'Could not update spam status'))
			})
			if (removeEnvelope) {
				this.advanceAfterRemoval()
			}
		},

		setCustomSnoozeDateTime(event) {
			this.customSnoozeDateTime = new Date(event.target.value)
		},

		// Snooze the whole thread until `timestamp` (ms). Ensures the snooze
		// mailbox exists first (one-time, idempotent, not itself undoable),
		// then defers the move behind the undo window and closes the reading
		// pane -- the thread leaves the current mailbox for the snooze folder.
		async snoozeThreadAt(timestamp) {
			this.threadSnoozeOpen = false
			if (timestamp === null || timestamp === undefined) {
				return
			}
			const account = this.threadAccount
			const root = this.thread.find((envelope) => envelope.databaseId === this.threadId) || this.thread[0]
			if (!account || !root) {
				return
			}
			if (!account.snoozeMailboxId) {
				await this.mainStore.createAndSetSnoozeMailbox(account)
			}
			const ids = this.thread.map((envelope) => envelope.databaseId)
			this.performActionWithUndo({
				ids,
				message: t('mail', 'Thread snoozed'),
				action: async () => {
					await this.mainStore.snoozeThread({
						envelope: root,
						unixTimestamp: Math.floor(timestamp / 1000),
						destMailboxId: account.snoozeMailboxId,
					})
				},
			}).catch((error) => {
				logger.error('could not snooze thread', { error })
				showError(t('mail', 'Could not snooze thread'))
			})
			this.advanceAfterRemoval()
		},

		async unSnoozeThreadAction() {
			const root = this.thread.find((envelope) => envelope.databaseId === this.threadId) || this.thread[0]
			if (!root) {
				return
			}
			try {
				await this.mainStore.unSnoozeThread({ envelope: root })
			} catch (error) {
				logger.error('could not unsnooze thread', { error })
				showError(t('mail', 'Could not unsnooze thread'))
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
			// A different conversation -- collapse the subject back to its
			// one-line form so a previously tapped-open long subject doesn't
			// carry over, and reset the ⋮ menu's snooze submenu.
			this.subjectExpanded = false
			this.threadSnoozeOpen = false

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

			// Provisional: at this point the store usually knows only the
			// envelope that was clicked, because the thread listing has not
			// been fetched yet. initiallyExpandedEnvelopeId() therefore looks
			// for "the oldest unread" in a collection of one, and settles on
			// the clicked message -- the newest, since that is what a list row
			// stands for. Older unread replies in the same thread never got a
			// say, which is exactly the reported symptom: the thread opens on
			// the newest message while older unread ones sit above it.
			//
			// Kept as a first guess rather than deferred entirely, because it
			// gives the body fetch below a head start; the answer is revised
			// once the thread resolves.
			const provisionallyExpanded = this.initiallyExpandedEnvelopeId()
			this.expandedThreads = [provisionallyExpanded]
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

				// The siblings are known now, so ask again. Only when the
				// guess above is still exactly what is expanded: the fetch can
				// take a while on this hardware, and a user who has already
				// opened something else in the meantime must not have it
				// closed under them.
				if (
					this.expandedThreads.length === 1
					&& this.expandedThreads[0] === provisionallyExpanded
				) {
					const oldestUnread = this.initiallyExpandedEnvelopeId()
					if (oldestUnread !== provisionallyExpanded) {
						logger.debug('expanding the oldest unread message in the thread instead of the clicked one', {
							clicked: provisionallyExpanded,
							oldestUnread,
						})
						this.expandedThreads = [oldestUnread]
					}
				}
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

// Compact, fixed-height conversation header: two stacked rows -- subject +
// thread ⋮ menu, then a meta line ("N messages · X people") + prev/next.
// The subject is clamped to a single line (see #mail-thread-header-fields h2)
// so the header no longer balloons on a long subject, which also removes the
// old empty gap around the vertically-centred nav buttons.
$mail-thread-header-inline-start: calc(var(--default-grid-baseline) * 14 + var(--border-radius-container) + 2px);

#mail-thread-header {
	display: flex;
	flex-direction: column;
	gap: 0;
	// Symmetric vertical rhythm: the same 1.5-baseline breathing room above the
	// subject and below the meta line (was 0 on top vs ~1.5-baseline + the 5px
	// margin-bottom below -- a lopsided ~1:6 gap). The top padding is the single
	// source for the subject's top breathing room now (the h2's own padding-top
	// was removed), so it can't stack unpredictably with a second half-gap.
	padding: calc(var(--default-grid-baseline) * 1.5) 0 calc(var(--default-grid-baseline) * 1.5) 0;
	// somehow ios doesn't care about this !important rule
	// so we have to manually set left/right padding to chidren
	// for 100% to be used
	box-sizing: content-box !important;
	width: 100%;
	background: var(--color-main-background);

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
        // Pin flush at the very top so it never moves on scroll. The mobile
        // back button (.app-details-toggle, NcAppContent) is itself a sticky
        // element sitting in the flow ABOVE this content, so at rest the
        // header started ~32px lower than its pinned (top:0) position and
        // "jumped up" on the first scroll. The negative margin cancels that
        // flow block so the resting position already equals the pinned one --
        // this is the margin-top:-32px hack the pre-redesign single-row header
        // carried on its fields, restored here on the whole two-row header.
        top: 0 !important;
        margin-top: -32px !important;
        // Breathing room under the blue app bar, roughly matching the gap down
        // to the meta line. Independent of the pin above: it grows the header
        // downward from its (flush) top edge, it doesn't move that edge.
        padding-top: calc(var(--default-grid-baseline) * 2) !important;
    }
}

#mail-thread-header-top {
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: var(--default-grid-baseline);
	min-width: 0;
}

#mail-thread-header-fields {
	min-width: 0;
	// while scrolling, the back button overlaps with subject on small screen
	// envelope margin (2×baseline) + border (2px) + header padding (--border-radius-container) + avatar (10×baseline) + sender margin (2×baseline)
	padding-inline-start: $mail-thread-header-inline-start;
	flex: 1 1 auto;

	h2 {
		margin: 0;
		// Top breathing room lives on #mail-thread-header's padding now (one
		// source of truth), so no padding here.
		padding: 0;
		// override the server's oversized h2 -- a compact single line
		font-size: 16px;
		line-height: 1.25;
		font-weight: bold;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;

		// Tapped open: show the whole subject, wrapped, instead of truncated.
		&.thread-subject--expanded {
			white-space: normal;
			overflow: visible;
			text-overflow: clip;
		}
	}
}

#mail-thread-menu {
	flex: 0 0 auto;
}

#mail-thread-header-meta {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: space-between;
	gap: var(--default-grid-baseline);
	min-width: 0;
	padding-inline-start: $mail-thread-header-inline-start;

	.thread-meta {
		min-width: 0;
		font-size: 12px;
		color: var(--color-text-maxcontrast);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
}

#mail-thread-list-navigation {
	display: flex;
	flex: 0 0 auto;
	gap: var(--default-grid-baseline);
	margin-inline-end: var(--default-grid-baseline);
}

// Both header rows centre their text against the 44px default clickable area
// of the buttons beside it -- the promoted ⋮-menu actions on the subject row,
// prev/next on the meta line -- which leaves a wide empty band under the
// subject and above the meta line (the "unnecessary gap" between the title and
// the "N messages · X people" line). On a pointer-driven desktop layout a more
// compact target is plenty and lets each row hug its own text. Left at the full
// 44px touch target below the mobile breakpoint, where it matters.
@media only screen and (min-width: #{variables.$breakpoint-mobile}) {
	#mail-thread-menu .button-vue,
	#mail-thread-list-navigation .button-vue {
		min-height: 32px;
		height: 32px;
		min-width: 32px;
		width: 32px;
	}
}

@media only screen and (max-width: #{variables.$breakpoint-mobile}) {
	#mail-thread-header-fields,
	#mail-thread-header-meta {
		padding-inline-start: 48px;
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
