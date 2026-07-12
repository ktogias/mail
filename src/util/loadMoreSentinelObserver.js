/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getScrollEventTarget } from '../directives/infinite-scroll.js'

// Replaces the manual scroll-position math the v-infinite-scroll directive
// used to do on every (throttled) scroll event with an IntersectionObserver
// watching a sentinel element placed at the end of the list -- cheaper
// (browser-native, batched per frame, not per scroll pixel) and fires
// exactly on the boundary crossing rather than repeatedly while positioned
// near the bottom, unlike a scroll listener. One observer per call, not a
// shared singleton like viewportPrefetchObserver.js: there's exactly one
// sentinel per list, not many rows.
//
// Reuses infinite-scroll.js's own getScrollEventTarget() to find the
// correct scrollable ancestor for IntersectionObserver's `root` option --
// this list isn't always the whole page; Nextcloud's AppContent layout can
// give it its own internal scroll container. Getting `root` wrong means
// the observer silently never fires (its intersection ratio would never
// change from whatever it started at), so behavioral parity with the
// directive's own detection matters here, not just convenience.

/**
 * @param {Element} sentinelEl element placed at the end of the list
 * @param {() => void} callback called once when the sentinel crosses into
 * the trigger distance -- NOT repeatedly while it stays there, unlike the
 * scroll listener it replaces
 * @param {number} distance px before the sentinel is actually on-screen to
 * fire the callback, matching the old infinite-scroll-distance semantics
 * @return {IntersectionObserver|null} null if IntersectionObserver isn't
 * available (old browser, or a test environment) -- caller just won't get
 * scroll-triggered pagination in that case, same as the directive would
 * have silently done nothing useful either.
 */
export function observeLoadMoreSentinel(sentinelEl, callback, distance = 300) {
	if (typeof IntersectionObserver === 'undefined') {
		return null
	}

	const scrollTarget = getScrollEventTarget(sentinelEl)
	const observer = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (entry.isIntersecting) {
				callback()
			}
		}
	}, {
		// getScrollEventTarget() returns the literal `window` object when
		// no scrollable ancestor is found -- IntersectionObserver's root
		// option requires `null` for that same "viewport-relative" case.
		root: scrollTarget === window ? null : scrollTarget,
		rootMargin: `0px 0px ${distance}px 0px`,
	})
	observer.observe(sentinelEl)
	return observer
}
