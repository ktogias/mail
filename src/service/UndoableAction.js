/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { showUndo, TOAST_UNDO_TIMEOUT } from '@nextcloud/dialogs'
import { enableSwipeToDismiss } from '../util/swipeToDismiss.js'

/**
 * Plain-JS core of the "hide immediately, defer the real action, restore
 * on Undo" pattern used throughout this app's delete/archive/junk/move
 * actions (see UndoableActionMixin.js for the Vue-component version,
 * which additionally tracks which ids to hide from its own rendering).
 * Extracted here so non-Vue-component code -- the drag-and-drop
 * directive is a plain JS class, not a component, so it can't use a Vue
 * mixin at all -- gets the exact same undo semantics rather than a
 * separately-maintained, likely-to-drift copy.
 *
 * @param {object} options The action to defer and its undo bookkeeping.
 * @param {string} options.message Shown on the undo toast.
 * @param {() => Promise<void>} options.action The real, deferred action --
 * only ever called if the user doesn't click Undo.
 * @param {() => void} [options.onUndo] Called synchronously the moment
 * Undo is clicked (before the undo window has even finished counting
 * down) -- for callers that need to react immediately (e.g. a Vue
 * component making a hidden row reappear right away), not just once
 * this whole function's returned promise settles.
 * @return {Promise<void>} Resolves once the undo window has passed and
 * (if not undone) the action has settled.
 */
export async function deferWithUndo({ message, action, onUndo }) {
	let undone = false
	// Snapshot the toasts already on screen so we can identify the one this
	// call adds -- Toastify's bundled build doesn't expose the element on the
	// returned instance under a stable name, so we diff the DOM instead of
	// relying on a `toastElement` property.
	const before = new Set(typeof document !== 'undefined'
		? document.querySelectorAll('.toastify.dialogs')
		: [])
	const toast = showUndo(message, () => {
		undone = true
		onUndo?.()
	}, {
		// Also request a close (×) button where the theme renders one; on
		// mobile the primary dismissal is the swipe gesture below.
		close: true,
		timeout: TOAST_UNDO_TIMEOUT,
	})

	// Swipe-to-dismiss (the standard mobile snackbar gesture): flinging the
	// toast away just hides it, it does NOT undo -- the deferred action still
	// runs when the window passes, matching a normal snackbar.
	const element = typeof document !== 'undefined'
		? [...document.querySelectorAll('.toastify.dialogs')].find((el) => !before.has(el))
		: undefined
	enableSwipeToDismiss(element, () => {
		if (toast?.hideToast instanceof Function) {
			toast.hideToast()
		} else {
			element?.remove()
		}
	})

	await new Promise((resolve) => setTimeout(resolve, TOAST_UNDO_TIMEOUT))

	if (undone) {
		return
	}

	await action()
}
