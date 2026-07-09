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
		startHoverPrefetch(callback) {
			this.cancelHoverPrefetch()
			this.hoverPrefetchTimer = setTimeout(callback, HOVER_PREFETCH_DELAY_MS)
		},

		cancelHoverPrefetch() {
			if (this.hoverPrefetchTimer !== null) {
				clearTimeout(this.hoverPrefetchTimer)
				this.hoverPrefetchTimer = null
			}
		},
	},
}
