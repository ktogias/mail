/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getScrollEventTarget } from '../directives/infinite-scroll.js'
import { ENVELOPE_LIST_BASELINE_SIZE, IDLE_TRIM_MS } from '../store/constants.js'
import useMainStore from '../store/mainStore.js'

// A cheap, approximate stand-in for "is the user currently scrolled near
// where the tail cutoff would visually fall" -- without walking the DOM
// for exact per-row offsets (rows are genuinely variable height), just
// checking how far the viewport's bottom edge sits from the end of the
// currently loaded content is enough to avoid trimming out from under
// someone scrolled deep, while still allowing a trim whenever they're
// comfortably above it. Keep this below one compact-list viewport: a fixed
// 2000px margin classified the 100th row as "near" even from the head on
// some layouts, so ordinary head work could pin the tail forever.
const TRIM_SAFETY_MARGIN_PX = 300

// Once the user has genuinely visited the deep tail and returned above its
// boundary, release it promptly. The longer IDLE_TRIM_MS remains a fallback
// for missed scroll signals; real profiling showed the retained rows can make
// the page unusable well before twelve minutes have elapsed.
export const RETURNED_TAIL_TRIM_MS = 60 * 1000

// scroll fires on every frame of a drag/momentum scroll -- there's no
// need for anything finer than "roughly when did scrolling last happen",
// given this is checked against a many-minutes-long idle threshold.
const SCROLL_ACTIVITY_WRITE_THROTTLE_MS = 5000
const SCROLL_POSITION_SETTLE_MS = 150

/**
 * Idle-and-unselected tail trimming for a single Mailbox instance's own
 * list -- mixed into Mailbox.vue only. Decides WHEN it's safe to call
 * trimIdleEnvelopeListTailMutation() (mainStore/actions.js), which owns
 * the actual trim + heavier-cache-GC logic; this mixin only tracks scroll
 * activity and approximate position.
 *
 * The long-idle fallback piggybacks on syncWatchedMailboxes()'s own tick.
 * A one-shot timer handles the stronger "visited tail, then returned"
 * signal, and Page Visibility checks immediately on transition to hidden.
 * This is a well-
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
			// Activity at the tail boundary, not generic activity anywhere in
			// the shared scroller. The user can keep working and scrolling at
			// the head without keeping a long-forgotten tail alive forever.
			lastTailActivityAt: Date.now(),
			idleTailTrimScrollContainer: undefined,
			idleTailWasVisited: false,
			idleTailReturnTrimTimer: undefined,
			idleTailScrollCheckTimer: undefined,
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
		this.clearIdleTailScrollCheckTimer()
		this.clearIdleTailReturnTrimTimer()
	},

	methods: {
		onIdleTailTrimScrollActivity() {
			this.clearIdleTailScrollCheckTimer()
			this.idleTailScrollCheckTimer = setTimeout(() => {
				this.idleTailScrollCheckTimer = undefined
				this.evaluateIdleTailScrollPosition()
			}, SCROLL_POSITION_SETTLE_MS)
		},

		evaluateIdleTailScrollPosition() {
			if (!this.isScrolledNearIdleTailTrimBoundary()) {
				if (this.idleTailWasVisited) {
					this.scheduleIdleTailReturnTrim()
				}
				return
			}
			if (this.envelopes.length > ENVELOPE_LIST_BASELINE_SIZE) {
				this.idleTailWasVisited = true
				this.clearIdleTailReturnTrimTimer()
			}
			const now = Date.now()
			if (now - this.lastTailActivityAt > SCROLL_ACTIVITY_WRITE_THROTTLE_MS) {
				this.lastTailActivityAt = now
			}
		},

		clearIdleTailScrollCheckTimer() {
			if (this.idleTailScrollCheckTimer !== undefined) {
				clearTimeout(this.idleTailScrollCheckTimer)
				this.idleTailScrollCheckTimer = undefined
			}
		},

		onIdleTailTrimVisibilityChange() {
			if (document.visibilityState === 'hidden') {
				if (this.idleTailWasVisited && !this.isScrolledNearIdleTailTrimBoundary()) {
					this.trimIdleTailNow()
					return
				}
				this.maybeTrimIdleTail()
			}
		},

		clearIdleTailReturnTrimTimer() {
			if (this.idleTailReturnTrimTimer !== undefined) {
				clearTimeout(this.idleTailReturnTrimTimer)
				this.idleTailReturnTrimTimer = undefined
			}
		},

		scheduleIdleTailReturnTrim() {
			if (this.idleTailReturnTrimTimer !== undefined) {
				return
			}
			this.idleTailReturnTrimTimer = setTimeout(() => {
				this.idleTailReturnTrimTimer = undefined
				if (!this.idleTailWasVisited || this.isScrolledNearIdleTailTrimBoundary()) {
					return
				}
				if (!this.trimIdleTailNow() && this.envelopes.length > ENVELOPE_LIST_BASELINE_SIZE) {
					// A selected tail row can temporarily pin the list. Retry
					// locally instead of waiting for another scroll or poll tick.
					this.scheduleIdleTailReturnTrim()
				}
			}, RETURNED_TAIL_TRIM_MS)
		},

		// Walks up from the list's own root element to find the real
		// scrolling ancestor (the shared `.app-content-list` container).
		// Reuse the exact lookup that the pagination sentinel uses, so the
		// two mechanisms cannot silently attach to different scroll roots.
		findIdleTailTrimScrollContainer(el) {
			return el ? getScrollEventTarget(el) : undefined
		},

		// Locate the rendered row at the keep/drop boundary for THIS
		// Mailbox instance. Priority Inbox stacks several Mailbox instances
		// inside one shared scroller, so distance from the shared scroller's
		// bottom says nothing about whether this particular section's tail
		// is visible. Envelope.vue already exposes stable data-envelope-id
		// attributes, so no extra DOM marker or row-height assumption is
		// needed here.
		findIdleTailTrimBoundaryElement() {
			const boundaryCandidates = this.envelopes.slice(ENVELOPE_LIST_BASELINE_SIZE - 1)
			if (boundaryCandidates.length === 0) {
				return undefined
			}
			const renderedRows = this.$el.querySelectorAll('[data-envelope-id]')
			const rowsById = new Map(Array.from(renderedRows)
				.map((row) => [row.getAttribute('data-envelope-id'), row]))
			return boundaryCandidates
				.map((envelope) => rowsById.get(String(envelope.databaseId)))
				.find((row) => row !== undefined)
		},

		// True means trimming now could remove content at or above the
		// viewport. False means the baseline boundary is comfortably below
		// the viewport (or isn't rendered, as with a collapsed manual
		// section), so removing the tail cannot disturb what the user sees.
		isScrolledNearIdleTailTrimBoundary() {
			const container = this.idleTailTrimScrollContainer
			if (!container) {
				return false
			}
			const boundary = this.findIdleTailTrimBoundaryElement()
			if (!boundary) {
				return false
			}

			const containerRect = container === window
				? { top: 0, bottom: window.innerHeight }
				: container.getBoundingClientRect()
			const mailboxRect = this.$el.getBoundingClientRect()
			const boundaryRect = boundary.getBoundingClientRect()

			// This whole section is above the viewport. Removing its tail
			// would shift later visible sections upward, which this one-way
			// trim deliberately never tries to compensate for.
			if (mailboxRect.bottom <= containerRect.top) {
				return true
			}

			return boundaryRect.top <= containerRect.bottom + TRIM_SAFETY_MARGIN_PX
		},

		maybeTrimIdleTail() {
			if (Date.now() - this.lastTailActivityAt < IDLE_TRIM_MS) {
				return
			}
			if (this.isScrolledNearIdleTailTrimBoundary()) {
				return
			}

			this.trimIdleTailNow()
		},

		trimIdleTailNow() {
			// Removing dozens or hundreds of off-screen rows should be a
			// direct release, not dozens or hundreds of transition-group leave
			// animations and short-lived detached nodes.
			this.skipListTransition = true
			const result = this.idleTailTrimStore.trimIdleEnvelopeListTailMutation({
				mailboxId: this.mailbox.databaseId,
				query: this.searchQuery,
			})
			if (!result?.trimmedCount) {
				this.skipListTransition = false
				return false
			}
			this.idleTailWasVisited = false
			this.clearIdleTailReturnTrimTimer()
			this.$nextTick(() => {
				this.skipListTransition = false
			})
			return true
		},
	},
}
