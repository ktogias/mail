/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { observeLoadMoreSentinel } from '../util/loadMoreSentinelObserver.js'

export default {
	data() {
		return {
			loadMoreSentinelObserver: null,
		}
	},

	methods: {
		// Call from the host component's own mounted(), passing the
		// sentinel element (typically a $refs entry) and the callback to
		// run when it comes within range -- see
		// util/loadMoreSentinelObserver.js for why this replaces the old
		// v-infinite-scroll directive.
		registerLoadMoreSentinel(sentinelEl, callback, distance = 300) {
			if (!sentinelEl) {
				return
			}
			this.loadMoreSentinelObserver = observeLoadMoreSentinel(sentinelEl, callback, distance)
		},

		// A same-query authoritative refresh can replace or shrink the list
		// while the sentinel remains inside the trigger margin. An existing
		// IntersectionObserver only reports boundary crossings, so it would
		// stay silent forever. Re-observing establishes a new initial
		// intersection record and lets pagination continue immediately.
		rearmLoadMoreSentinel(sentinelEl, callback, distance = 300) {
			this.unregisterLoadMoreSentinel()
			this.registerLoadMoreSentinel(sentinelEl, callback, distance)
		},

		// Call from the host component's own beforeDestroy(). NOT
		// beforeUnmount(): see nextcloud-mail-vue2-unmount-hook-names
		// memory / commit 45144e3fd -- Vue 2.7's Options API never calls
		// beforeUnmount()/unmounted(), only the names used here.
		unregisterLoadMoreSentinel() {
			this.loadMoreSentinelObserver?.disconnect()
			this.loadMoreSentinelObserver = null
		},
	},
}
