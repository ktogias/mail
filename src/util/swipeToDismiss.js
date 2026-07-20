/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** How far (px) the toast must be dragged before a release dismisses it. */
const DISMISS_THRESHOLD_PX = 80
/** Distance (px) over which the toast fades fully out while dragging. */
const FADE_OVER_PX = 200

/**
 * Attach horizontal swipe-to-dismiss to a toast element -- the standard mobile
 * snackbar gesture (Material). Dragging past a threshold flings the element out
 * and calls onDismiss(); a shorter drag snaps it back. A plain tap moves
 * nothing, so the Undo button inside the toast still works. Mostly-vertical
 * gestures are ignored so the page can still scroll.
 *
 * @param {HTMLElement|undefined|null} element The toast's DOM node (Toastify's
 *   `toastElement`). No-op when absent (e.g. in unit tests where showUndo is
 *   mocked).
 * @param {() => void} onDismiss Called once the element has been swiped away.
 * @return {() => void} Teardown that removes the listeners.
 */
export function enableSwipeToDismiss(element, onDismiss) {
	if (!element) {
		return () => {}
	}

	// Let the browser keep handling vertical panning (page scroll) but hand
	// horizontal gestures to us, so the swipe isn't eaten as a scroll/refresh.
	const previousTouchAction = element.style.touchAction
	element.style.touchAction = 'pan-y'

	let startX = 0
	let startY = 0
	let deltaX = 0
	let tracking = false

	const onStart = (event) => {
		const touch = event.touches[0]
		startX = touch.clientX
		startY = touch.clientY
		deltaX = 0
		tracking = true
		element.style.transition = 'none'
	}

	const onMove = (event) => {
		if (!tracking) {
			return
		}
		const touch = event.touches[0]
		deltaX = touch.clientX - startX
		// Ignore mostly-vertical gestures -- let the page scroll instead.
		if (Math.abs(touch.clientY - startY) > Math.abs(deltaX)) {
			return
		}
		element.style.transform = `translateX(${deltaX}px)`
		element.style.opacity = String(Math.max(0, 1 - Math.abs(deltaX) / FADE_OVER_PX))
	}

	const onEnd = () => {
		if (!tracking) {
			return
		}
		tracking = false
		element.style.transition = ''
		if (Math.abs(deltaX) > DISMISS_THRESHOLD_PX) {
			element.style.transform = `translateX(${deltaX > 0 ? 120 : -120}%)`
			element.style.opacity = '0'
			setTimeout(() => onDismiss(), 200)
		} else {
			// Snap back.
			element.style.transform = ''
			element.style.opacity = ''
		}
	}

	element.addEventListener('touchstart', onStart, { passive: true })
	element.addEventListener('touchmove', onMove, { passive: true })
	element.addEventListener('touchend', onEnd)
	element.addEventListener('touchcancel', onEnd)

	return () => {
		element.style.touchAction = previousTouchAction
		element.removeEventListener('touchstart', onStart)
		element.removeEventListener('touchmove', onMove)
		element.removeEventListener('touchend', onEnd)
		element.removeEventListener('touchcancel', onEnd)
	}
}
