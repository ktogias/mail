/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { IDLE_TRIM_MS } from '../store/constants.js'
import useMainStore from '../store/mainStore.js'

// A cheap, approximate stand-in for "is the user currently scrolled near
// where the tail cutoff would visually fall" -- without walking the DOM
// for exact per-row offsets (rows are genuinely variable height), just
// checking how far the viewport's bottom edge sits from the end of the
// currently loaded content is enough to avoid trimming out from under
// someone scrolled deep, while still allowing a trim whenever they're
// comfortably away from the bottom. A few screens' worth of buffer.
const TRIM_SAFETY_MARGIN_PX = 2000

// scroll fires on every frame of a drag/momentum scroll -- there's no
// need for anything finer than "roughly when did scrolling last happen",
// given this is checked against a many-minutes-long idle threshold.
const SCROLL_ACTIVITY_WRITE_THROTTLE_MS = 5000

/**
 * Idle-and-unselected tail trimming for a single Mailbox instance's own
 * list -- mixed into Mailbox.vue only. Decides WHEN it's safe to call
 * trimIdleEnvelopeListTailMutation() (mainStore/actions.js), which owns
 * the actual trim + heavier-cache-GC logic; this mixin only tracks scroll
 * activity and approximate position.
 *
 * Piggybacks on syncWatchedMailboxes()'s own tick (that action now bumps
 * mainStore.syncTimestamp every tick specifically so this can watch it)
 * rather than running a separate timer, and additionally checks
 * immediately on a Page Visibility transition to hidden -- a well-
 * established pattern for freeing memory once backgrounded (see e.g.
 * Slack's own "unload teams you haven't looked at in a while"). Both
 * paths funnel through the exact same safety checks below, so
 * backgrounding only means "check now instead of waiting for the next
 * tick," never a bypass of them.
 *
 * Assumes the host component (Mailbox.vue) exposes `mailbox`/
 * `searchQuery` the same way it already does today.
 */
export default {
	data() {
		return {
			lastScrollActivityAt: Date.now(),
			idleTailTrimScrollContainer: undefined,
		}
	},

	computed: {
		// Named distinctly from the host's own `mainStore` (Mailbox.vue
		// already has one via mapStores()) so this mixin never depends on
		// how -- or whether -- the host itself wires that up.
		idleTailTrimStore() {
			return useMainStore()
		},
	},

	watch: {
		'idleTailTrimStore.syncTimestamp': function idleTailTrimOnSyncTick() {
			this.maybeTrimIdleTail()
		},
	},

	mounted() {
		this.idleTailTrimScrollContainer = this.findIdleTailTrimScrollContainer(this.$el)
		this.idleTailTrimScrollContainer?.addEventListener('scroll', this.onIdleTailTrimScrollActivity, { passive: true })
		document.addEventListener('visibilitychange', this.onIdleTailTrimVisibilityChange)
	},

	beforeDestroy() {
		this.idleTailTrimScrollContainer?.removeEventListener('scroll', this.onIdleTailTrimScrollActivity)
		document.removeEventListener('visibilitychange', this.onIdleTailTrimVisibilityChange)
	},

	methods: {
		onIdleTailTrimScrollActivity() {
			const now = Date.now()
			if (now - this.lastScrollActivityAt > SCROLL_ACTIVITY_WRITE_THROTTLE_MS) {
				this.lastScrollActivityAt = now
			}
		},

		onIdleTailTrimVisibilityChange() {
			if (document.visibilityState === 'hidden') {
				this.maybeTrimIdleTail()
			}
		},

		// Walks up from the list's own root element to find the real
		// scrolling ancestor (the shared `.app-content-list` container --
		// see the priority-inbox/page-mode investigation elsewhere in
		// this codebase for why this is an ancestor, not something this
		// component owns) -- deliberately not pulling in a library like
		// `scrollparent` just for this one small, mechanical lookup.
		findIdleTailTrimScrollContainer(el) {
			let node = el?.parentElement
			while (node) {
				const overflowY = window.getComputedStyle(node).overflowY
				if (overflowY === 'auto' || overflowY === 'scroll') {
					return node
				}
				node = node.parentElement
			}
			return document.scrollingElement ?? undefined
		},

		// Cheap, approximate: skip entirely if we can't determine
		// position at all (the idle timer + selection check below are
		// still a real safety net on their own) rather than blocking the
		// trim indefinitely just because no scrollable ancestor was found.
		isScrolledNearIdleTailTrimBoundary() {
			const container = this.idleTailTrimScrollContainer
			if (!container) {
				return false
			}
			const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight)
			return distanceFromBottom < TRIM_SAFETY_MARGIN_PX
		},

		maybeTrimIdleTail() {
			if (Date.now() - this.lastScrollActivityAt < IDLE_TRIM_MS) {
				return
			}
			if (this.isScrolledNearIdleTailTrimBoundary()) {
				return
			}
			this.idleTailTrimStore.trimIdleEnvelopeListTailMutation({
				mailboxId: this.mailbox.databaseId,
				query: this.searchQuery,
			})
		},
	},
}
