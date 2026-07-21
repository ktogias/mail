/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Matches iOS/Android's own long-press convention.
export const LONG_PRESS_DELAY_MS = 500

// A deliberate, non-zero tolerance -- NOT the same zero-threshold cancel
// HoverPrefetchMixin's cancelHoverPrefetch() uses for its own much shorter
// (60ms) touch timer. A 500ms hold is long enough that ordinary hand
// tremor will very likely produce at least one small touchmove tick before
// it elapses; reusing a zero-threshold cancel here would make long-press
// effectively never fire. This is a standard touch-slop-sized value.
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10

/**
 * A generic long-press timer: arm on touchstart, cancel on meaningful
 * movement or an early release. Deliberately its own independent timer
 * slot (not reused from HoverPrefetchMixin) so a long-press hold and a
 * speculative touch-prefetch timer can coexist on the very same
 * touchstart without clobbering each other.
 */
export default {
	data() {
		return {
			longPressTimer: null,
			longPressStartX: 0,
			longPressStartY: 0,
		}
	},

	beforeDestroy() {
		this.cancelLongPress()
	},

	methods: {
		armLongPress(event, callback) {
			this.cancelLongPress()
			const touch = event?.touches?.[0]
			if (!touch) {
				return
			}
			this.longPressStartX = touch.clientX
			this.longPressStartY = touch.clientY
			this.longPressTimer = setTimeout(callback, LONG_PRESS_DELAY_MS)
		},

		checkLongPressMove(event) {
			if (this.longPressTimer === null) {
				return
			}
			const touch = event?.touches?.[0]
			if (!touch) {
				return
			}
			const dx = touch.clientX - this.longPressStartX
			const dy = touch.clientY - this.longPressStartY
			if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE_PX) {
				this.cancelLongPress()
			}
		},

		cancelLongPress() {
			if (this.longPressTimer !== null) {
				clearTimeout(this.longPressTimer)
				this.longPressTimer = null
			}
		},
	},
}
