/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TOAST_PERMANENT_TIMEOUT, TOAST_UNDO_TIMEOUT } from '@nextcloud/dialogs'
import { enableSwipeToDismiss } from '../util/swipeToDismiss.js'
import { showUndo } from '../util/toast.js'

/**
 * Longest the undo window may be held open by a hovering pointer before it
 * resumes on its own. Generous enough that a deliberate pause is never cut
 * short, short enough that a pointer left resting on the toast cannot keep a
 * delete pending indefinitely.
 */
const MAX_UNDO_HOLD = 60_000

/**
 * A setTimeout that can be held.
 *
 * The undo window is what the user is racing, so it has to stop while they are
 * reaching for the button -- that is the part of the snackbar pattern people
 * actually feel. Material specifies it; toastify has no such feature.
 *
 * The cap exists because the thing being held is not merely a visual: it is a
 * real delete/archive that has already been hidden from the list. A pointer
 * left resting on the toast would otherwise defer that action for as long as
 * the tab stayed open, leaving the message hidden but not actually moved until
 * a reload put it back.
 *
 * @param {Function} onElapsed run once the full duration has passed
 * @param {number} duration base window in ms
 * @param {number} maxHold longest total time the window may be held open
 * @return {{pause: Function, resume: Function, cancel: Function}} controls
 */
function holdableTimer(onElapsed, duration, maxHold) {
	let remaining = duration
	let startedAt = Date.now()
	let handle = setTimeout(onElapsed, remaining)
	let holdHandle

	function resume() {
		if (handle !== undefined) {
			return
		}
		clearTimeout(holdHandle)
		holdHandle = undefined
		startedAt = Date.now()
		handle = setTimeout(onElapsed, Math.max(0, remaining))
	}

	function pause() {
		if (handle === undefined) {
			return
		}
		clearTimeout(handle)
		handle = undefined
		remaining -= Date.now() - startedAt
		// Enforced WHILE held, not on release: a pointer that comes to rest on
		// the toast never produces a resume event, so a cap checked only on the
		// way out would never fire.
		holdHandle = setTimeout(resume, maxHold)
	}

	return {
		pause,
		resume,
		cancel() {
			clearTimeout(handle)
			clearTimeout(holdHandle)
			handle = undefined
			holdHandle = undefined
		},
	}
}

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
	// Clicking Undo ends the window there and then. Without this the promise
	// would keep counting down after the decision had already been made -- and
	// if the pointer was still resting on the toast (which it is, immediately
	// after a click) the hold would keep it counting for longer still.
	let endWindow
	const toast = showUndo(message, () => {
		undone = true
		onUndo?.()
		endWindow?.()
	}, {
		// The undo window is owned by the holdable timer below and the toast is
		// hidden when it elapses, so the toast must NOT run a competing timer of
		// its own. It used to: toastify counted down independently, so pausing
		// ours on hover would have left the button on screen after the action
		// had already gone through, or taken the button away while it had not.
		// One clock, and the toast is visible for exactly as long as undoing is
		// still possible.
		timeout: TOAST_PERMANENT_TIMEOUT,
	})

	// Swipe-to-dismiss (the standard mobile snackbar gesture): flinging the
	// toast away just hides it, it does NOT undo -- the deferred action still
	// runs when the window passes, matching a normal snackbar.
	const element = typeof document !== 'undefined'
		? [...document.querySelectorAll('.toastify.dialogs')].find((el) => !before.has(el))
		: undefined
	const hide = () => {
		if (toast?.hideToast instanceof Function) {
			toast.hideToast()
		} else {
			element?.remove()
		}
	}
	enableSwipeToDismiss(element, hide)

	await new Promise((resolve) => {
		const timer = holdableTimer(() => {
			timer.cancel()
			hide()
			resolve()
		}, TOAST_UNDO_TIMEOUT, MAX_UNDO_HOLD)
		endWindow = () => {
			timer.cancel()
			resolve()
		}

		// Stop the clock while the user is reaching for Undo. pointerenter
		// rather than mouseenter so a pen or touch hold counts too; focusin so
		// it also holds for someone arriving by keyboard, who needs the window
		// at least as much.
		element?.addEventListener('pointerenter', timer.pause)
		element?.addEventListener('focusin', timer.pause)
		element?.addEventListener('pointerleave', timer.resume)
		element?.addEventListener('focusout', timer.resume)
	})

	if (undone) {
		return
	}

	await action()
}
