/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** How long the target stays marked after we jump to it. */
const HIGHLIGHT_MS = 2000

/** Set while the highlight is showing; the styling lives in Thread.vue. */
export const REVEALED_CLASS = 'mail-message--revealed'

/**
 * Whether the user has asked for less movement.
 *
 * A long smooth scroll is a documented vestibular trigger, and jumping
 * straight there is a perfectly good outcome -- the highlight is what tells
 * them where they landed, not the animation.
 *
 * @return {boolean} true when motion should be avoided
 */
function prefersReducedMotion() {
	return typeof window !== 'undefined'
		&& typeof window.matchMedia === 'function'
		&& window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Take the user to one message inside a thread.
 *
 * Scrolling alone is not enough and this is the part that gets left out. After
 * the jump there are several messages on screen, all looking much alike, and
 * nothing says which one was meant. Slack and GitHub both flash the target for
 * a moment; that flash is what carries the meaning, and it fades so it does
 * not compete with real selection state.
 *
 * Focus moves too, not just the viewport. A scroll is invisible to someone
 * using a keyboard or a screen reader, so without this the feature simply does
 * not exist for them.
 *
 * @param {HTMLElement|null|undefined} element the message's root element
 * @param {object} [options] overrides
 * @param {number} [options.highlightMs] how long to keep the marker
 * @return {boolean} whether there was anything to reveal
 */
export function revealMessage(element, { highlightMs = HIGHLIGHT_MS } = {}) {
	if (!element) {
		return false
	}

	element.scrollIntoView({
		behavior: prefersReducedMotion() ? 'auto' : 'smooth',
		block: 'start',
	})

	// -1 rather than 0: reachable programmatically, but not inserted into the
	// tab order, where it would be an unexplained extra stop for everyone else.
	if (!element.hasAttribute('tabindex')) {
		element.setAttribute('tabindex', '-1')
	}
	// preventScroll, or the browser undoes the smooth scroll above by jumping
	// straight to the element.
	element.focus({ preventScroll: true })

	element.classList.add(REVEALED_CLASS)
	window.setTimeout(() => element.classList.remove(REVEALED_CLASS), highlightMs)

	return true
}

/**
 * Find a message's element by its database id.
 *
 * @param {number|string} databaseId the envelope's databaseId
 * @return {HTMLElement|null} the element, if it is rendered
 */
export function findMessageElement(databaseId) {
	if (typeof document === 'undefined') {
		return null
	}
	return document.querySelector(`[data-thread-id="${databaseId}"]`)
}
