/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// A single, app-wide "is anything scrolling right now" signal, shared by
// every speculative-prefetch trigger (mailbox-row hover/touch, viewport
// visibility) that needs to tell "the user paused here on purpose" apart
// from "this row is merely passing through view/under the pointer while
// the list itself is still moving". A per-row dwell timer alone isn't
// enough for that: during a genuinely fast, sustained scroll (searching
// for something deep in a mailbox), individual rows can still sit in the
// viewport, or under a pointer whose target keeps shifting, for longer
// than any reasonable settle delay -- confirmed live, see the
// profile-guided long-list fix in nextcloud-mail-oauth-integration.md
// (2026-07-16), which is why viewport prefetch was pulled entirely
// rather than just re-tuned. This restores it with an explicit guard
// instead of a longer timer, which would only trade one arbitrary
// threshold for another without addressing the actual signal that's
// missing: whether the list itself is moving right now.
const SCROLL_ACTIVITY_IDLE_MS = 150

let lastScrollAt = 0

// Attached once, at module load -- eagerly, not on first isScrollingRecently()
// call. This module is pulled in by ViewportPrefetchMixin.js/Envelope.vue as
// soon as the mailbox list itself loads, well before any real scroll can
// happen, so there's no environment-safety reason (unlike
// viewportPrefetchObserver.js's IntersectionObserver, which doesn't exist in
// every environment) to defer it -- and deferring it would risk missing the
// very first scroll of a session if nothing had queried this yet by then.
if (typeof window !== 'undefined') {
	// One window-level, capture-phase listener rather than one per
	// scrollable container (the mailbox list's own scroller, Priority
	// Inbox's shared multi-section scroller, a search results list, ...).
	// `scroll` events don't bubble, but the capture phase still runs for
	// every ancestor regardless of an event's own `bubbles` flag, so this
	// sees scrolling anywhere in the document without needing to know
	// which element is actually scrolling, or wiring this up separately
	// per list.
	window.addEventListener('scroll', () => {
		lastScrollAt = Date.now()
	}, { capture: true, passive: true })
}

/**
 * @return {boolean} true if any scrollable container fired a scroll event
 * within the last SCROLL_ACTIVITY_IDLE_MS.
 */
export function isScrollingRecently() {
	return Date.now() - lastScrollAt < SCROLL_ACTIVITY_IDLE_MS
}
