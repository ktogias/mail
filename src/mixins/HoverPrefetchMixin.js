/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// How long the pointer has to stay over a row before its prefetch fires.
// Short enough to comfortably land before a deliberate click, long enough
// that a mouse merely passing over several rows on its way elsewhere
// doesn't fire one wasted request per row -- this app's mail FPM pool is
// only 4 workers wide (see the sync-latency work throughout this
// runbook), so an unbounded "prefetch on every mouseenter" would trade
// message-open latency for exactly the kind of pool contention that's
// been fixed everywhere else.
export const HOVER_PREFETCH_DELAY_MS = 200

// Touch has no equivalent of "hovering before a deliberate click": a tap's
// own touchstart-to-navigation window is itself only ~100-150ms, so this
// app's mouse-hover prefetch (mouseenter-only) never gets a head start on
// touch devices -- confirmed live on mobile Firefox/Android (slow message
// opens, no request visible in the network panel until the tap itself).
// touchstart is the equivalent trigger, but its delay has to be much
// shorter than the mouse's -- waiting the full 200ms would fire after the
// tap's own click already landed, defeating the purpose. The real guard
// against wasted requests here isn't the delay (a scroll's touchmove
// fires well within this window) but touchmove itself cancelling the
// timer, mirroring mouseleave -- see cancelHoverPrefetch().
export const TOUCH_PREFETCH_DELAY_MS = 60

export default {
	data() {
		return {
			hoverPrefetchTimer: null,
		}
	},

	beforeDestroy() {
		// NOT beforeUnmount(): see nextcloud-mail-vue2-unmount-hook-names
		// memory / commit 45144e3fd -- Vue 2.7's Options API never calls
		// beforeUnmount()/unmounted(), only the names used here.
		this.cancelHoverPrefetch()
	},

	methods: {
		startHoverPrefetch(callback, delay = HOVER_PREFETCH_DELAY_MS) {
			this.cancelHoverPrefetch()
			this.hoverPrefetchTimer = setTimeout(callback, delay)
		},

		startTouchPrefetch(callback) {
			this.startHoverPrefetch(callback, TOUCH_PREFETCH_DELAY_MS)
		},

		cancelHoverPrefetch() {
			if (this.hoverPrefetchTimer !== null) {
				clearTimeout(this.hoverPrefetchTimer)
				this.hoverPrefetchTimer = null
			}
		},
	},
}
