/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Shared across every list row that observes its own viewport visibility
// for prefetch purposes -- one IntersectionObserver instance, not one per
// row (the naive version many tutorials show). Browsers already batch
// intersection checks per animation frame regardless; multiple independent
// observer instances only add setup/dispatch overhead for no benefit.
//
// rootMargin expands the observed area slightly below the fold so a row
// about to be scrolled into view can start its settle timer (see
// ViewportPrefetchMixin.js) a little early, without being so generous it
// defeats the point of using viewport signal at all.
const ROOT_MARGIN = '150px 0px'

const callbacksByElement = new WeakMap()
let sharedObserver

function getSharedObserver() {
	if (sharedObserver !== undefined) {
		return sharedObserver
	}
	if (typeof IntersectionObserver === 'undefined') {
		// Old browser (or a test environment -- jsdom has no
		// IntersectionObserver) -- degrade to "never intersecting"
		// rather than throwing. touchstart/mouseenter prefetch still
		// covers these cases regardless.
		sharedObserver = null
		return sharedObserver
	}
	sharedObserver = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			callbacksByElement.get(entry.target)?.(entry.isIntersecting)
		}
	}, { rootMargin: ROOT_MARGIN })
	return sharedObserver
}

/**
 * Start observing an element's viewport visibility.
 *
 * @param {Element} el element to observe
 * @param {(isIntersecting: boolean) => void} callback called every time the
 * element crosses the observer's threshold
 */
export function observeViewportVisibility(el, callback) {
	const observer = getSharedObserver()
	if (observer === null) {
		return
	}
	callbacksByElement.set(el, callback)
	observer.observe(el)
}

/**
 * @param {Element} el element previously passed to observeViewportVisibility
 */
export function unobserveViewportVisibility(el) {
	const observer = getSharedObserver()
	if (observer === null) {
		return
	}
	observer.unobserve(el)
	callbacksByElement.delete(el)
}

// How many viewport-triggered prefetches this app allows in flight at
// once, app-wide. Unlike hover/touchstart (inherently one row at a time --
// whatever the pointer is actually on), a scroll-then-pause gesture can
// settle a whole page's worth of rows within the same window, and this
// app's mail FPM pool is only 4 workers wide (see HoverPrefetchMixin.js).
// Reuses SyncService::isServerBusy()'s own threshold (2 concurrent real
// syncs) rather than inventing a new number. Skipped, not queued, past
// capacity -- same "try again next opportunity" philosophy as
// syncWatchedMailboxes()'s own guards; a row that's actually opened still
// fetches for real via the normal navigation path regardless of whether
// its prefetch got a slot.
const MAX_CONCURRENT_VIEWPORT_PREFETCHES = 2
let inFlightCount = 0

/**
 * @param {() => Promise<void>} fn called (and awaited) only if under the
 * concurrency cap
 */
export async function runIfViewportPrefetchSlotAvailable(fn) {
	if (inFlightCount >= MAX_CONCURRENT_VIEWPORT_PREFETCHES) {
		return
	}
	inFlightCount++
	try {
		await fn()
	} finally {
		inFlightCount--
	}
}
