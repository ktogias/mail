/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { isScrollingRecently } from '../util/scrollActivityTracker.js'
import { observeViewportVisibility, runIfViewportPrefetchSlotAvailable, unobserveViewportVisibility } from '../util/viewportPrefetchObserver.js'

// How long a row must stay continuously visible before its prefetch
// fires, cancelled early if it scrolls back out of view first (mirrors
// mouseleave/touchmove cancelling the hover/touch timers in
// HoverPrefetchMixin.js). Longer than either of those delays: viewport
// entry alone is a weaker intent signal than a pointer actually on the
// row, and a fast flick-scroll through a page of rows (PAGE_SIZE = 20)
// takes well under a second -- this needs to comfortably outlast that.
export const VIEWPORT_PREFETCH_SETTLE_MS = 300

export default {
	data() {
		return {
			viewportPrefetchTimer: null,
		}
	},

	methods: {
		// Call from the host component's own mounted().
		registerViewportPrefetch(callback) {
			observeViewportVisibility(this.$el, (isIntersecting) => {
				if (isIntersecting) {
					this.armViewportPrefetchTimer(callback)
				} else if (this.viewportPrefetchTimer !== null) {
					clearTimeout(this.viewportPrefetchTimer)
					this.viewportPrefetchTimer = null
				}
			})
		},

		armViewportPrefetchTimer(callback) {
			this.viewportPrefetchTimer = setTimeout(() => {
				if (isScrollingRecently()) {
					// Still visible, but the list itself is still moving --
					// this row merely passed through view during an active
					// scroll, not a settled pause. Keep waiting rather than
					// firing; if it scrolls back out of view first, the
					// isIntersecting callback above cancels this for good
					// (naturally bounded -- either scrolling stops, or the
					// row leaves the viewport).
					this.armViewportPrefetchTimer(callback)
					return
				}
				this.viewportPrefetchTimer = null
				runIfViewportPrefetchSlotAvailable(callback)
			}, VIEWPORT_PREFETCH_SETTLE_MS)
		},

		// Call from the host component's own beforeDestroy(). NOT
		// beforeUnmount(): see nextcloud-mail-vue2-unmount-hook-names
		// memory / commit 45144e3fd -- Vue 2.7's Options API never calls
		// beforeUnmount()/unmounted(), only the names used here.
		unregisterViewportPrefetch() {
			if (this.viewportPrefetchTimer !== null) {
				clearTimeout(this.viewportPrefetchTimer)
				this.viewportPrefetchTimer = null
			}
			unobserveViewportVisibility(this.$el)
		},
	},
}
