/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Matches `transition: … calc(var(--animation-slow) / 2)` on the list's
// enter/leave classes. Only used when the theme variable cannot be read.
export const FALLBACK_LIST_TRANSITION_MS = 150

let cached

/**
 * How long the envelope list's enter/leave animation lasts, in milliseconds.
 *
 * This exists to be HANDED to Vue rather than discovered by it. Given no
 * `duration`, Vue sniffs it off the element:
 *
 *   if (isValidDuration(explicitEnterDuration)) { setTimeout(cb, explicitEnterDuration) }
 *   else { whenTransitionEnds(el, type, cb) }
 *
 * and `whenTransitionEnds` -> `getTransitionInfo` reads a computed style,
 * which forces a synchronous style flush. Once per transitioning element, from
 * inside a requestAnimationFrame callback. Measured live on 2026-07-28:
 * **12.0 of 14.1 seconds** of style flushing in a 43s profile, with the tab's
 * main thread pegged at ~100% for twelve seconds straight. Passing a number
 * takes the whole branch out; the CSS animation is untouched and looks
 * identical.
 *
 * The value still comes from the theme, so `--animation-slow` stays
 * authoritative and the two cannot drift apart -- but it is read ONCE for the
 * lifetime of the page instead of per element per frame. Cheap enough to be
 * the honest answer rather than a hardcoded 150.
 *
 * @return {number} duration in milliseconds
 */
export function listTransitionDurationMs() {
	if (cached !== undefined) {
		return cached
	}

	cached = FALLBACK_LIST_TRANSITION_MS
	try {
		const raw = getComputedStyle(document.documentElement)
			.getPropertyValue('--animation-slow')
			.trim()
		const value = Number.parseFloat(raw)
		if (Number.isFinite(value) && value > 0) {
			// A CSS <time> is either seconds or milliseconds; `s` has to be
			// tested after `ms` or every millisecond value matches it.
			cached = (raw.endsWith('ms') ? value : raw.endsWith('s') ? value * 1000 : value) / 2
		}
	} catch (error) {
		// Non-DOM environments, or a theme that does not define it: the
		// fallback already matches what the stylesheet resolves to.
	}

	return cached
}

/**
 * Drop the memoised value. Tests only -- the variable does not change at
 * runtime, which is the whole reason reading it once is safe.
 */
export function resetListTransitionDurationCache() {
	cached = undefined
}
