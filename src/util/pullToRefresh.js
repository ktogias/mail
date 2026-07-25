/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** How far (px) the list must be pulled down before releasing triggers a refresh. */
export const PULL_REFRESH_THRESHOLD_PX = 70
/** Visual drag distance caps out here regardless of how far the finger travels. */
const MAX_PULL_PX = 120
/** Rubber-band feel: the indicator moves slower than the finger. */
const RESISTANCE = 0.5

/**
 * Attach a pull-to-refresh gesture to a scroll container -- the standard
 * mobile pattern (iOS/Android/Gmail): dragging down from the very top past a
 * threshold and releasing triggers a refresh, with a resistance-scaled
 * visual indicator during the drag. Mirrors swipeToDismiss.js's shape: a
 * plain function attaching touchstart/move/end/cancel listeners directly,
 * inline style manipulation for feedback, and a teardown return. Naturally
 * inert on a desktop mouse, which never fires touchstart -- no pointer-type
 * gating needed.
 *
 * @param {HTMLElement|Window} container The real scrolling ancestor (see
 *   getScrollEventTarget in directives/infinite-scroll.js).
 * @param {HTMLElement|undefined|null} indicatorEl Element to visually drag/
 *   spin during the gesture. No-op when absent.
 * @param {object} options
 * @param {() => boolean} options.canStart Re-checked on every touchstart --
 *   false skips the whole gesture (e.g. not scrolled to the top, or this
 *   isn't the topmost of several stacked lists sharing one container).
 * @param {() => (Promise<unknown>|void)} options.onRefresh Called once the
 *   gesture is released past the threshold. The indicator keeps spinning
 *   until any returned promise settles.
 * @return {() => void} Teardown that removes the listeners.
 */
export function enablePullToRefresh(container, indicatorEl, { canStart, onRefresh }) {
	if (!container || !indicatorEl) {
		return () => {}
	}

	let startY = 0
	let dragDistance = 0
	let pulled = 0
	let tracking = false
	let refreshing = false

	const resetIndicator = () => {
		indicatorEl.style.transition = ''
		indicatorEl.style.transform = ''
		indicatorEl.style.opacity = ''
	}

	const onStart = (event) => {
		if (refreshing || !canStart()) {
			return
		}
		startY = event.touches[0].clientY
		dragDistance = 0
		pulled = 0
		tracking = true
		indicatorEl.style.transition = 'none'
	}

	const onMove = (event) => {
		if (!tracking) {
			return
		}
		const deltaY = event.touches[0].clientY - startY
		if (deltaY <= 0) {
			// Scrolled/dragged back up past the start -- not a pull anymore.
			tracking = false
			resetIndicator()
			return
		}
		dragDistance = deltaY
		pulled = Math.min(MAX_PULL_PX, deltaY * RESISTANCE)
		indicatorEl.style.transform = `translateY(${pulled}px) rotate(${pulled * 3}deg)`
		indicatorEl.style.opacity = String(Math.min(1, pulled / PULL_REFRESH_THRESHOLD_PX))
	}

	const onEnd = () => {
		if (!tracking) {
			return
		}
		tracking = false
		indicatorEl.style.transition = ''
		// Threshold is the user's real finger travel. `pulled` is only the
		// resistance-scaled visual distance; comparing that instead made the
		// documented 70px gesture require a 140px drag on real phones.
		if (dragDistance < PULL_REFRESH_THRESHOLD_PX) {
			resetIndicator()
			return
		}
		refreshing = true
		// No further rotation here -- once released, the indicator swaps to
		// a spinner component (its own internal animation), not the
		// drag-proportional rotate() used above during the pull itself.
		indicatorEl.style.transform = `translateY(${PULL_REFRESH_THRESHOLD_PX}px)`
		indicatorEl.style.opacity = '1'
		Promise.resolve(onRefresh()).finally(() => {
			refreshing = false
			resetIndicator()
		})
	}

	container.addEventListener('touchstart', onStart, { passive: true })
	container.addEventListener('touchmove', onMove, { passive: true })
	container.addEventListener('touchend', onEnd)
	container.addEventListener('touchcancel', onEnd)

	return () => {
		container.removeEventListener('touchstart', onStart)
		container.removeEventListener('touchmove', onMove)
		container.removeEventListener('touchend', onEnd)
		container.removeEventListener('touchcancel', onEnd)
	}
}
