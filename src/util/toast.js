/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
	showError as showErrorToast,
	showInfo as showInfoToast,
	showSuccess as showSuccessToast,
	showUndo as showUndoToast,
	showWarning as showWarningToast,
} from '@nextcloud/dialogs'

/**
 * The one place this app raises a toast.
 *
 * @nextcloud/dialogs defaults `close` to false, so a toast could only be got
 * rid of by waiting it out. That is fine for a library default and wrong for
 * us: WCAG 2.2.1 treats content that disappears on a timer as needing a way to
 * dismiss or extend it, and a toast carrying an Undo needs one even more --
 * the user has to read it, decide, and move the pointer, all inside the
 * window.
 *
 * Adding `close: true` at 46 call sites would mean the 47th forgets. Wrapping
 * once means the default is right everywhere and there is a single file to
 * change when it needs to be right differently. A guard-rail spec asserts that
 * nothing else imports the show* functions straight from @nextcloud/dialogs --
 * the same single-owner treatment as util/priorityInbox.js.
 *
 * Callers keep the library's own signatures, so this is a drop-in swap of the
 * import path and nothing else.
 */

/** Toastify's own markup; also the hook for Escape and for the CSS position. */
const TOAST_SELECTOR = '.toastify.dialogs'

const withDefaults = (options) => ({ close: true, ...options })

/**
 * @param {string} message text to show
 * @param {object} [options] @nextcloud/dialogs toast options
 * @return {object} the toast handle
 */
export function showSuccess(message, options) {
	return showSuccessToast(message, withDefaults(options))
}

/**
 * @param {string} message text to show
 * @param {object} [options] @nextcloud/dialogs toast options
 * @return {object} the toast handle
 */
export function showError(message, options) {
	return showErrorToast(message, withDefaults(options))
}

/**
 * @param {string} message text to show
 * @param {object} [options] @nextcloud/dialogs toast options
 * @return {object} the toast handle
 */
export function showWarning(message, options) {
	return showWarningToast(message, withDefaults(options))
}

/**
 * @param {string} message text to show
 * @param {object} [options] @nextcloud/dialogs toast options
 * @return {object} the toast handle
 */
export function showInfo(message, options) {
	return showInfoToast(message, withDefaults(options))
}

/**
 * @param {string} message text to show
 * @param {Function} onUndo called when the user takes the undo action
 * @param {object} [options] @nextcloud/dialogs toast options
 * @return {object} the toast handle
 */
export function showUndo(message, onUndo, options) {
	return showUndoToast(message, onUndo, withDefaults(options))
}

/**
 * Escape dismisses a toast, but ONLY while focus is inside one.
 *
 * Deliberately not a global Escape handler. Escape already closes the
 * composer and the modals, and a global handler would take the undo window
 * away from anyone who pressed it for one of those -- losing the chance to
 * undo is a worse outcome than having to click the close button. Scoping it
 * to focus-within is also what the ARIA authoring practices describe, and it
 * cannot conflict with anything by construction.
 *
 * The listener is delegated from the document because toastify creates and
 * destroys the elements itself; there is nothing stable to bind to.
 */
let escapeListenerRegistered = false

/**
 * Register the Escape-to-dismiss handler once per page.
 *
 * @return {void}
 */
export function registerToastDismissal() {
	if (escapeListenerRegistered || typeof document === 'undefined') {
		return
	}
	escapeListenerRegistered = true
	document.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') {
			return
		}
		const toast = event.target?.closest?.(TOAST_SELECTOR)
		if (!toast) {
			return
		}
		// Nothing else should act on this Escape: the user was demonstrably
		// interacting with the toast, not with whatever is behind it.
		event.stopPropagation()
		toast.remove()
	})
}

/**
 * Test seam: the module-level "registered once" latch would otherwise leak
 * between specs and make the second one silently pass.
 *
 * @return {void}
 */
export function resetToastDismissalForTests() {
	escapeListenerRegistered = false
}
