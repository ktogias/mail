/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { findMessageElement, REVEALED_CLASS, revealMessage } from '../../../util/revealMessage.js'

/**
 * Taking someone to one message inside a long thread.
 *
 * The established shape -- Slack, GitHub, Discourse all do it -- is three
 * things, not one: scroll, mark, and move focus. Each of the tests below holds
 * one of them, because each is separately easy to drop and none of them fails
 * loudly when it goes.
 */
describe('revealMessage', () => {
	let element

	beforeEach(() => {
		vi.useFakeTimers()
		document.body.innerHTML = '<div data-thread-id="42" id="target"></div>'
		element = document.querySelector('#target')
		element.scrollIntoView = vi.fn()
		element.focus = vi.fn()
		window.matchMedia = vi.fn().mockReturnValue({ matches: false })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('scrolls the message into view', () => {
		revealMessage(element)

		expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
	})

	it('marks it, then stops marking it', () => {
		// The part that carries the meaning. After the jump there are several
		// messages on screen and they look alike; the scroll alone does not say
		// which one was meant. It fades so it cannot be mistaken for selection.
		revealMessage(element)
		expect(element.classList.contains(REVEALED_CLASS)).toBe(true)

		vi.advanceTimersByTime(2000)

		expect(element.classList.contains(REVEALED_CLASS)).toBe(false)
	})

	it('moves focus, not just the viewport', () => {
		// Without this the feature does not exist for anyone using a keyboard
		// or a screen reader: a scroll is not something they perceive.
		revealMessage(element)

		expect(element.getAttribute('tabindex')).toBe('-1')
		expect(element.focus).toHaveBeenCalledWith({ preventScroll: true })
	})

	it('does not fight its own scroll when focusing', () => {
		// focus() scrolls by default, which would cancel the smooth scroll
		// above by jumping straight there.
		revealMessage(element)

		expect(element.focus).toHaveBeenCalledWith(expect.objectContaining({ preventScroll: true }))
	})

	it('jumps instead of gliding when the user asked for less motion', () => {
		// A long smooth scroll is a documented vestibular trigger. Landing
		// there instantly is a perfectly good outcome -- the marker is what
		// says where, not the animation.
		window.matchMedia = vi.fn().mockReturnValue({ matches: true })

		revealMessage(element)

		expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
	})

	it('leaves an existing tabindex alone', () => {
		element.setAttribute('tabindex', '0')

		revealMessage(element)

		expect(element.getAttribute('tabindex')).toBe('0')
	})

	it('says so rather than throwing when there is nothing to reveal', () => {
		// The message may have been moved out of the thread since the task was
		// made. Callers decide what to do; they must not have to guard a crash.
		expect(revealMessage(null)).toBe(false)
		expect(revealMessage(undefined)).toBe(false)
	})

	it('finds a message by its database id', () => {
		expect(findMessageElement(42)).toBe(element)
		expect(findMessageElement(999)).toBeNull()
	})
})
