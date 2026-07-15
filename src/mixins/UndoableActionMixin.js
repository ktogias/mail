/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { deferWithUndo } from '../service/UndoableAction.js'
import useMainStore from '../store/mainStore.js'

/**
 * Delete (and now archive, junk-marking and move too) had no
 * confirmation dialog and no undo affordance at all: reversibility was
 * entirely implicit ("go find it in Trash/Junk/the destination folder
 * and move it back yourself"). The stronger, more standard pattern --
 * Gmail/Thunderbird-style -- is an "N deleted -- Undo" toast: the item
 * disappears immediately (no modal to click through first), but the
 * real, irreversible server-side call is held back for a few seconds
 * in case the user meant something else.
 *
 * This only covers the "disappear immediately, defer the real call"
 * bookkeeping. Callers own two things themselves: what "pending" means
 * for their own rendering (usually filtering it out of whatever list
 * they render), and what the real deferred action actually does.
 *
 * The actual toast/timer/undo mechanics live in
 * ../service/UndoableAction.js's deferWithUndo() -- shared with the
 * drag-and-drop directive, which isn't a Vue component and can't use
 * this mixin at all.
 *
 * "Pending" bookkeeping itself lives in the Pinia store
 * (pendingRemovals/beginPendingRemoval()/endPendingRemoval()/
 * isPendingRemoval() in mainStore.js/actions.js), not here. It used to
 * be per-component data() -- confirmed live that this was a real bug,
 * not just a theoretical one: MailboxThread.vue mounts several
 * Mailbox.vue instances at once (Priority Inbox's Favorites/Follow
 * up/Important/Other sections) plus an independent Thread.vue reading
 * pane, and a message deleted from one of them stayed fully visible in
 * every OTHER one for the whole undo window, since each instance only
 * ever knew about its own copy of "what's pending." Delegating to the
 * store instead means every consumer of isPendingUndo() sees the same
 * answer, instantly, regardless of which component instance triggered
 * the action -- this mixin's own method names/signatures are unchanged
 * so no caller (Mailbox.vue/EnvelopeList.vue/Thread.vue) needed to
 * change anything.
 */
export default {
	methods: {
		isPendingUndo(id) {
			return useMainStore().isPendingRemoval(id)
		},

		/**
		 * @param {object} options The action to defer and its undo bookkeeping.
		 * @param {Array<number|string>} options.ids Ids to hide immediately
		 * (via isPendingUndo()) until the undo window passes or the user
		 * clicks Undo.
		 * @param {string} options.message Shown on the undo toast.
		 * @param {() => Promise<void>} options.action The real, deferred
		 * action -- only ever called if the user doesn't click Undo.
		 * @return {Promise<void>} Resolves once the undo window has
		 * passed and (if not undone) the action has settled. Callers that
		 * need to do something immediately (e.g. navigation) should do it
		 * before awaiting this, not after.
		 */
		async performActionWithUndo({ ids, message, action }) {
			const store = useMainStore()
			store.beginPendingRemoval(ids)

			try {
				await deferWithUndo({
					message,
					action,
					// Restores visibility the instant Undo is clicked, not
					// once the full window has counted down -- the whole
					// point of undo is that clicking it should feel
					// immediate.
					onUndo: () => store.endPendingRemoval(ids),
				})
			} finally {
				// Harmless if onUndo above (or the real action's own
				// optimistic mutation) already removed these ids --
				// this is just presentation-layer bookkeeping, not a
				// second source of truth.
				store.endPendingRemoval(ids)
			}
		},
	},
}
