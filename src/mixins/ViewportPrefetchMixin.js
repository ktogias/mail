/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
					this.viewportPrefetchTimer = setTimeout(() => {
						runIfViewportPrefetchSlotAvailable(callback)
					}, VIEWPORT_PREFETCH_SETTLE_MS)
				} else if (this.viewportPrefetchTimer !== null) {
					clearTimeout(this.viewportPrefetchTimer)
					this.viewportPrefetchTimer = null
				}
			})
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
