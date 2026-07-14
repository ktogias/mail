/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { showUndo, TOAST_UNDO_TIMEOUT } from '@nextcloud/dialogs'

/**
 * Deletes (and only deletes, for now -- see the runbook entry this
 * shipped with for why junk-marking was deliberately left out) had no
 * confirmation dialog and no undo affordance at all: reversibility was
 * entirely implicit ("go find it in Trash and move it back yourself").
 * The stronger, more standard pattern -- Gmail/Thunderbird-style -- is
 * an "N deleted -- Undo" toast: the item disappears immediately (no
 * modal to click through first), but the real, irreversible server-side
 * call is held back for a few seconds in case the user meant something
 * else.
 *
 * This only covers the "disappear immediately, defer the real call"
 * bookkeeping. Callers own two things themselves: what "pending" means
 * for their own rendering (usually filtering it out of whatever list
 * they render), and what the real deferred action actually does.
 */
export default {
	data() {
		return {
			pendingUndoIds: {},
		}
	},

	methods: {
		isPendingUndo(id) {
			return !!this.pendingUndoIds[id]
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
			ids.forEach((id) => this.$set(this.pendingUndoIds, id, true))

			let undone = false
			showUndo(message, () => {
				undone = true
				ids.forEach((id) => this.$delete(this.pendingUndoIds, id))
			})

			await new Promise((resolve) => setTimeout(resolve, TOAST_UNDO_TIMEOUT))

			if (undone) {
				return
			}

			try {
				await action()
			} finally {
				// Harmless if the real action's own optimistic mutation
				// already removed these ids from the underlying store data
				// entirely -- this is just presentation-layer bookkeeping
				// for this component, not a second source of truth.
				ids.forEach((id) => this.$delete(this.pendingUndoIds, id))
			}
		},
	},
}
