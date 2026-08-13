<!--
  - SPDX-FileCopyrightText: 2018 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div>
		<transition name="multiselect-header">
			<div v-if="selectMode" key="multiselect-header" class="multiselect-header">
				<NcButton
					variant="tertiary"
					:title="n('mail', 'Unselect {number}', 'Unselect {number}', selection.length, { number: selection.length })"
					@click.prevent="unselectAll">
					<IconSelect :size="20" />
				</NcButton>
				<div class="action-buttons">
					<NcButton
						v-if="isAtLeastOneSelectedUnread"
						variant="tertiary"
						:title="n('mail', 'Mark {number} read', 'Mark {number} read', selection.length, { number: selection.length })"
						@click.prevent="markSelectedRead">
						<EmailRead :size="20" />
					</NcButton>

					<NcButton
						v-if="isAtLeastOneSelectedRead"
						variant="tertiary"
						:title="n('mail', 'Mark {number} unread', 'Mark {number} unread', selection.length, { number: selection.length })"
						@click.prevent="markSelectedUnread">
						<EmailUnread :size="20" />
					</NcButton>

					<NcButton
						v-if="isAtLeastOneSelectedUnimportant"
						variant="tertiary"
						:title="n('mail', 'Mark {number} as important', 'Mark {number} as important', selection.length, { number: selection.length })"
						@click.prevent="markSelectionImportant">
						<ImportantIcon :size="20" />
					</NcButton>

					<NcButton
						v-if="isAtLeastOneSelectedImportant"
						variant="tertiary"
						:title="n('mail', 'Mark {number} as unimportant', 'Mark {number} as unimportant', selection.length, { number: selection.length })"
						@click.prevent="markSelectionUnimportant">
						<ImportantOutlineIcon :size="20" />
					</NcButton>

					<NcButton
						v-if="isAtLeastOneSelectedFavorite"
						variant="tertiary"
						:title="n('mail', 'Unfavorite {number}', 'Unfavorite {number}', selection.length, { number: selection.length })"
						@click.prevent="unfavoriteAll">
						<IconUnFavorite :size="20" />
					</NcButton>

					<NcButton
						v-if="isAtLeastOneSelectedUnFavorite"
						variant="tertiary"
						:title="n('mail', 'Favorite {number}', 'Favorite {number}', selection.length, { number: selection.length })"
						@click.prevent="favoriteAll">
						<IconFavorite :size="20" />
					</NcButton>

					<NcButton
						variant="tertiary"
						:title="n(
							'mail',
							'Delete {number} thread',
							'Delete {number} threads',
							selection.length,
							{ number: selection.length },
						)"
						:close-after-click="true"
						@click.prevent="deleteAllSelected">
						<IconDelete :size="20" />
					</NcButton>
				</div>

				<Actions class="app-content-list-item-menu" menu-align="right">
					<ActionButton
						v-if="isAtLeastOneSelectedNotJunk"
						@click.prevent="markSelectionJunk">
						<template #icon>
							<AlertOctagonIcon :size="20" />
						</template>
						{{ n('mail', 'Mark {number} as spam', 'Mark {number} as spam', selection.length, { number: selection.length }) }}
					</ActionButton>
					<ActionButton
						v-if="isAtLeastOneSelectedJunk"
						@click.prevent="markSelectionNotJunk">
						<template #icon>
							<AlertOctagonIcon :size="20" />
						</template>
						{{ n('mail', 'Mark {number} as not spam', 'Mark {number} as not spam', selection.length, { number: selection.length }) }}
					</ActionButton>
					<ActionButton :close-after-click="true" @click.prevent="onOpenTagModal">
						<template #icon>
							<TagIcon :size="20" />
						</template>
						{{ n('mail', 'Edit tags for {number}', 'Edit tags for {number}', selection.length, { number: selection.length }) }}
					</ActionButton>
					<ActionButton v-if="!account.isUnified" :close-after-click="true" @click.prevent="onOpenMoveModal">
						<template #icon>
							<OpenInNewIcon :size="20" />
						</template>
						{{ n('mail', 'Move {number} thread', 'Move {number} threads', selection.length, { number: selection.length }) }}
					</ActionButton>
					<ActionButton :close-after-click="true" @click.prevent="forwardSelectedAsAttachment">
						<template #icon>
							<ShareIcon :size="20" />
						</template>
						{{ n('mail', 'Forward {number} as attachment', 'Forward {number} as attachment', selection.length, { number: selection.length }) }}
					</ActionButton>
				</Actions>
			</div>
		</transition>

		<component :is="listWrapper" v-bind="listWrapperProps">
			<Envelope
				v-for="(env, index) in sortedEnvelops"
				:key="env.databaseId"
				:data="env"
				:mailbox="mailbox"
				:search-query="searchQuery"
				:selected="selection.includes(env.databaseId)"
				:select-mode="selectMode"
				:has-multiple-accounts="hasMultipleAccounts"
				:selected-envelopes="selectedEnvelopes"
				:compact-mode="compactMode"
				@delete="$emit('delete', env.databaseId)"
				@request-delete="onRequestDeleteOne"
				@request-archive="onRequestArchiveOne"
				@request-move="onRequestMove"
				@request-toggle-junk-one="onRequestToggleJunkOne"
				@request-toggle-junk-thread="onRequestToggleJunkThread"
				@request-snooze="onRequestSnooze"
				@update:selected="onEnvelopeSelectToggle(env, index, $event)"
				@select-multiple="onEnvelopeSelectMultiple(env, index)"
				@open:quick-actions-settings="showQuickActionsSettings = true" />
			<div
				v-if="loadMoreButton && !loadingMore"
				:key="'list-collapse-' + searchQuery"
				class="load-more"
				@click="$emit('load-more')">
				<AddIcon :size="16" />
				{{ loadMoreLabel }}
			</div>
			<div
				v-if="collapseButton && !loadingMore"
				:key="'list-show-less-' + searchQuery"
				class="load-more"
				@click="$emit('collapse')">
				<MinusIcon :size="16" />
				{{ t('mail', 'Show less') }}
			</div>
			<div id="load-more-mail-messages" key="loadingMore" :class="{ 'icon-loading-small': loadingMore }" />
		</component>

		<TagModal
			v-if="showTagModal"
			:account="account"
			:envelopes="selectedEnvelopes"
			@close="onCloseTagModal" />

		<MoveModal
			v-if="showMoveModal"
			:account="account"
			:envelopes="selectedEnvelopes"
			:move-thread="true"
			@request-move="onRequestMove"
			@close="onCloseMoveModal" />

		<NcDialog
			v-if="showQuickActionsSettings"
			:name="t('mail', 'Manage quick actions')"
			@closing="showQuickActionsSettings = false">
			<Settings :account="account" />
		</NcDialog>
	</div>
</template>

<script>
import { NcActionButton as ActionButton, NcActions as Actions, NcButton, NcDialog } from '@nextcloud/vue'
import { mapStores } from 'pinia'
import AlertOctagonIcon from 'vue-material-design-icons/AlertOctagonOutline.vue'
import IconSelect from 'vue-material-design-icons/Close.vue'
import EmailRead from 'vue-material-design-icons/EmailOpenOutline.vue'
import EmailUnread from 'vue-material-design-icons/EmailOutline.vue'
import ImportantIcon from 'vue-material-design-icons/LabelVariant.vue'
import ImportantOutlineIcon from 'vue-material-design-icons/LabelVariantOutline.vue'
import MinusIcon from 'vue-material-design-icons/Minus.vue'
import OpenInNewIcon from 'vue-material-design-icons/OpenInNew.vue'
import AddIcon from 'vue-material-design-icons/Plus.vue'
import ShareIcon from 'vue-material-design-icons/ShareOutline.vue'
import IconFavorite from 'vue-material-design-icons/Star.vue'
import IconUnFavorite from 'vue-material-design-icons/StarOutline.vue'
import TagIcon from 'vue-material-design-icons/TagOutline.vue'
import IconDelete from 'vue-material-design-icons/TrashCanOutline.vue'
import Settings from '../components/quickActions/Settings.vue'
import Envelope from './Envelope.vue'
import MoveModal from './MoveModal.vue'
import TagModal from './TagModal.vue'
import dragEventBus from '../directives/drag-and-drop/util/dragEventBus.js'
import { matchError } from '../errors/match.js'
import NoTrashMailboxConfiguredError
	from '../errors/NoTrashMailboxConfiguredError.js'
import logger from '../logger.js'
import UndoableActionMixin from '../mixins/UndoableActionMixin.js'
import { ENVELOPE_LIST_MAX_ANIMATED_SIZE } from '../store/constants.js'
import useMainStore from '../store/mainStore.js'
import { listTransitionDurationMs } from '../util/listTransitionDuration.js'
import { selectPrefetchIds, updateDirection } from '../util/prefetchSelection.js'
import { showError, showSuccess } from '../util/toast.js'

/**
 * How many rows at the top of the list to warm.
 *
 * Matches the store and server caps. It is deliberately the visible head
 * rather than everything loaded: a page can hold hundreds of envelopes and
 * warming all of them would pull bodies the user will never look at, over the
 * very connection budget this is trying to protect.
 */
const PREFETCH_HEAD_SIZE = 10

export default {
	name: 'EnvelopeList',
	components: {
		IconUnFavorite,
		EmailUnread,
		EmailRead,
		Actions,
		AddIcon,
		MinusIcon,
		NcButton,
		NcDialog,
		ActionButton,
		Envelope,
		IconDelete,
		ImportantIcon,
		ImportantOutlineIcon,
		IconFavorite,
		IconSelect,
		MoveModal,
		OpenInNewIcon,
		ShareIcon,
		AlertOctagonIcon,
		TagIcon,
		TagModal,
		Settings,
	},

	mixins: [UndoableActionMixin],

	props: {
		account: {
			type: Object,
			required: true,
		},

		loadMoreLabel: {
			type: String,
			default: t('mail', 'Load more'),
		},

		mailbox: {
			type: Object,
			required: true,
		},

		envelopes: {
			type: Array,
			required: true,
		},

		searchQuery: {
			type: String,
			required: false,
			default: undefined,
		},

		loadingMore: {
			type: Boolean,
			required: true,
		},

		loadMoreButton: {
			type: Boolean,
			required: false,
			default: false,
		},

		// "Show less" -- the inverse of loadMoreButton, shown by
		// Mailbox.vue once a manual-paginate section is expanded past its
		// initial page size. Emits 'collapse'.
		collapseButton: {
			type: Boolean,
			required: false,
			default: false,
		},

		skipTransition: {
			type: Boolean,
			default: false,
		},

		compactMode: {
			type: Boolean,
			default: false,
		},
	},

	data() {
		return {
			selection: [],
			showMoveModal: false,
			showTagModal: false,
			lastToggledIndex: undefined,
			defaultView: false,
			showQuickActionsSettings: false,
			// Not reactive state anyone renders -- only the memo that stops
			// prefetchHeadOfList() re-asking for a head it already asked for.
			lastPrefetchedHead: undefined,
			// Direction of travel and the anchor it was derived from. Three
			// scalars, not a model: everything that decides anything lives in
			// util/prefetchSelection.js where it can be tested.
			prefetchDirection: { direction: 'none', lastIndex: undefined, against: 0 },
			lastPrefetchAnchor: undefined,
			recentOpensUnread: [],
		}
	},

	computed: {
		...mapStores(useMainStore),
		sortOrder() {
			return this.mainStore.getPreference('sort-order', 'newest')
		},

		openThreadId() {
			const id = Number.parseInt(this.$route?.params?.threadId, 10)
			return Number.isInteger(id) ? id : undefined
		},

		sortedEnvelops() {
			// Envelopes pending an undoable delete (see
			// UndoableActionMixin) are hidden here, immediately, rather
			// than waiting for the real delete call to actually land --
			// that's the whole point of the undo window: the message
			// looks gone right away, but nothing irreversible has
			// happened server-side yet.
			const notPendingUndo = this.envelopes.filter((envelope) => !this.isPendingUndo(envelope.databaseId))
			if (this.sortOrder === 'oldest') {
				return [...notPendingUndo].sort((a, b) => {
					return a.dateInt < b.dateInt ? -1 : 1
				})
			}
			return [...notPendingUndo]
		},

		selectMode() {
			// returns true when in selection mode (where the user selects several emails at once)
			return this.selection.length > 0
		},

		isAtLeastOneSelectedRead() {
			return this.selectedEnvelopes.some((env) => env.flags.seen === true)
		},

		isAtLeastOneSelectedUnread() {
			return this.selectedEnvelopes.some((env) => env.flags.seen === false)
		},

		isAtLeastOneSelectedImportant() {
			// returns true if at least one selected message is marked as important
			// (per-copy flag, not the user-wide tag -- see Envelope.vue's
			// own isImportant() for the multi-account divergence this avoids)
			return this.selectedEnvelopes.some((env) => env.flags.important === true)
		},

		isAtLeastOneSelectedUnimportant() {
			// returns true if at least one selected message is not marked as important
			return this.selectedEnvelopes.some((env) => env.flags.important !== true)
		},

		isAtLeastOneSelectedJunk() {
			// returns true if at least one selected message is marked as junk
			return this.selectedEnvelopes.some((env) => {
				return env.flags.$junk
			})
		},

		isAtLeastOneSelectedNotJunk() {
			// returns true if at least one selected message is not marked as not junk
			return this.selectedEnvelopes.some((env) => {
				return !env.flags.$junk
			})
		},

		isAtLeastOneSelectedFavorite() {
			return this.selectedEnvelopes.some((env) => env.flags.flagged)
		},

		isAtLeastOneSelectedUnFavorite() {
			return this.selectedEnvelopes.some((env) => !env.flags.flagged)
		},

		selectedEnvelopes() {
			return this.sortedEnvelops.filter((env) => this.selection.includes(env.databaseId))
		},

		hasMultipleAccounts() {
			const mailboxIds = this.sortedEnvelops.map((envelope) => envelope.mailboxId)
			return Array.from(new Set(mailboxIds)).length > 1
		},

		listAnimated() {
			// Drop the enter/leave animation once the list is long: on a
			// deep-scrolled list the per-row transitions dominate paint time
			// as new pages stream in during scroll, for no visible benefit
			// far below the viewport (see ENVELOPE_LIST_MAX_ANIMATED_SIZE).
			// skipTransition still forces it off for bulk removals regardless.
			return !this.skipTransition && this.sortedEnvelops.length <= ENVELOPE_LIST_MAX_ANIMATED_SIZE
		},

		listTransitionName() {
			return this.listAnimated ? 'list' : 'disabled'
		},

		/**
		 * A <transition-group> only when something is actually being animated.
		 *
		 * Naming it 'disabled' is NOT enough to make it cheap. Vue's
		 * transition-group runs its move detection on EVERY update regardless
		 * of the name, and caches the answer only when it is truthy:
		 *
		 *   if (this._hasMove) { return this._hasMove }
		 *   ...
		 *   return (this._hasMove = info.hasTransform)
		 *
		 * No `-move` class is defined here (there is no move animation, by
		 * design), so hasTransform is false, the cache never engages, and
		 * every single list update pays a cloneNode + appendChild into the
		 * live DOM + getComputedStyle + removeChild. That getComputedStyle
		 * forces a synchronous style flush.
		 *
		 * Measured live on 2026-07-28: 777 style flushes costing 14.1s in a
		 * 43s profile, 64% of the tab's entire main-thread CPU, with the
		 * thread pegged at 100% for the last 12 seconds straight.
		 *
		 * transition-group renders a <span> when given no tag, so the
		 * replacement is a <span> and the DOM shape is unchanged.
		 *
		 * Trade-off, stated plainly: swapping the wrapper replaces the
		 * element, so the rows below it remount when this flips. It flips
		 * when the list crosses ENVELOPE_LIST_MAX_ANIMATED_SIZE, and around
		 * bulk removals via skipTransition -- both moments when the list is
		 * being rebuilt anyway. Scroll offset lives on the scroll container,
		 * not here, so it survives.
		 *
		 * @return {string} the component to wrap the rows in
		 */
		listWrapper() {
			return this.listAnimated ? 'transition-group' : 'span'
		},

		listWrapperProps() {
			// `name` is a transition-group prop; on a plain <span> it would
			// land in the DOM as a stray attribute.
			//
			// `duration` is the expensive part made cheap. Without it Vue has
			// to find out how long the animation runs, and the only way it can
			// is to read a computed style off the element -- which forces a
			// synchronous style flush, once per transitioning element, from
			// inside a requestAnimationFrame callback:
			//
			//   if (isValidDuration(explicitEnterDuration)) { setTimeout(cb, explicitEnterDuration) }
			//   else { whenTransitionEnds(el, type, cb) }
			//
			// That else branch was 12.0 of the 14.1 seconds of style flushing
			// measured on 2026-07-28. Handing Vue the number removes the
			// branch entirely and leaves the CSS animation exactly as it was.
			return this.listAnimated
				? { name: this.listTransitionName, duration: listTransitionDurationMs() }
				: {}
		},
	},

	watch: {
		openThreadId() {
			// Anchoring on the open message is the whole of .99. Warming the
			// top ten instead left 79 of 82 opened messages coming live from
			// IMAP, measured, because a reader going DOWN the list never moves
			// its head and so never asked for anything.
			this.prefetchAroundOpenMessage()
		},

		sortedEnvelops(newVal, oldVal) {
			// Warm the bodies at the head of the list. Triage consumes the
			// list from the top -- read it, delete it, the next one moves up --
			// so the head changing IS the user moving through their mail, and
			// this fires for both the first load and every step afterwards.
			this.prefetchHeadOfList(newVal)

			// Unselect vanished envelopes
			const newIds = new Set(newVal.map((env) => env.databaseId))
			this.selection = this.selection.filter((id) => newIds.has(id))
			oldVal
				.filter((env) => !newIds.has(env.databaseId))
				.forEach((env) => {
					env.flags.selected = false
				})
		},

		// Reported to the store so the idle-tail-trim mutation (see
		// trimIdleEnvelopeListTailMutation()) can protect selected tail rows.
		selection(newVal) {
			this.mainStore.setListSelectionMutation({
				mailboxId: this.mailbox.databaseId,
				query: this.searchQuery,
				ownerId: this._uid,
				selectedIds: newVal,
			})
		},
	},

	mounted() {
		dragEventBus.on('envelopes-dropped', this.unselectAll)
		// The watcher only fires on change, and a list that is already
		// populated when this mounts would otherwise never be warmed.
		this.prefetchHeadOfList(this.sortedEnvelops)
	},

	beforeDestroy() {
		dragEventBus.off('envelopes-dropped', this.unselectAll)
		// Don't leave stale selected ids behind for a destroyed list.
		this.mainStore.setListSelectionMutation({
			mailboxId: this.mailbox.databaseId,
			query: this.searchQuery,
			ownerId: this._uid,
			selectedIds: [],
		})
	},

	methods: {
		/**
		 * Ask the server to warm the bodies of the first few rows.
		 *
		 * Guarded by the head itself: the watcher fires on any list update,
		 * including ones that change nothing at the top (a flag, a counter, a
		 * tail trim), and re-asking for the same rows would be a request per
		 * mutation while triaging. Only a genuinely new head is worth a call.
		 *
		 * The store drops ids it already holds and the server drops ids it has
		 * already cached, so an overlapping range costs nothing on either side.
		 *
		 * @param {object[]} envelopes the sorted list
		 */
		prefetchAroundOpenMessage() {
			const anchorId = this.openThreadId
			if (anchorId === undefined) {
				return
			}

			const envelopes = this.sortedEnvelops
			const index = envelopes.findIndex((envelope) => envelope.databaseId === anchorId)
			if (index === -1) {
				// Another mailbox's message, or the list was trimmed under it.
				return
			}

			this.prefetchDirection = updateDirection(this.prefetchDirection, index)

			// "Only unread are being opened" is decided on the last few opens,
			// not on a running score. Unread density varies from 72% to 5%
			// across these accounts, so on the quiet ones this is the
			// difference between warming useful mail and warming mail already
			// read.
			this.recentOpensUnread = [
				envelopes[index]?.flags?.seen !== true,
				...this.recentOpensUnread,
			].slice(0, 5)
			const unreadOnly = this.recentOpensUnread.length >= 3
				&& this.recentOpensUnread.every(Boolean)

			const ids = selectPrefetchIds({
				envelopes,
				anchorId,
				direction: this.prefetchDirection.direction,
				unreadOnly,
				isKnown: (id) => this.mainStore.messages[id] !== undefined,
			})

			if (ids.length === 0) {
				return
			}

			const key = `${anchorId}:${ids.join(',')}`
			if (key === this.lastPrefetchAnchor) {
				return
			}
			this.lastPrefetchAnchor = key

			this.mainStore.prefetchBodies(ids)
		},

		prefetchHeadOfList(envelopes) {
			const raw = (envelopes ?? []).slice(0, PREFETCH_HEAD_SIZE)
			const head = raw
				.map((envelope) => envelope.databaseId)
				.filter((id) => Number.isInteger(id))

			if (head.length === 0) {
				return
			}

			const key = head.join(',')
			if (key === this.lastPrefetchedHead) {
				return
			}
			this.lastPrefetchedHead = key

			this.mainStore.prefetchBodies(head)
		},

		isEnvelopeSelected(idx) {
			if (this.selection.length === 0) {
				return false
			}

			return this.selection.includes(idx)
		},

		markSelectedRead() {
			const envelopes = this.selectedEnvelopes
			this.mainStore.setEnvelopesSeen({
				envelopes,
				seen: true,
			}).catch((error) => {
				logger.error('could not mark selected messages as read', { error })
				showError(t('mail', 'Could not update read status for the selected messages'))
			})
			this.retainSelectionOfVisible()
		},

		markSelectedUnread() {
			const envelopes = this.selectedEnvelopes
			this.mainStore.setEnvelopesSeen({
				envelopes,
				seen: false,
			}).catch((error) => {
				logger.error('could not mark selected messages as unread', { error })
				showError(t('mail', 'Could not update read status for the selected messages'))
			})
			this.retainSelectionOfVisible()
		},

		markSelectionImportant() {
			this.mainStore.markEnvelopesImportantOrUnimportant({
				envelopes: this.selectedEnvelopes,
				addTag: true,
			})
			// The message leaves the current section (e.g. Other) for the
			// Important section immediately (see the store's reclassify) --
			// a short toast confirms WHERE it went so its disappearance from
			// the list the user is looking at isn't a mystery. Deliberately
			// no auto-scroll to the new position: it would yank the viewport
			// away from a batch-marking flow (and is a known anti-pattern).
			showSuccess(t('mail', 'Marked as important'))
			this.retainSelectionOfVisible()
		},

		markSelectionUnimportant() {
			this.mainStore.markEnvelopesImportantOrUnimportant({
				envelopes: this.selectedEnvelopes,
				addTag: false,
			})
			showSuccess(t('mail', 'Marked as unimportant'))
			this.retainSelectionOfVisible()
		},

		// Shared by markSelectionJunk()/markSelectionNotJunk() below: real
		// user reports exist of an entire mailbox getting bulk-marked as
		// spam by accident with no way back (Apple Mail's own community
		// forum has multiple threads about exactly this) -- the same
		// undo window bulk delete already gets.
		//
		// moveEnvelopeToJunk() is resolved eagerly, before deferring
		// anything: it's a read-only check (does a junk mailbox exist,
		// is the envelope not already there), not a mutation, so there's
		// nothing un-doable about calling it up front -- and the pending-
		// hide list needs to know NOW which envelopes will actually
		// disappear from view, since only those should vanish immediately
		// (one that would stay visible either way must not flicker out
		// and back in over the undo window).
		async performBulkJunkToggle(envelopes, message) {
			const targets = await Promise.all(envelopes.map(async (envelope) => ({
				envelope,
				removeEnvelope: await this.mainStore.moveEnvelopeToJunk(envelope),
			})))

			this.performActionWithUndo({
				ids: targets.filter((target) => target.removeEnvelope).map((target) => target.envelope.databaseId),
				message,
				action: async () => {
					await Promise.all(targets.map(({ envelope, removeEnvelope }) => this.mainStore.toggleEnvelopeJunk({
						envelope,
						removeEnvelope,
					})))
				},
			}).catch((error) => {
				logger.error('could not toggle junk status for selection', { error })
				showError(t('mail', 'Could not update spam status for the selected messages'))
			})
		},

		async markSelectionJunk() {
			const envelopes = this.selectedEnvelopes.filter((envelope) => !envelope.flags.$junk)
			await this.performBulkJunkToggle(
				envelopes,
				n('mail', '{number} message marked as spam', '{number} messages marked as spam', envelopes.length, { number: envelopes.length }),
			)
			this.retainSelectionOfVisible()
		},

		async markSelectionNotJunk() {
			const envelopes = this.selectedEnvelopes.filter((envelope) => envelope.flags.$junk)
			await this.performBulkJunkToggle(
				envelopes,
				n('mail', '{number} message marked as not spam', '{number} messages marked as not spam', envelopes.length, { number: envelopes.length }),
			)
			this.retainSelectionOfVisible()
		},

		unfavoriteAll() {
			this.selectedEnvelopes.forEach((envelope) => {
				this.mainStore.markEnvelopeFavoriteOrUnfavorite({
					envelope,
					favFlag: false,
				})
			})
			showSuccess(t('mail', 'Removed from favorites'))
			this.retainSelectionOfVisible()
		},

		favoriteAll() {
			this.selectedEnvelopes.forEach((envelope) => {
				this.mainStore.markEnvelopeFavoriteOrUnfavorite({
					envelope,
					favFlag: true,
				})
			})
			showSuccess(t('mail', 'Added to favorites'))
			this.retainSelectionOfVisible()
		},

		async deleteAllSelected() {
			// Captured up front, before performActionWithUndo() below
			// hides these from sortedEnvelops/selectedEnvelopes -- both
			// the navigation-target logic right below and the deferred
			// delete itself need the ORIGINAL selection, not whatever it
			// shrinks to once these envelopes stop being selectable.
			const envelopesToDelete = this.selectedEnvelopes
			let nextEnvelopeToNavigate
			let isAllSelected

			if (envelopesToDelete.length === this.sortedEnvelops.length) {
				isAllSelected = true
			} else {
				const indexSelectedEnvelope = envelopesToDelete.findIndex((selectedEnvelope) => selectedEnvelope.databaseId === this.$route.params.threadId)

				// one of threads is selected
				if (indexSelectedEnvelope !== -1) {
					const lastSelectedEnvelope = envelopesToDelete[envelopesToDelete.length - 1]
					const diff = this.sortedEnvelops.filter((envelope) => envelope === lastSelectedEnvelope || !envelopesToDelete.includes(envelope))
					const lastIndex = diff.indexOf(lastSelectedEnvelope)
					nextEnvelopeToNavigate = diff[lastIndex === 0 ? 1 : lastIndex - 1]
				}
			}

			// Not awaited here: the actual deletion is deferred behind an
			// undo window (see UndoableActionMixin) and shouldn't block
			// navigating away, same as a real Gmail/Thunderbird delete --
			// you're taken to the next message immediately, the delete
			// itself silently completes a few seconds later unless
			// undone. Still chained with its own .catch() so a real
			// failure (once the deferred delete actually runs) surfaces
			// its own error independently of whatever this function does
			// next.
			this.performActionWithUndo({
				ids: envelopesToDelete.map((envelope) => envelope.databaseId),
				message: n(
					'mail',
					'{number} thread deleted',
					'{number} threads deleted',
					envelopesToDelete.length,
					{ number: envelopesToDelete.length },
				),
				action: async () => {
					logger.info(`deleting ${envelopesToDelete.length} selected threads`)
					await this.mainStore.deleteThreads({ envelopes: envelopesToDelete })
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
			if (nextEnvelopeToNavigate) {
				this.mainStore.setLastOpenedFromListMutation({
					mailboxId: this.mailbox.databaseId,
					query: this.searchQuery,
					databaseId: nextEnvelopeToNavigate.databaseId,
				})
				await this.$router.push({
					name: 'message',
					params: {
						mailboxId: this.$route.params.mailboxId,
						threadId: nextEnvelopeToNavigate.databaseId,
					},
				})

				// Get new messages
				await this.mainStore.fetchNextEnvelopes({
					mailboxId: this.mailbox.databaseId,
					query: this.searchQuery,
					quantity: envelopesToDelete.length,
				})
			} else if (isAllSelected) {
				await this.$router.push({
					name: 'mailbox',
					params: {
						mailboxId: this.$route.params.mailboxId,
					},
				})
			}
			this.unselectAll()
		},

		// A single envelope's own delete action (Envelope.vue's onDelete())
		// requests it here instead of calling the store directly, so it
		// goes through the same undo window as a bulk delete -- otherwise
		// a single click's delete would have no undo at all while a
		// multi-select delete did, an inconsistency a user would notice
		// immediately.
		onRequestDeleteOne({ envelope, isThreaded }) {
			this.performActionWithUndo({
				ids: [envelope.databaseId],
				message: t('mail', 'Message deleted'),
				action: async () => {
					if (isThreaded) {
						await this.mainStore.deleteThread({ envelope })
					} else {
						await this.mainStore.deleteMessage({ id: envelope.databaseId })
					}
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

		// A single envelope's own archive button (Envelope.vue's
		// onArchive()) requests it here instead of calling the store
		// directly, same reasoning as onRequestDeleteOne() above.
		onRequestArchiveOne({ envelope, isThreaded }) {
			this.performActionWithUndo({
				ids: [envelope.databaseId],
				message: t('mail', 'Message archived'),
				action: async () => {
					if (isThreaded) {
						await this.mainStore.moveThread({ envelope, destMailboxId: this.account.archiveMailboxId })
					} else {
						await this.mainStore.moveMessage({ id: envelope.databaseId, destMailboxId: this.account.archiveMailboxId })
					}
				},
			}).catch((error) => {
				logger.error('could not archive message', error)
				showError(t('mail', 'Could not archive message'))
			})
		},

		// A single envelope's own quick-action "move to X" step
		// (Envelope.vue's moveThread()) and the explicit "Move to
		// folder..." dialog (MoveModal.vue, for both a single message
		// and a bulk selection) both request it here instead of calling
		// the store directly, same reasoning as onRequestDeleteOne()
		// above -- one combined undo toast covering every envelope in
		// the request, same as deleteAllSelected() does for bulk delete.
		onRequestMove({ envelopes, destMailboxId, moveThread }) {
			this.performActionWithUndo({
				ids: envelopes.map((envelope) => envelope.databaseId),
				message: n(
					'mail',
					'{number} message moved',
					'{number} messages moved',
					envelopes.length,
					{ number: envelopes.length },
				),
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

		// A single envelope's own junk-toggle action (Envelope.vue's
		// onToggleJunk()) requests it here instead of calling the store
		// directly, same reasoning as onRequestDeleteOne() above --
		// deferred behind the same undo window as the bulk
		// markSelectionJunk()/markSelectionNotJunk() actions.
		// removeEnvelope reflects whether a junk mailbox is actually
		// configured for this account (see moveEnvelopeToJunk()) -- only
		// hide the row immediately if it's actually about to leave the
		// current view; otherwise it stays visible either way and must
		// not flicker.
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

		// Same as onRequestToggleJunkOne() above, but applied to every
		// message in the thread at once (Envelope.vue's
		// onToggleJunkThread()) -- removeEnvelope/isImportant are
		// computed once from the clicked envelope and applied uniformly
		// to the whole thread, matching the pre-existing behavior this
		// replaces.
		onRequestToggleJunkThread({ envelopes, removeEnvelope, isImportant }) {
			const wasJunk = envelopes[0]?.flags.$junk
			this.performActionWithUndo({
				ids: removeEnvelope ? envelopes.map((envelope) => envelope.databaseId) : [],
				message: wasJunk ? t('mail', 'Thread marked as not spam') : t('mail', 'Thread marked as spam'),
				action: async () => {
					await Promise.all(envelopes.map(async (envelope) => {
						if (isImportant) {
							await this.mainStore.toggleEnvelopeImportant(envelope)
						}
						if (!envelope.flags.seen) {
							await this.mainStore.toggleEnvelopeSeen({ envelope })
						}
						await this.mainStore.toggleEnvelopeJunk({ envelope, removeEnvelope })
					}))
				},
			}).catch((error) => {
				logger.error('could not toggle junk status for thread', { error })
				showError(t('mail', 'Could not update spam status'))
			})
		},

		// A single envelope's own snooze action (Envelope.vue's
		// onSnooze()) requests it here instead of calling the store
		// directly, same reasoning as onRequestDeleteOne() above. The
		// snooze mailbox itself, if it needed creating, was already
		// created eagerly (not deferred -- a one-time, idempotent setup
		// step, not the undo-able action itself).
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

		setEnvelopeSelected(envelope, selected) {
			const alreadySelected = this.selection.includes(envelope.databaseId)
			if (selected && !alreadySelected) {
				envelope.flags.selected = true
				this.selection.push(envelope.databaseId)
			} else if (!selected && alreadySelected) {
				envelope.flags.selected = false
				this.selection.splice(this.selection.indexOf(envelope.databaseId), 1)
			}
		},

		onEnvelopeSelectToggle(envelope, index, selected) {
			this.lastToggledIndex = index
			this.setEnvelopeSelected(envelope, selected)
		},

		onEnvelopeSelectMultiple(envelope, index) {
			const lastToggledIndex = this.lastToggledIndex
				?? this.findSelectionIndex(parseInt(this.$route.params.threadId))
				?? undefined
			if (lastToggledIndex === undefined) {
				return
			}

			const start = Math.min(lastToggledIndex, index)
			const end = Math.max(lastToggledIndex, index)
			const selected = this.selection.includes(envelope.databaseId)
			for (let i = start; i <= end; i++) {
				this.setEnvelopeSelected(this.sortedEnvelops[i], !selected)
			}
			this.lastToggledIndex = index
		},

		unselectAll() {
			this.sortedEnvelops.forEach((env) => {
				env.flags.selected = false
			})
			this.selection = []
		},

		/**
		 * Keep the working set after an action that changed the messages
		 * rather than removing them, dropping only what actually left.
		 *
		 * The selection is the user's working set, and marking eight messages
		 * read is very often the first half of "…and flag them". Clearing it
		 * meant selecting them all over again for the second action.
		 *
		 * The rule this follows is the one every list UI has settled on --
		 * Gmail, Outlook, Apple Mail, Thunderbird, and every file manager:
		 * an action that changes an item's PROPERTIES keeps the selection, an
		 * action that changes list MEMBERSHIP (delete, move) clears it because
		 * there is nothing left to keep.
		 *
		 * Membership can still change as a side effect -- marking read while
		 * "Unread only" is active, or starring in the Priority Inbox, moves
		 * rows out of this list -- so those ids are pruned here rather than
		 * left dangling. Their `selected` flag is cleared too: the flag lives
		 * on the envelope in the store, not on this list, so a row that leaves
		 * and later returns would otherwise come back still selected.
		 */
		retainSelectionOfVisible() {
			const visible = new Set(this.sortedEnvelops.map((envelope) => envelope.databaseId))
			const departed = this.selection.filter((id) => !visible.has(id))
			this.selection = this.selection.filter((id) => visible.has(id))
			departed.forEach((id) => {
				const envelope = this.mainStore.getEnvelope(id)
				if (envelope?.flags) {
					envelope.flags.selected = false
				}
			})
		},

		onOpenMoveModal() {
			this.showMoveModal = true
		},

		onOpenTagModal() {
			this.showTagModal = true
		},

		onCloseTagModal() {
			this.showTagModal = false
		},

		async forwardSelectedAsAttachment() {
			await this.mainStore.startComposerSession({
				forwardedMessages: [...this.selection],
			})
			this.unselectAll()
		},

		onCloseMoveModal() {
			this.showMoveModal = false
			this.unselectAll()
		},

		/**
		 * Find the envelope list index of a given envelope's database id.
		 *
		 * @param {number} databaseId of the given envelope
		 * @return {number|undefined} Index or undefined if not found in the envelope list
		 */
		findSelectionIndex(databaseId) {
			for (const [index, envelope] of this.sortedEnvelops.entries()) {
				if (envelope.databaseId === databaseId) {
					return index
				}
			}

			return undefined
		},
	},
}
</script>

<style lang="scss" scoped>
div {
	// So we can align the loading spinner in the Priority inbox
	position: relative;
}

.load-more {
	text-align: center;
	margin-top: 10px;
	cursor: pointer;
	margin-inline-start: 28px;
	color: var(--color-text-maxcontrast);
	display: inline-flex;
	gap: 12px;
	.plus-icon{
		transform: translateX(-8px);
	}
}

.multiselect-header {
	display: flex;
	flex-direction: row;
	align-items: center;
	background-color: var(--color-main-background-translucent);
	position: sticky;
	top: 0;
	height: 48px;
	z-index: 100;
	padding-inline: var(--default-grid-baseline);
	gap: 4px;

	// The "exit selection" X sits on its own on the LEFT, clearly apart from
	// the per-message action icons (pushed to the right below), so it can't
	// be mistaken for a destructive action -- it previously sat unlabelled
	// between the star and trash icons and read as delete/archive (reported
	// live). A text label was tried but truncated to "Αναίρεση ε…" and only
	// added visual weight; the X alone, separated on the left, is the
	// universal exit-selection affordance and needs no label.
	.action-buttons {
		display: flex;
		flex-shrink: 0;
		margin-inline-start: auto;
	}
}

#load-more-mail-messages {
	background-position: 9px center;
}

.multiselect-header-enter-active,
.multiselect-header-leave-active,
.list-enter-active,
.list-leave-active {
	/* The three properties the enter/leave classes below actually change.
	 * `all` made the browser watch every animatable property on a row -- and
	 * a row has plenty that move on their own (flag colours, badges, borders)
	 * -- while Vue's getTransitionInfo() had to parse the whole computed set
	 * on each call, once per element per frame. */
	transition:
		opacity calc(var(--animation-slow) / 2),
		height calc(var(--animation-slow) / 2),
		transform calc(var(--animation-slow) / 2);
}

.multiselect-header-enter,
.multiselect-header-leave-to,
.list-enter,
.list-leave-to {
	opacity: 0;
	height: 0;
	transform: scaleY(0);
}

#action-label {
	vertical-align: middle;
}
@media only screen and (min-width: 600px) {
	#action-label {
		display: block;
	}
}

:deep(.button-vue--text-only) {
	padding: 0 !important;
}
</style>
