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

/**
 * Distance from the bottom edge to the newest toast, and between toasts.
 * Matches the base offset in css/mail.scss so a single un-stacked toast does
 * not move when the first restack runs.
 */
const STACK_EDGE_PX = 16
const STACK_GAP_PX = 8

/**
 * How many toasts stay on screen at once.
 *
 * Toastify already stacks -- it writes a cumulative inline `top` -- but the
 * stylesheet has to overwrite `top` to move the toasts off the corner where
 * they covered the thread's buttons, and that is what flattened the stack.
 * So the offsets are recomputed here against the bottom edge instead.
 *
 * Newest nearest the edge, older pushed away: the Sonner/Radix arrangement,
 * and the one that keeps the row you just acted on where your eye already is.
 *
 * The cap exists because a burst of deletes would otherwise pile toasts past
 * the top of the viewport. Five rather than the usual three: the point of
 * stacking here is to keep several UNDO windows in view at once, and an undo
 * window is 7s, so five concurrent toasts already means five actions inside
 * seven seconds. The oldest at that point is the closest to expiring anyway.
 */
const MAX_VISIBLE_TOASTS = 5

/** Element -> toastify handle, so an over-cap toast can be retired properly. */
const handles = new WeakMap()

/**
 * Re-lay the visible toasts as a stack anchored to the bottom edge.
 *
 * Toastify inserts the newest FIRST in the DOM (`oldestFirst: true` makes it
 * insertBefore the current first child), so document order is newest to
 * oldest, which is the order this needs anyway.
 *
 * @return {void}
 */
function restack() {
	if (typeof document === 'undefined') {
		return
	}
	let offset = STACK_EDGE_PX
	document.querySelectorAll(TOAST_SELECTOR).forEach((element, index) => {
		if (index >= MAX_VISIBLE_TOASTS) {
			const handle = handles.get(element)
			// hideToast() where we have the handle, so toastify tears down its
			// own timers and callbacks rather than being left with a reference
			// to an element that is no longer in the document.
			if (handle?.hideToast instanceof Function) {
				handle.hideToast()
			} else {
				element.remove()
			}
			return
		}
		// A custom property rather than `bottom` itself: the stylesheet keeps
		// ownership of the safe-area inset (which JS cannot read reliably) and
		// of the !important needed to beat toastify's inline `top`, while this
		// only supplies the one number it actually knows.
		element.style.setProperty('--mail-toast-offset', `${offset}px`)
		offset += element.offsetHeight + STACK_GAP_PX
	})
}

/**
 * Call the library, then take ownership of where the result sits.
 *
 * @param {Function} show the underlying @nextcloud/dialogs function
 * @param {Array} args its leading arguments (message, and onUndo for showUndo)
 * @param {object} [options] caller options
 * @return {object} the toast handle
 */
function raise(show, args, options) {
	const before = typeof document !== 'undefined'
		? new Set(document.querySelectorAll(TOAST_SELECTOR))
		: new Set()

	const merged = { close: true, ...options }
	const callerOnRemove = merged.onRemove
	merged.onRemove = function(...rest) {
		callerOnRemove?.apply(this, rest)
		// Toastify fires this AFTER the element has left the document, so the
		// survivors can be measured immediately.
		restack()
	}

	const handle = show(...args, merged)

	if (typeof document !== 'undefined') {
		const element = [...document.querySelectorAll(TOAST_SELECTOR)].find((el) => !before.has(el))
		if (element) {
			handles.set(element, handle)
		}
	}
	restack()

	return handle
}

/**
 * @param {string} message text to show
 * @param {object} [options] @nextcloud/dialogs toast options
 * @return {object} the toast handle
 */
export function showSuccess(message, options) {
	return raise(showSuccessToast, [message], options)
}

/**
 * @param {string} message text to show
 * @param {object} [options] @nextcloud/dialogs toast options
 * @return {object} the toast handle
 */
export function showError(message, options) {
	return raise(showErrorToast, [message], options)
}

/**
 * @param {string} message text to show
 * @param {object} [options] @nextcloud/dialogs toast options
 * @return {object} the toast handle
 */
export function showWarning(message, options) {
	return raise(showWarningToast, [message], options)
}

/**
 * @param {string} message text to show
 * @param {object} [options] @nextcloud/dialogs toast options
 * @return {object} the toast handle
 */
export function showInfo(message, options) {
	return raise(showInfoToast, [message], options)
}

/**
 * @param {string} message text to show
 * @param {Function} onUndo called when the user takes the undo action
 * @param {object} [options] @nextcloud/dialogs toast options
 * @return {object} the toast handle
 */
export function showUndo(message, onUndo, options) {
	return raise(showUndoToast, [message, onUndo], options)
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
		// Through the handle where we have one, so toastify tears its own
		// timers down; and the survivors have to close the gap either way,
		// because removing the element directly never reaches onRemove.
		const handle = handles.get(toast)
		if (handle?.hideToast instanceof Function) {
			handle.hideToast()
		} else {
			toast.remove()
		}
		restack()
		// Nothing else should act on this Escape: the user was demonstrably
		// interacting with the toast, not with whatever is behind it.
		event.stopPropagation()
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
