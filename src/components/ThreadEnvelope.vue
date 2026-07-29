<!--
  - SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<div
		ref="envelope"
		:data-thread-id="envelope.databaseId"
		class="envelope"
		:class="{ 'envelope--expanded': expanded }">
		<div
			v-if="showFollowUpHeader"
			class="envelope__follow-up-header">
			<span class="envelope__follow-up-header__date">
				{{ t('mail', "You've sent this message on {date}", { date: formattedSentAt }) }}
			</span>
			<div class="envelope__follow-up-header__actions">
				<NcButton @click="onDisableFollowUpReminder">
					{{ t('mail', 'Disable reminder') }}
				</NcButton>
			</div>
		</div>

		<div
			ref="header"
			class="envelope__header">
			<div class="envelope__header__avatar">
				<Avatar
					v-if="envelope.from && envelope.from[0]"
					:email="envelope.from[0].email"
					:display-name="envelope.from[0].label"
					:disable-tooltip="true"
					:size="40"
					:fetch-avatar="envelope.fetchAvatarFromClient"
					:avatar="envelope.avatar"
					class="envelope__header__avatar-avatar" />
				<div
					v-if="isImportant"
					class="app-content-list-item-star icon-important"
					:data-starred="isImportant ? 'true' : 'false'"
					@click.prevent="hasWriteAcl ? onToggleImportant() : false"
					v-html="importantSvg" />
				<IconFavorite
					v-if="envelope.flags.flagged"
					fill-color="#f9cf3d"
					:size="18"
					class="app-content-list-item-star favorite-icon-style"
					:data-starred="envelope.flags.flagged ? 'true' : 'false'"
					@click.prevent="hasWriteAcl ? onToggleFlagged() : false" />
				<TasksAppIcon
					v-if="envelope.flags.hasTask"
					:size="14"
					haloed
					class="app-content-list-item-star task-icon-style"
					:title="t('mail', 'A task was created from this message')" />
				<TasksAppIcon
					v-else-if="envelope.flags.hasTaskInThread"
					:size="14"
					outlined
					haloed
					class="app-content-list-item-star task-icon-style thread-context-badge--task"
					:title="t('mail', 'The conversation has a message with a task')" />
				<JunkIcon
					v-if="envelope.flags.$junk"
					:size="18"
					class="app-content-list-item-star junk-icon-style"
					:data-starred="envelope.flags.$junk ? 'true' : 'false'"
					@click.prevent="hasWriteAcl ? onToggleJunk() : false" />
			</div>

			<div
				class="left"
				:class="{ seen: envelope.flags.seen }"
				role="button"
				tabindex="0"
				@click="$emit('toggle-expand', $event)"
				@keydown.enter="$emit('toggle-expand', $event)"
				@keydown.space.prevent="$emit('toggle-expand', $event)"
				@mouseenter="onEnvelopeMouseEnter"
				@mouseleave="onEnvelopeMouseLeave"
				@touchstart.passive="onEnvelopeTouchStart"
				@touchmove.passive="cancelHoverPrefetch">
				<div class="envelope__header__left__sender-subject-tags">
					<div class="sender" :class="{ 'sender--expanded': expanded }">
						{{ envelope.from && envelope.from[0] ? envelope.from[0].label : '' }}
					</div>
					<!-- The sender-address / details toggle sits in the sender
					     cell (natural, fits the UI). It's the discoverable way
					     into the full From/To/Cc; the Unsubscribe button was
					     moved out to its own row below so it can no longer crowd
					     and clip this toggle. -->
					<NcButton
						v-if="expanded"
						type="button"
						class="sender__email sender__email--toggle"
						size="small"
						variant="tertiary"
						alignment="start-reverse"
						:aria-label="t('mail', 'Show sender and recipient details')"
						:style="{ '--font-weight-element': 'normal' }"
						@click.stop.prevent="showRecipients = !showRecipients">
						{{ senderEmail || t('mail', 'Details') }}
						<template #icon>
							<ChevronUpIcon v-if="showRecipients" :size="16" />
							<ChevronDownIcon v-else :size="16" />
						</template>
					</NcButton>
					<div v-if="hasChangedSubject" class="subline">
						{{ cleanSubject }}
					</div>
					<div v-if="showSubline" class="subline">
						<span class="preview">
							{{ isEncrypted ? t('mail', 'Encrypted message') : envelope.previewText }}
						</span>
					</div>
					<div class="tagline">
						<div
							v-for="tag in tags"
							:key="tag.id"
							class="tag-group">
							<div
								class="tag-group__bg"
								:style="{ 'background-color': tag.color }" />
							<span
								class="tag-group__label"
								:style="{ color: tag.color }">
								{{ translateTagDisplayName(tag) }}
							</span>
						</div>
					</div>
				</div>
			</div>
			<div class="right">
				<Moment class="timestamp" :timestamp="envelope.dateInt" />
				<template v-if="expanded">
					<NcActions v-if="smimeData.isSigned || smimeData.isEncrypted">
						<template #icon>
							<LockPlusIcon
								v-if="smimeData.isEncrypted"
								:size="20"
								fill-color="#008000" />
							<LockIcon
								v-else-if="smimeData.signatureIsValid"
								:size="20"
								fill-color="#008000" />
							<LockOffIcon
								v-else
								:size="20"
								fill-color="red" />
						</template>
						<NcActionText class="smime-text" :name="smimeHeading">
							{{ smimeMessage }}
						</NcActionText>
						<!-- TODO: display information about signer and/or CA certificate -->
					</NcActions>
					<NcActions :inline="inlineMenuSize">
						<NcActionButton
							:close-after-click="true"
							@click="onReply('', false)">
							<template #icon>
								<ReplyAllIcon
									v-if="hasMultipleRecipients"
									:title="t('mail', 'Reply all')"
									:size="20" />
								<ReplyIcon
									v-else
									:title="t('mail', 'Reply')"
									:size="20" />
							</template>
							{{ t('mail', 'Reply') }}
						</NcActionButton>
						<NcActionButton
							v-if="hasMultipleRecipients"
							:close-after-click="true"
							@click="onReply('', false, true)">
							<template #icon>
								<ReplyIcon
									:title="t('mail', 'Reply to sender only')"
									:size="20" />
							</template>
							{{ t('mail', 'Reply to sender only') }}
						</NcActionButton>
						<NcActionButton
							v-if="hasWriteAcl && (inlineMenuSize >= 2 || !moreActionsOpen)"
							type="tertiary-no-background"
							class="action--primary"
							:aria-label="envelope.flags.flagged ? t('mail', 'Mark as unfavorite') : t('mail', 'Mark as favorite')"
							:close-after-click="true"
							@click.prevent="onToggleFlagged">
							<template #icon>
								<IconFavorite
									v-if="showFavoriteIconVariant"
									:title="t('mail', 'Mark as unfavorite')"
									:size="20" />
								<StarOutline
									v-else
									:title="t('mail', 'Mark as favorite')"
									:size="20" />
							</template>
							{{ envelope.flags.flagged ? t('mail', 'Mark as unfavorite') : t('mail', 'Mark as favorite') }}
						</NcActionButton>
						<NcActionButton
							v-if="hasSeenAcl && (inlineMenuSize >= 3 || !moreActionsOpen)"
							type="tertiary-no-background"
							class="action--primary"
							:aria-label="envelope.flags.seen ? t('mail', 'Mark as unread') : t('mail', 'Mark as read')"
							:close-after-click="true"
							@click.prevent="onToggleSeen">
							<template #icon>
								<EmailRead
									v-if="showImportantIconVariant"
									:title="t('mail', 'Mark as unread')"
									:size="20" />
								<EmailUnread
									v-else
									:title="t('mail', 'Mark as read')"
									:size="20" />
							</template>
							{{ envelope.flags.seen ? t('mail', 'Mark as unread') : t('mail', 'Mark as read') }}
						</NcActionButton>
						<NcActionButton
							v-if="showArchiveButton && hasArchiveAcl && (inlineMenuSize >= 4 || !moreActionsOpen)"
							:close-after-click="true"
							:disabled="disableArchiveButton"
							:aria-label="t('mail', 'Archive message')"
							type="tertiary-no-background"
							@click.prevent="onArchive">
							<template #icon>
								<ArchiveIcon
									:title="t('mail', 'Archive message')"
									:size="20" />
							</template>
							{{ t('mail', 'Archive message') }}
						</NcActionButton>
						<NcActionButton
							v-if="hasDeleteAcl && (inlineMenuSize >= 5 || !moreActionsOpen)"
							:close-after-click="true"
							:aria-label="t('mail', 'Delete message')"
							type="tertiary-no-background"
							@click.prevent="onDelete">
							<template #icon>
								<DeleteIcon
									:title="t('mail', 'Delete message')"
									:size="20" />
							</template>
							{{ t('mail', 'Delete message') }}
						</NcActionButton>
						<!-- Opening the task lives HERE, in the message's own
						     overflow menu, rather than as an icon beside the
						     sender. That inline marker had nowhere to go at phone
						     widths: the sender cell is the first thing this layout
						     squeezes, so the affordance vanished on exactly the
						     device that could least afford to lose it -- there is
						     no hover on a touch screen to reveal it either.

						     An action in the ... menu is what Nextcloud uses for
						     anything secondary and per-item: it is labelled rather
						     than guessed at, it survives every width because the
						     menu collapses instead of clipping, and it is where
						     "Create task" already lives, so the way back sits next
						     to the way in. The avatar badge keeps saying THAT there
						     is a task; the menu carries the verb. -->
						<NcActionLink
							v-for="task in tasks"
							:key="task.taskUid"
							:href="taskUrl(task)"
							target="_blank"
							:close-after-click="true">
							<template #icon>
								<!-- 16, not the 20 the outline glyphs beside it use:
								     this mark is a SOLID tile, so at the same box it
								     carries far more ink and reads bigger. 16px is
								     also what Nextcloud sizes an action's own icon
								     at (`background-size: 16px` on .action-link__icon). -->
								<TasksAppIcon :size="16" />
							</template>
							{{ task.summary ? t('mail', 'Open task "{summary}"', { summary: task.summary }) : t('mail', 'Open task') }}
						</NcActionLink>
						<MenuEnvelope
							class="app-content-list-item-menu"
							:envelope="envelope"
							:mailbox="mailbox"
							:with-select="false"
							:with-show-source="true"
							:more-actions-open.sync="moreActionsOpen"
							@reply="onReply('', false, false)"
							@delete="$emit('delete', envelope.databaseId)"
							@request-toggle-junk-one="$emit('request-toggle-junk-one', $event)"
							@request-snooze="$emit('request-snooze', $event)"
							@show-source-modal="onShowSourceModal"
							@open-tag-modal="onOpenTagModal"
							@open-move-modal="onOpenMoveModal"
							@open-event-modal="onOpenEventModal"
							@open-task-modal="onOpenTaskModal"
							@open-translation-modal="onOpenTranslationModal"
							@open-mail-filter-from-envelope="showMailFilterFromEnvelope = true"
							@print="onPrint" />
					</NcActions>
					<SourceModal
						v-if="showSourceModal"
						:raw-message="rawMessage"
						@close="onCloseSourceModal" />
					<MoveModal
						v-if="showMoveModal"
						:account="account"
						:envelopes="[envelope]"
						@move="onMove"
						@request-move="$emit('request-move', $event)"
						@close="onCloseMoveModal" />
					<EventModal
						v-if="showEventModal"
						:envelope="envelope"
						@close="onCloseEventModal" />
					<TaskModal
						v-if="showTaskModal"
						:envelope="envelope"
						@close="onCloseTaskModal" />
					<TagModal
						v-if="showTagModal"
						:account="account"
						:envelopes="[envelope]"
						@close="onCloseTagModal" />
					<TranslationModal
						v-if="showTranslationModal"
						:rich-parameters="{}"
						:message="plainTextBody"
						@close="onCloseTranslationModal" />
					<MailFilterFromEnvelope
						v-if="showMailFilterFromEnvelope"
						:account="account"
						:envelope="envelope"
						@close="showMailFilterFromEnvelope = false" />
				</template>
			</div>
		</div>
		<!-- Unsubscribe on its own row below the header instead of crammed into
		     the sender cell, where it used to clip the details toggle. -->
		<div
			v-if="message && message.dkimValid && (message.unsubscribeUrl || message.unsubscribeMailto)"
			class="envelope__unsubscribe-row">
			<NcButton
				variant="tertiary"
				class="envelope__header__unsubscribe"
				@click.stop="showListUnsubscribeConfirmation = true">
				<template #icon>
					<EmailOffIcon :size="16" />
				</template>
				{{ t('mail', 'Unsubscribe') }}
			</NcButton>
		</div>
		<div v-if="expanded && showRecipients" class="envelope__recipients">
			<div v-if="envelope.from && envelope.from.length" class="recipients">
				<span class="recipients__label">{{ t('mail', 'From:') }}</span>
				<RecipientBubble
					v-for="recipient in envelope.from"
					:key="recipient.email"
					:email="recipient.email"
					:label="recipient.label"
					:size="24" />
			</div>
			<div v-if="envelope.to && envelope.to.length" class="recipients">
				<span class="recipients__label">{{ t('mail', 'To:') }}</span>
				<div class="recipients__list">
					<RecipientBubble
						v-for="(recipient, index) in envelope.to"
						:key="`${recipient.email}-${index}`"
						:email="recipient.email"
						:label="recipient.label"
						:size="24" />
				</div>
			</div>
			<div v-if="envelope.cc && envelope.cc.length" class="recipients">
				<span class="recipients__label">{{ t('mail', 'Cc:') }}</span>
				<div class="recipients__list">
					<RecipientBubble
						v-for="(recipient, index) in envelope.cc"
						:key="`${recipient.email}-${index}`"
						:email="recipient.email"
						:label="recipient.label"
						:size="24" />
				</div>
			</div>
			<div v-if="envelope.bcc && envelope.bcc.length" class="recipients">
				<span class="recipients__label">{{ t('mail', 'Bcc:') }}</span>
				<div class="recipients__list">
					<RecipientBubble
						v-for="(recipient, index) in envelope.bcc"
						:key="`${recipient.email}-${index}`"
						:email="recipient.email"
						:label="recipient.label"
						:size="24" />
				</div>
			</div>
		</div>
		<MessageLoadingSkeleton v-if="loading === Loading.Skeleton" />
		<Message
			v-if="message"
			v-show="loading === Loading.Done"
			:envelope="envelope"
			:message="message"
			:full-height="fullHeight"
			:smart-replies="showFollowUpHeader ? [] : smartReplies"
			:reply-button-label="replyButtonLabel"
			@load="onMessageLoaded"
			@translate="onOpenTranslationModal"
			@reply="(body) => onReply(body, showFollowUpHeader)" />
		<Error
			v-else-if="error"
			:error="messageFetchError"
			message=""
			:data="error"
			:auto-margin="true"
			role="alert" />
		<ConfirmModal
			v-if="message && message.unsubscribeUrl && message.isOneClickUnsubscribe && showListUnsubscribeConfirmation"
			:confirm-text="t('mail', 'Unsubscribe')"
			:title="t('mail', 'Unsubscribe via link')"
			@cancel="showListUnsubscribeConfirmation = false"
			@confirm="unsubscribeViaOneClick">
			{{ t('mail', 'Unsubscribing will stop all messages from the mailing list {sender}', { sender: from }) }}
		</ConfirmModal>
		<ConfirmModal
			v-else-if="message && message.unsubscribeUrl && showListUnsubscribeConfirmation"
			:confirm-text="t('mail', 'Unsubscribe')"
			:confirm-url="message.unsubscribeUrl"
			:title="t('mail', 'Unsubscribe via link')"
			@cancel="showListUnsubscribeConfirmation = false"
			@confirm="showListUnsubscribeConfirmation = false">
			{{ t('mail', 'Unsubscribing will stop all messages from the mailing list {sender}', { sender: from }) }}
		</ConfirmModal>
		<ConfirmModal
			v-else-if="message && message.unsubscribeMailto && showListUnsubscribeConfirmation"
			:confirm-text="t('mail', 'Send unsubscribe email')"
			:title="t('mail', 'Unsubscribe via email')"
			:disabled="unsubscribing"
			@cancel="showListUnsubscribeConfirmation = false"
			@confirm="unsubscribeViaMailto">
			{{ t('mail', 'Unsubscribing will stop all messages from the mailing list {sender}', { sender: from }) }}
		</ConfirmModal>
	</div>
</template>

<script>
import axios from '@nextcloud/axios'
import { loadState } from '@nextcloud/initial-state'
import moment from '@nextcloud/moment'
import { generateUrl } from '@nextcloud/router'
import { NcActionButton, NcActionLink, NcButton } from '@nextcloud/vue'
import { mapStores } from 'pinia'
import NcActions from '@nextcloud/vue/components/NcActions'
import NcActionText from '@nextcloud/vue/components/NcActionText'
import ArchiveIcon from 'vue-material-design-icons/ArchiveArrowDownOutline.vue'
import ChevronDownIcon from 'vue-material-design-icons/ChevronDown.vue'
import ChevronUpIcon from 'vue-material-design-icons/ChevronUp.vue'
import EmailOffIcon from 'vue-material-design-icons/EmailOffOutline.vue'
import EmailRead from 'vue-material-design-icons/EmailOpenOutline.vue'
import EmailUnread from 'vue-material-design-icons/EmailOutline.vue'
import LockOffIcon from 'vue-material-design-icons/LockOffOutline.vue'
import LockIcon from 'vue-material-design-icons/LockOutline.vue'
import LockPlusIcon from 'vue-material-design-icons/LockPlusOutline.vue'
import ReplyAllIcon from 'vue-material-design-icons/ReplyAllOutline.vue'
import ReplyIcon from 'vue-material-design-icons/ReplyOutline.vue'
import IconFavorite from 'vue-material-design-icons/Star.vue'
import StarOutline from 'vue-material-design-icons/StarOutline.vue'
import DeleteIcon from 'vue-material-design-icons/TrashCanOutline.vue'
import Avatar from './Avatar.vue'
import ConfirmModal from './ConfirmationModal.vue'
import Error from './Error.vue'
import EventModal from './EventModal.vue'
import JunkIcon from './icons/JunkIcon.vue'
import TasksAppIcon from './icons/TasksAppIcon.vue'
import MailFilterFromEnvelope from './mailFilter/MailFilterFromEnvelope.vue'
import MenuEnvelope from './MenuEnvelope.vue'
import Message from './Message.vue'
import MessageLoadingSkeleton from './MessageLoadingSkeleton.vue'
import Moment from './Moment.vue'
import MoveModal from './MoveModal.vue'
import RecipientBubble from './RecipientBubble.vue'
import SourceModal from './SourceModal.vue'
import TagModal from './TagModal.vue'
import TaskModal from './TaskModal.vue'
import TranslationModal from './TranslationModal.vue'
import importantSvg from '../../img/important.svg'
import { isPgpText } from '../crypto/pgp.js'
import logger from '../logger.js'
import HoverPrefetchMixin from '../mixins/HoverPrefetchMixin.js'
import ViewportPrefetchMixin from '../mixins/ViewportPrefetchMixin.js'
import { buildRecipients as buildReplyRecipients } from '../ReplyBuilder.js'
import { smartReply } from '../service/AiIntergrationsService.js'
import { unsubscribe } from '../service/ListService.js'
import { taskDeepLink, taskUriOf } from '../service/MessageTaskService.js'
import { FOLLOW_UP_TAG_LABEL } from '../store/constants.js'
import useMainStore from '../store/mainStore.js'
import useOutboxStore from '../store/outboxStore.js'
import { mailboxHasRights } from '../util/acl.js'
import { translateTagDisplayName } from '../util/tag.js'
import { Text, toPlain } from '../util/text.js'
import { showError, showSuccess } from '../util/toast.js'
import { hiddenTags } from './tags.js'

// Ternary loading state
const Loading = Object.seal({
	Done: 0,
	Silent: 1,
	Skeleton: 2,
})
const SUPPLEMENTARY_FETCH_DELAY_MS = 250
const CANCELLED_MESSAGE_RETRY_DELAY_MS = 500

function isRequestCancellation(error) {
	return axios.isCancel(error)
		|| ['AbortError', 'CanceledError', 'TimeoutError'].includes(error?.name)
}

function isSupplementaryCapacityError(error) {
	return [425, 429].includes(error?.httpStatus ?? error?.response?.status)
}

export default {
	name: 'ThreadEnvelope',
	components: {
		TasksAppIcon,
		MailFilterFromEnvelope,
		EventModal,
		TaskModal,
		MoveModal,
		TagModal,
		TranslationModal,
		ConfirmModal,
		Avatar,
		RecipientBubble,
		NcActionButton,
		NcActionLink,
		NcButton,
		Error,
		IconFavorite,
		JunkIcon,
		MessageLoadingSkeleton,
		MenuEnvelope,
		Moment,
		Message,
		StarOutline,
		EmailRead,
		EmailUnread,
		DeleteIcon,
		ArchiveIcon,
		ChevronDownIcon,
		ChevronUpIcon,
		EmailOffIcon,
		LockIcon,
		LockOffIcon,
		LockPlusIcon,
		NcActions,
		NcActionText,
		ReplyIcon,
		ReplyAllIcon,
		SourceModal,
	},

	mixins: [HoverPrefetchMixin, ViewportPrefetchMixin],

	props: {
		envelope: {
			required: true,
			type: Object,
		},

		/**
		 * Tasks indexed against THIS message, passed down rather than fetched
		 * here: the thread asks once for the whole conversation, because a
		 * request per message is the shape the index exists to avoid.
		 */
		tasks: {
			required: false,
			type: Array,
			default: () => [],
		},

		mailboxId: {
			required: false,
			type: [
				String,
				Number,
			],

			default: undefined,
		},

		expanded: {
			required: false,
			type: Boolean,
			default: false,
		},

		fullHeight: {
			required: false,
			type: Boolean,
			default: false,
		},

		withSelect: {
			// "Select" action should only appear in envelopes from the envelope list
			type: Boolean,
			default: true,
		},

		threadSubject: {
			required: true,
			type: String,
		},

		threadIndex: {
			required: true,
			type: Number,
		},
	},

	data() {
		return {
			loading: Loading.Done,
			showRecipients: false,
			showListUnsubscribeConfirmation: false,
			error: undefined,
			message: undefined,
			importantSvg,
			unsubscribing: false,
			seenTimer: undefined,
			Loading,
			recomputeMenuSize: 0,
			moreActionsOpen: false,
			smartReplies: [],
			showSourceModal: false,
			showMoveModal: false,
			showEventModal: false,
			showTaskModal: false,
			showTagModal: false,
			showTranslationModal: false,
			plainTextBody: '',
			rawMessage: '', // Will hold the raw source of the message when requested
			isInternal: true,
			enabledFreePrompt: loadState('mail', 'llm_freeprompt_available', false),
			loadingBodyTimeout: undefined,
			supplementaryFetchHandle: undefined,
			supplementaryFetchController: undefined,
			showMailFilterFromEnvelope: false,
			messageFetchRetryCount: 0,
			messageFetchRetryTimeout: undefined,
		}
	},

	computed: {
		...mapStores(useOutboxStore, useMainStore),
		messageFetchError() {
			if (this.error?.isTransient) {
				return this.t('mail', 'The mail server is temporarily busy. Please try again.')
			}
			return this.error?.message || this.t('mail', 'Not found')
		},

		senderEmail() {
			return this.envelope.from?.[0]?.email ?? ''
		},

		inlineMenuSize() {
			const { envelope } = this.$refs
			const envelopeWidth = (envelope && envelope.clientWidth) || 250
			const spaceToFill = envelopeWidth - 500 + this.recomputeMenuSize

			if (envelopeWidth < 400) {
				return 0
			}

			return Math.floor(spaceToFill / 44)
		},

		account() {
			return this.mainStore.getAccount(this.envelope.accountId)
		},

		senderEmailColor() {
			if (this.isInternal) {
				return 'var(--color-text-maxcontrast)'
			}

			return parseInt(this.mainStore.getNcVersion) >= 32 ? 'var(--color-text-error)' : 'var(--color-error)'
		},

		from() {
			if (!this.message || !this.message.from.length) {
				return '?'
			}
			if (this.message.from[0].label) {
				return this.message.from[0].label
			}
			return this.message.from[0].email
		},

		hasMultipleRecipients() {
			if (!this.account) {
				logger.error('account is undefined', {
					accountId: this.envelope.accountId,
				})
			}
			const recipients = buildReplyRecipients(this.envelope, {
				label: this.account.name,
				email: this.account.emailAddress,
			})
			return recipients.to.concat(recipients.cc).length > 1
		},

		isEncrypted() {
			return this.envelope.previewText
				&& isPgpText(this.envelope.previewText)
		},

		// Per-copy flag, not the user-wide tag -- see Envelope.vue's own
		// isImportant() for the multi-account divergence this avoids.
		isImportant() {
			return this.envelope.flags.important === true
		},

		tags() {
			return this.mainStore.getEnvelopeTags(this.envelope.databaseId).filter((tag) => tag.imapLabel !== '$label1' && !(tag.displayName.toLowerCase() in hiddenTags))
		},

		hasChangedSubject() {
			return this.cleanSubject !== this.cleanThreadSubject
		},

		cleanSubject() {
			return this.filterSubject(this.envelope.subject)
		},

		cleanThreadSubject() {
			return this.filterSubject(this.threadSubject)
		},

		showSubline() {
			return !this.expanded && !!this.envelope.previewText
		},

		showArchiveButton() {
			return this.account.archiveMailboxId !== null
		},

		disableArchiveButton() {
			return this.account.archiveMailboxId !== null
				&& this.account.archiveMailboxId === this.mailbox.databaseId
		},

		junkFavoritePosition() {
			return this.showSubline && this.tags.length > 0
		},

		showFavoriteIconVariant() {
			return this.envelope.flags.flagged
		},

		showImportantIconVariant() {
			return this.envelope.flags.seen
		},

		hasSeenAcl() {
			return mailboxHasRights(this.mailbox, 's')
		},

		hasArchiveAcl() {
			const hasDeleteSourceAcl = () => {
				return mailboxHasRights(this.mailbox, 'te')
			}

			const hasCreateDestinationAcl = () => {
				return mailboxHasRights(this.archiveMailbox, 'i')
			}

			return hasDeleteSourceAcl() && hasCreateDestinationAcl()
		},

		hasDeleteAcl() {
			return mailboxHasRights(this.mailbox, 'te')
		},

		hasWriteAcl() {
			return mailboxHasRights(this.mailbox, 'w')
		},

		mailbox() {
			return this.mainStore.getMailbox(this.mailboxId)
		},

		archiveMailbox() {
			return this.mainStore.getMailbox(this.account.archiveMailboxId)
		},

		/**
		 * @return {{isSigned: (boolean|undefined), signatureIsValid: (boolean|undefined)}}
		 */
		smimeData() {
			return this.message?.smime ?? {}
		},

		smimeHeading() {
			if (this.smimeData.isEncrypted) {
				return t('mail', 'Encrypted & verified ')
			}

			if (this.smimeData.signatureIsValid) {
				return t('mail', 'Signature verified')
			}

			return t('mail', 'Signature unverified ')
		},

		smimeMessage() {
			if (this.smimeData.isEncrypted) {
				return t('mail', 'This message was encrypted by the sender before it was sent.')
			}

			if (this.smimeData.signatureIsValid) {
				return t('mail', 'This message contains a verified digital S/MIME signature. The message wasn\'t changed since it was sent.')
			}

			return t('mail', 'This message contains an unverified digital S/MIME signature. The message might have been changed since it was sent or the certificate of the signer is untrusted.')
		},

		/**
		 * A human readable representation of envelope's sent date (without the time).
		 *
		 * @return {string}
		 */
		formattedSentAt() {
			return moment(this.envelope.dateInt * 1000).format('LL')
		},

		/**
		 * @return {boolean}
		 */
		showFollowUpHeader() {
			const tags = this.mainStore.getEnvelopeTags(this.envelope.databaseId)
			return tags.some((tag) => tag.imapLabel === FOLLOW_UP_TAG_LABEL)
		},

		/**
		 * Translated label for the reply button.
		 *
		 * @return {string}
		 */
		replyButtonLabel() {
			if (this.showFollowUpHeader) {
				return t('mail', 'Follow up')
			}

			if (this.hasMultipleRecipients) {
				return t('mail', 'Reply all')
			}

			return t('mail', 'Reply')
		},
	},

	watch: {
		expanded(expanded) {
			if (expanded) {
				this.fetchMessage()
				// Covers Thread.vue correcting its initial guess at which
				// message to auto-expand after the full thread loads (see
				// initiallyExpandedEnvelopeId()) -- mounted() below only
				// scrolls for the envelope that was already expanded when
				// this component was first created.
				this.$nextTick(() => this.handleThreadScrolling())
			} else {
				this.cancelSupplementaryFetches()
				clearTimeout(this.messageFetchRetryTimeout)
				this.messageFetchRetryTimeout = undefined
				this.messageFetchRetryCount = 0
				this.message = undefined
				this.loading = Loading.Done
				this.showRecipients = false
			}
		},

		loading(loading) {
			if (loading !== Loading.Done) {
				return
			}
			this.$emit('loaded')

			// Anchor "mark as read" to the moment the content is actually
			// visible (this.loading reaching Done -- either Message.vue's
			// own @load, or here synchronously for a body-less message),
			// not to when fetchMessage()'s underlying data arrived. Those
			// used to be close enough together not to matter, since a
			// live IMAP fetch dominated the whole open regardless -- but
			// confirmed live after today's message-body caching landed:
			// a cache hit can resolve near-instantly while the actual
			// rendered content still takes its normal time, so the
			// unread marker was clearing while the loading skeleton was
			// still showing, before the user could have possibly seen
			// anything. Guarded on `expanded`: collapsing an
			// already-open, still-unread message also sets loading to
			// Done (just to reset local state, see the expanded watcher
			// above), and must not start this timer too.
			if (this.expanded && !this.envelope.flags.seen && this.hasSeenAcl && this.seenTimer === undefined) {
				logger.info('Starting timer to mark message as seen/read')
				this.seenTimer = setTimeout(() => {
					// This is an idempotent target, never a toggle. The envelope can
					// change while the two-second timer is pending (sync, another
					// component instance, or an earlier request settling); blindly
					// inverting that newer value produced a live seen=false request
					// from this automatic mark-as-read path.
					Promise.resolve(this.mainStore.toggleEnvelopeSeen({
						envelope: this.envelope,
						seen: true,
					})).catch((error) => {
						logger.error('Could not automatically mark message as read', { error })
						showError(t('mail', 'Could not update read status'))
					}).finally(() => {
						this.seenTimer = undefined
					})
				}, 2000)
			}
			if (this.expanded) {
				// Body/HTML is now genuinely visible. Only now may secondary
				// enrichment compete for a network slot.
				this.scheduleSupplementaryFetches()
			}
		},
	},

	async mounted() {
		window.addEventListener('resize', this.redrawMenuBar)
		if (this.expanded) {
			await this.fetchMessage()

			// Only one envelope is expanded at the time of mounting so we can
			// assume that this is the relevant envelope to be scrolled to.
			this.$nextTick(() => this.handleThreadScrolling())
		} else {
			// Already fetched above otherwise -- nothing left to prefetch.
			this.registerViewportPrefetch(() => {
				this.mainStore.fetchMessage(this.envelope.databaseId, { speculative: true }).catch(() => {})
			})
		}
		if (this.mainStore.getPreference('internal-addresses', 'false') === 'true') {
			this.isInternal = this.mainStore.isInternalAddress(this.envelope.from[0].email)
		}
		this.$checkInterval = setInterval(() => {
			const { envelope } = this.$refs
			const isWidthAvailable = (envelope && envelope.clientWidth > 0)
			if (isWidthAvailable) {
				this.redrawMenuBar()
				clearInterval(this.$checkInterval)
			}
		}, 100)
	},

	beforeDestroy() {
		if (this.seenTimer !== undefined) {
			logger.info('Navigating away before seenTimer delay, will not mark message as seen/read')
			clearTimeout(this.seenTimer)
		}
		this.cancelSupplementaryFetches()
		clearTimeout(this.messageFetchRetryTimeout)
		window.removeEventListener('resize', this.redrawMenuBar)
		this.unregisterViewportPrefetch()
	},

	methods: {
		translateTagDisplayName,
		redrawMenuBar() {
			this.$nextTick(() => {
				this.recomputeMenuSize++
			})
		},

		filterSubject(value) {
			return value.replace(/((?:[\t ]*(?:R|RE|F|FW|FWD):[\t ]*)*)/i, '')
		},

		onMessageLoaded() {
			if (this.loadingBodyTimeout) {
				clearTimeout(this.loadingBodyTimeout)
				this.loadingBodyTimeout = undefined
			}

			this.loading = Loading.Done
		},

		onEnvelopeMouseEnter() {
			// Already expanded (or expanding): fetchMessage() below is
			// already in flight or done, nothing to prefetch.
			if (this.expanded) {
				return
			}
			this.startHoverPrefetch(() => {
				this.mainStore.fetchMessage(this.envelope.databaseId, { speculative: true }).catch(() => {})
			})
		},

		onEnvelopeMouseLeave() {
			this.cancelHoverPrefetch()
		},

		onEnvelopeTouchStart() {
			// Touch's equivalent of onEnvelopeMouseEnter() -- see
			// TOUCH_PREFETCH_DELAY_MS in HoverPrefetchMixin.js for why this
			// needs its own much shorter delay instead of reusing the
			// mouse one.
			if (this.expanded) {
				return
			}
			this.startTouchPrefetch(() => {
				this.mainStore.fetchMessage(this.envelope.databaseId, { speculative: true }).catch(() => {})
			})
		},

		async fetchMessage() {
			let loadingTimeout
			const isCached = !!this.mainStore.getMessage(this.envelope.databaseId)
			if (!isCached) {
				loadingTimeout = setTimeout(() => {
					this.loading = Loading.Skeleton
				}, 200)
			}

			this.loading = Loading.Silent
			this.error = undefined
			logger.debug(`fetching thread message ${this.envelope.databaseId}`)

			try {
				this.message = await this.mainStore.fetchMessage(this.envelope.databaseId)
				this.messageFetchRetryCount = 0
				logger.debug(`message ${this.envelope.databaseId} fetched`, { message: this.message })

				if (loadingTimeout) {
					clearTimeout(loadingTimeout)
				}

				if (this.message.hasHtmlBody) {
					this.loadingBodyTimeout = setTimeout(() => {
						this.loading = Loading.Skeleton
					}, 200)
				} else {
					this.loading = Loading.Done
				}
				this.$nextTick(() => {
					this.handleThreadScrolling()
				})
			} catch (error) {
				if (
					isRequestCancellation(error)
					&& this.expanded
					&& this.messageFetchRetryCount < 1
				) {
					// A real open can deduplicate into a speculative request
					// that was queued when a frozen mobile tab resumed. If its
					// signal expires before the coordinator can run it, do not
					// render the internal cancellation string as message
					// content. The coordinator recovery fixes should make this
					// one bounded retry start immediately.
					this.messageFetchRetryCount++
					this.loading = Loading.Skeleton
					logger.debug('Retrying an expanded message after its queued request was cancelled', {
						messageId: this.envelope.databaseId,
						error,
					})
					this.messageFetchRetryTimeout = setTimeout(() => {
						this.messageFetchRetryTimeout = undefined
						if (this.expanded && !this._isDestroyed) {
							this.fetchMessage()
						}
					}, CANCELLED_MESSAGE_RETRY_DELAY_MS)
					return
				}
				this.error = isRequestCancellation(error)
					? { isTransient: true }
					: error
				this.loading = Loading.Done
				logger.error('Could not fetch message', { error })
			}

			// Fetch smart replies
			if (this.enabledFreePrompt && this.message && !['trash', 'junk'].includes(this.mailbox.specialRole) && !this.showFollowUpHeader) {
				try {
					this.smartReplies = await smartReply(this.envelope.databaseId)
				} catch (error) {
					logger.error('Could not fetch smart replies', { error })
				}
			}
		},

		scheduleSupplementaryFetches() {
			if (
				!this.message
				|| this.supplementaryFetchHandle !== undefined
				|| this.supplementaryFetchController !== undefined
				|| (this.message.itineraries && this.message.dkimValid !== undefined)
			) {
				return
			}

			const run = () => {
				this.supplementaryFetchHandle = undefined
				if (!this.expanded || !this.message) {
					return
				}

				const controller = new AbortController()
				this.supplementaryFetchController = controller
				const fetchSupplementaryData = async () => {
					// Sequential on purpose: the coordinator permits only one
					// low-priority request at a time globally, and launching
					// both together only adds a queued request that may already
					// be obsolete by the time the user navigates away.
					let continueEnrichment = true
					if (!this.message.itineraries) {
						continueEnrichment = await this.fetchItineraries(controller.signal)
					}
					if (
						continueEnrichment
						&& !controller.signal.aborted
						&& this.message.dkimValid === undefined
					) {
						await this.fetchDkim(controller.signal)
					}
				}
				fetchSupplementaryData().finally(() => {
					if (this.supplementaryFetchController === controller) {
						this.supplementaryFetchController = undefined
					}
				})
			}

			// A short post-render quiet period is deterministic across
			// Firefox/Chromium/mobile WebViews. The request coordinator then
			// applies the real idle policy: speculative work is dropped while
			// any foreground request is queued or running.
			this.supplementaryFetchHandle = setTimeout(run, SUPPLEMENTARY_FETCH_DELAY_MS)
		},

		cancelSupplementaryFetches() {
			if (this.supplementaryFetchHandle !== undefined) {
				clearTimeout(this.supplementaryFetchHandle)
				this.supplementaryFetchHandle = undefined
			}
			this.supplementaryFetchController?.abort()
			this.supplementaryFetchController = undefined
		},

		handleThreadScrolling() {
			const threadId = this.envelope.threadId // Assuming each envelope has a thread ID

			if (threadId && this.$parent.toggleExpand) {
				// If thread is not expanded, expand it first
				if (!this.$parent.expandedThreads.includes(threadId)) {
					this.$parent.toggleExpand(threadId)
					this.$nextTick(() => this.scrollToThread(threadId))
				} else {
					this.scrollToThread(threadId)
				}
			} else {
				// If there's no thread, just scroll to the envelope
				this.scrollToEnvelope()
			}
		},

		taskUrl(task) {
			return taskDeepLink(task.calendarUri, taskUriOf(task))
		},

		scrollToThread(threadId) {
			this.$nextTick(() => {
				const threadElement = document.querySelector(`[data-thread-id="${threadId}"]`)
				if (threadElement) {
					threadElement.scrollIntoView({
						behavior: 'smooth',
						block: 'start',
					})
				}
			})
		},

		scrollToEnvelope() {
			this.$nextTick(() => {
				const envelopeHeaderElement = this.$refs.header
				const subjectElement = document.querySelector('#mail-thread-header')

				if (envelopeHeaderElement) {
					if (subjectElement) {
						const subjectHeight = subjectElement.offsetHeight
						envelopeHeaderElement.style.scrollMarginTop = `${subjectHeight}px`
					}
					envelopeHeaderElement.scrollIntoView({ behavior: 'smooth', block: 'start', container: 'nearest' })
				}
			})
		},

		async fetchItineraries(signal) {
			// Sanity check before actually making the request
			if (!this.message.hasHtmlBody && this.message.attachments.length === 0) {
				return true
			}

			logger.debug(`Fetching itineraries for message ${this.envelope.databaseId}`)

			try {
				const itineraries = await this.mainStore.fetchItineraries(this.envelope.databaseId, { signal })
				logger.debug(`Itineraries of message ${this.envelope.databaseId} fetched`, { itineraries })
				return true
			} catch (error) {
				if (isRequestCancellation(error) || isSupplementaryCapacityError(error)) {
					logger.debug(`Stopped supplementary fetches for message ${this.envelope.databaseId}`, {
						reason: isSupplementaryCapacityError(error) ? 'capacity' : 'cancelled',
					})
					return false
				}
				logger.error(`Could not fetch itineraries of message ${this.envelope.databaseId}`, { error })
				// A non-capacity itinerary failure does not imply that DKIM
				// validation will fail, so retain the established independent
				// attempt for genuine endpoint-specific errors.
				return true
			}
		},

		async fetchDkim(signal) {
			if (this.message.hasDkimSignature === false) {
				return
			}

			logger.debug(`Fetching DKIM for message ${this.envelope.databaseId}`)

			try {
				const dkim = await this.mainStore.fetchDkim(this.envelope.databaseId, { signal })
				logger.debug(`DKIM of message ${this.envelope.databaseId} fetched`, { dkim })
			} catch (error) {
				if (isRequestCancellation(error) || isSupplementaryCapacityError(error)) {
					logger.debug(`Skipped DKIM enrichment for message ${this.envelope.databaseId}`, {
						reason: isSupplementaryCapacityError(error) ? 'capacity' : 'cancelled',
					})
					return
				}
				logger.error(`Could not fetch DKIM of message ${this.envelope.databaseId}`, { error })
			}
		},

		onReply(body = '', followUp = false, replySenderOnly = false) {
			this.mainStore.startComposerSession({
				reply: {
					mode: (this.hasMultipleRecipients && !replySenderOnly) ? 'replyAll' : 'reply',
					data: this.envelope,
					smartReply: body,
					followUp,
				},
			})
		},

		onToggleImportant() {
			this.mainStore.toggleEnvelopeImportant(this.envelope)
		},

		onToggleFlagged() {
			this.mainStore.toggleEnvelopeFlagged(this.envelope)
		},

		onToggleJunk() {
			// Was passing this.envelope directly as toggleEnvelopeJunk()'s
			// single {envelope, removeEnvelope} argument -- destructuring
			// `envelope` off an envelope object (not a wrapper) gave
			// undefined, so `envelope.flags.$junk` threw immediately on
			// every click. This action is only ever shown for an
			// already-junk message (v-if="envelope.flags.$junk" on the
			// icon), so removeEnvelope must be computed the same way
			// every other junk-toggle entry point does. The real store
			// call is Thread.vue's job now, deferred behind an undo
			// window -- see onDelete()/onArchive() above.
			this.mainStore.moveEnvelopeToJunk(this.envelope).then((removeEnvelope) => {
				this.$emit('request-toggle-junk-one', {
					envelope: this.envelope,
					removeEnvelope,
					isImportant: false,
				})
			})
		},

		onToggleSeen() {
			this.mainStore.toggleEnvelopeSeen({ envelope: this.envelope })
		},

		onDelete() {
			// Remove from selection first
			if (this.withSelect) {
				this.$emit('unselect')
			}

			// Delete
			this.$emit('delete', this.envelope.databaseId)

			logger.info(`deleting message ${this.envelope.databaseId}`)

			// The actual store call is Thread.vue's job now, not this
			// component's: it owns the undo-window bookkeeping
			// (UndoableActionMixin) that hides this row immediately and
			// only actually deletes a few seconds later unless undone,
			// same mechanism EnvelopeList.vue's own delete already goes
			// through for the mailbox list view.
			this.$emit('request-delete', this.envelope)
		},

		onArchive() {
			// Remove from selection first
			if (this.withSelect) {
				this.$emit('unselect')
			}

			logger.info(`archiving message ${this.envelope.databaseId}`)

			// Same reasoning as onDelete() above: Thread.vue defers the
			// real moveMessage() call behind an undo window instead of
			// this component calling it directly.
			this.$emit('request-archive', this.envelope)
		},

		async onDisableFollowUpReminder() {
			await this.mainStore.clearFollowUpReminder({
				envelope: this.envelope,
			})
		},

		async unsubscribeViaOneClick() {
			try {
				this.unsubscribing = true

				await unsubscribe(this.envelope.databaseId)
				showSuccess(t('mail', 'Unsubscribe request sent'))
			} catch (error) {
				logger.error('Could not one-click unsubscribe', { error })
				showError(t('mail', 'Could not unsubscribe from mailing list'))
			} finally {
				this.unsubscribing = false
				this.showListUnsubscribeConfirmation = false
			}
		},

		async unsubscribeViaMailto() {
			const mailto = this.message.unsubscribeMailto
			const [email, paramString] = mailto.replace(/^mailto:/, '').split('?')
			let params = {}
			const now = new Date().getTime() / 1000
			if (paramString) {
				params = paramString.split('&').map((encoded) => ({
					key: encoded.split('=')[0].toLowerCase(),
					value: decodeURIComponent(encoded.split('=')[1]),
				}))
			}
			try {
				this.unsubscribing = true
				const message = await this.outboxStore.enqueueMessage({
					message: {
						accountId: this.message.accountId,
						subject: params.subject || 'Unsubscribe',
						body: params.body || '',
						editorBody: params.body || '',
						isHtml: false,
						to: [{
							label: email,
							email,
						}],
						cc: [],
						bcc: [],
						attachments: [],
						aliasId: null,
						inReplyToMessageId: null,
						sendAt: now,
						draftId: null,
						smimeEncrypt: false,
						smimeSign: false,
					},
				})
				logger.debug('Unsubscribe email to ' + email + ' enqueued')
				await this.outboxStore.sendMessage({ id: message.id })
				logger.debug('Unsubscribe email sent to ' + email)
				showSuccess(t('mail', 'Unsubscribe request sent'))
			} catch (error) {
				logger.error('Could not enqueue or send unsubscribe email', { error })
				showError(t('mail', 'Could not unsubscribe from mailing list'))
			} finally {
				this.unsubscribing = false
				this.showListUnsubscribeConfirmation = false
			}
		},

		onMove() {
			this.$emit('move')
		},

		onOpenMoveModal() {
			this.showMoveModal = true
		},

		onCloseMoveModal() {
			this.showMoveModal = false
		},

		onOpenEventModal() {
			this.showEventModal = true
		},

		onCloseEventModal() {
			this.showEventModal = false
		},

		onOpenTaskModal() {
			this.showTaskModal = true
		},

		onCloseTaskModal() {
			this.showTaskModal = false
		},

		onOpenTagModal() {
			this.showTagModal = true
		},

		onCloseTagModal() {
			this.showTagModal = false
		},

		onOpenTranslationModal() {
			try {
				if (this.message.hasHtmlBody) {
					let text = new Text('html', this.message.body)
					text = toPlain(text)
					this.plainTextBody = text.value
				} else {
					this.plainTextBody = this.message.body
				}
				this.showTranslationModal = true
			} catch (error) {
				logger.error('could not open translation modal, message not loaded', { error })
				showError(t('mail', 'Please wait for the message to load'))
			}
		},

		onCloseTranslationModal() {
			this.showTranslationModal = false
		},

		async onShowSourceModal() {
			if (this.rawMessage.length === 0) {
				const resp = await axios.get(generateUrl('/apps/mail/api/messages/{id}/source', {
					id: this.envelope.databaseId,
				}))
				this.rawMessage = resp.data.source
			}
			this.showSourceModal = true
		},

		onCloseSourceModal() {
			this.showSourceModal = false
		},

		onPrint() {
			this.$emit('print', this.threadIndex)
		},
	},
}
</script>

<style lang="scss" scoped>

/* Bottom-start on the avatar: important holds top-start, the star top-end. */
.app-content-list-item-star.task-icon-style {
	display: inline-block;
	position: absolute;
	/* Bottom-start, mirroring the importance flag at top-start. Inset by 2px
	   on both edges: the flag and the star are glyphs with padding inside
	   their own viewBox, so their boxes sit at 0 while what you SEE starts a
	   couple of pixels in. This tile fills its box edge to edge, so at 0 it
	   hung further out than the flag above it. Symmetric, so the bottom
	   matches: 40px avatar less the 14px mark less 2px. */
	top: 24px;
	inset-inline-start: 2px;
	z-index: 1;
	/* No drop-shadow here. The ring is drawn by the icon itself as a real
	   stroke (`haloed`), the way icon-important and favorite-icon-style below
	   do it -- two stacked shadows were an imitation of that ring, and a
	   blurry one, which is what made this mark sit heavier on the avatar than
	   the two it is meant to line up with. */
}

	.sender {
		margin-inline-start: calc(var(--default-grid-baseline) * 3);

		&--expanded {
			color: var(--color-text-maxcontrast);
		}

		&__email {
			text-overflow: ellipsis;
			overflow: hidden;

			&--toggle {
				margin-inline-start: calc(var(--default-grid-baseline) * 2);

				:deep(.button-vue__text) {
					font-weight: normal;
					color: var(--color-text-maxcontrast);
				}
			}
		}
	}

	.right {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: flex-end;
		margin-inline-start: calc(var(--default-grid-baseline) * 2);
		height: 44px;

		.app-content-list-item-menu {
			margin-inline-start: var(--default-grid-baseline);
		}

		.timestamp {
			margin-inline-end: calc(var(--default-grid-baseline) * 2);
			color: var(--color-text-maxcontrast);
			white-space: nowrap;
			margin-bottom: 0;
		}
	}

	.button {
		color: var(--color-main-background);
		&:not(.active):not(.primary) {
			display: none;

			&.primary {
				background-color: var(--color-primary-element);
				opacity: 1;
				margin-bottom: 0;

			}
		}
	}

	.envelope {
		display: flex;
		flex-direction: column;
		border: 2px solid var(--color-border);
		border-radius: var(--border-radius-container-large);
		margin-inline: calc(var(--default-grid-baseline) * 2);
		background-color: var(--color-main-background);
		padding-bottom: calc(var(--default-grid-baseline) * 7);
		animation: show 200ms 90ms cubic-bezier(.17, .67, .83, .67) forwards;
		opacity: 0.5;
		transform-origin: top center;
		@keyframes show {
			100% {
				opacity: 1;
				transform: none;
			}
		}

		& + .envelope {
			margin-top: calc(var(--default-grid-baseline) * -7);
		}

		&:last-of-type {
			margin-bottom: calc(var(--default-grid-baseline) * 2);
			padding-bottom: 0;
		}

		&__follow-up-header {
			display: flex;
			align-items: center;
			justify-content: flex-end;
			gap: calc(var(--default-grid-baseline) * 4);
			padding: calc(var(--default-grid-baseline) * 2);

			&__date {
				flex-shrink: 1;
			}

			&__actions {
				flex-shrink: 0;
				display: flex;
				gap: var(--default-grid-baseline);
			}
		}

		&__header {
			position: relative;
			display: flex;
			align-items: center;
			padding: var(--border-radius-element) var(--border-radius-container) var(--border-radius-container) var(--border-radius-container);
			border-radius: var(--border-radius);
			min-height: 68px; /* prevents jumping between open/collapsed */

			.left {
				display: flex;
				align-items: center;
				min-width: 0;
				flex: 1 1 auto;
				gap: 8px;

				.envelope__header__left__sender-subject-tags {
					min-width: 0;
					width: 100%;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
			}

			.right {
				flex-shrink: 0;
				margin-inline-start: auto;
				display: flex;
				align-items: center;
				gap: 4px;
			}

			&__avatar {
				position: relative;

				&-avatar {
					/* The block makes the wrapper div cover the avatar exactly
					 * (no extra space) and allows center aligning the avatar
					 * with the rest of the header elements.
					 */
					display: block;
				}

				.app-content-list-item-star {
					position: absolute;
					cursor: pointer;

					&.icon-important {
						background-image: none;
						opacity: 1;
						width: 16px;
						height: 16px;
						display: flex;
						top: 0px;
						inset-inline-start: 0px;

						&:hover,
						&:focus {
							opacity: 0.5;
						}

						:deep(path) {
							fill: #ffcc00;
							stroke: var(--color-main-background);
							cursor: pointer;
						}
					}
					&.favorite-icon-style {
						display: inline-block;
						top: -2px;
						inset-inline-end: -2px;

						stroke: var(--color-main-background);
						stroke-width: 2;
						&:hover {
							opacity: .5;
						}
					}
					&.junk-icon-style {
						display: inline-block;
						bottom: -2px;
						inset-inline-end: -2px;
						opacity: .2;
						&:hover {
							opacity: .1;
						}
					}
				}
			}

			&__unsubscribe {
				flex-shrink: 0;
				color: var(--color-text-maxcontrast);
			}
		}

		.subline {
			margin-inline-start: 8px;
			color: var(--color-text-maxcontrast);
			cursor: default;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		&--expanded {
			min-height: 350px;
		}
	}

	.left {
		flex-grow: 1;
		min-width: 0; /* https://css-tricks.com/flexbox-truncated-text/ */
		display: flex;
		position: relative;
		z-index: 1;
		align-items: center;
	}

	.left:not(.seen) {
		font-weight: bold;
	}

	.tag-group__label {
		margin: 0 calc(var(--default-grid-baseline) * 2);
		z-index: 2;
		font-size: calc(var(--default-font-size) * 0.8);
		font-weight: bold;
		padding-inline: calc(var(--default-grid-baseline) * 0.5);
	}

	.tag-group__bg {
		position: absolute;
		width: 100%;
		height: 100%;
		top: 0;
		inset-inline-start: 0;
		opacity: 15%;
	}

	.tagline {
		display: flex;
		text-overflow: ellipsis;
		overflow: hidden;
	}

	.tag-group {
		display: inline-block;
		border: 1px solid transparent;
		border-radius: var(--border-radius-pill);
		position: relative;
		margin: 0 1px;
		overflow: hidden;
		text-overflow: ellipsis;
		inset-inline-start: var(--default-grid-baseline);
	}

	.envelope__unsubscribe-row {
		// align under the sender name (same offset as .envelope__recipients)
		padding-inline-start: calc(var(--border-radius-container) + var(--default-grid-baseline) * 10 + var(--default-grid-baseline) * 3 - var(--default-grid-baseline) * 2);
		padding-inline-end: var(--border-radius-container);
		margin-block: calc(var(--default-grid-baseline) * -2) var(--default-grid-baseline);
	}

	.envelope__recipients {
		// align with sender name: header padding + avatar (40px) + gap (2 * grid-baseline)
		padding-inline-start: calc(var(--border-radius-container) + var(--default-grid-baseline) * 10 + var(--default-grid-baseline) * 3);
		padding-inline-end: var(--border-radius-container);
		padding-block: var(--default-grid-baseline) calc(var(--default-grid-baseline) * 2);
		display: flex;
		flex-direction: column;
		gap: calc(var(--default-grid-baseline));

		.recipients {
			display: flex;
			flex-direction: row;

			&__label {
				color: var(--color-text-maxcontrast);
				white-space: nowrap;
				min-width: calc(var(--default-grid-baseline) * 8);
				height: 100%;
			}

			&__list {
				display: flex;
				align-items: center;
				flex-wrap: wrap;
				gap: var(--default-grid-baseline);
			}

		}
	}

	.smime-text {
		// same as padding-right on action-text styling
		padding-inline-start: calc(var(--default-grid-baseline) * 3);
	}

	:deep(.action-button__name) {
		font-weight: normal;
		display: inline;
		align-items: center;
	}
</style>
