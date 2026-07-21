/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getScrollEventTarget, getScrollTop } from '../directives/infinite-scroll.js'
import { enablePullToRefresh } from '../util/pullToRefresh.js'

// How close (px) this instance's own top edge must sit to the shared
// scroll container's top edge to count as "the topmost section" -- allows
// for sub-pixel/rounding differences, not a real visual gap.
const TOP_ALIGN_TOLERANCE_PX = 4

/**
 * Pull-to-refresh for a single Mailbox instance's own list -- mixed into
 * Mailbox.vue only. Attaches to the same scroll container
 * IdleTailTrimMixin already resolves (getScrollEventTarget), so the two
 * mechanisms never attach to different scroll roots.
 *
 * Priority Inbox stacks several Mailbox instances against one shared
 * scroller. Rather than special-casing which view layout is allowed to
 * pull-to-refresh, canStart() re-checks on every touch which instance is
 * currently sitting at the container's own scrolled-to-top edge -- that is
 * always exactly one instance (whichever section is visually topmost),
 * and only that instance's gesture will actually start.
 *
 * Requires a `pullToRefreshIndicator` ref in the host's template and calls
 * the host's own sync(false) -- the same call the existing `r` keyboard
 * shortcut already uses -- rather than a new sync path.
 */
export default {
	data() {
		return {
			pullToRefreshTeardown: undefined,
			pullToRefreshSpinning: false,
		}
	},

	mounted() {
		const container = getScrollEventTarget(this.$el)
		this.pullToRefreshTeardown = enablePullToRefresh(container, this.$refs.pullToRefreshIndicator, {
			canStart: () => this.isTopmostPullToRefreshTarget(container),
			onRefresh: () => {
				this.pullToRefreshSpinning = true
				return this.sync(false)
					.catch(() => {})
					.finally(() => {
						this.pullToRefreshSpinning = false
					})
			},
		})
	},

	beforeDestroy() {
		this.pullToRefreshTeardown?.()
	},

	methods: {
		isTopmostPullToRefreshTarget(container) {
			if (getScrollTop(container) > 0) {
				return false
			}
			const containerRect = container === window
				? { top: 0 }
				: container.getBoundingClientRect()
			return this.$el.getBoundingClientRect().top <= containerRect.top + TOP_ALIGN_TOLERANCE_PX
		},
	},
}
