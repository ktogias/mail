/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { enableSwipeToDismiss } from '../../../util/swipeToDismiss.js'

function touchEvent(type, x, y) {
	const event = new Event(type, { bubbles: true })
	event.touches = [{ clientX: x, clientY: y }]
	return event
}

describe('enableSwipeToDismiss', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('is a no-op (and returns a safe teardown) when there is no element', () => {
		const teardown = enableSwipeToDismiss(null, vi.fn())

		expect(() => teardown()).not.toThrow()
	})

	it('dismisses after a horizontal swipe past the threshold', () => {
		const element = document.createElement('div')
		const onDismiss = vi.fn()
		enableSwipeToDismiss(element, onDismiss)

		element.dispatchEvent(touchEvent('touchstart', 100, 100))
		element.dispatchEvent(touchEvent('touchmove', 250, 105)) // dx=150 (> 80), mostly horizontal
		element.dispatchEvent(touchEvent('touchend', 250, 105))

		// Fling-out animation runs first, then the dismiss fires
		expect(onDismiss).not.toHaveBeenCalled()
		vi.advanceTimersByTime(200)
		expect(onDismiss).toHaveBeenCalledTimes(1)
		expect(element.style.opacity).toBe('0')
	})

	it('snaps back without dismissing for a short drag', () => {
		const element = document.createElement('div')
		const onDismiss = vi.fn()
		enableSwipeToDismiss(element, onDismiss)

		element.dispatchEvent(touchEvent('touchstart', 100, 100))
		element.dispatchEvent(touchEvent('touchmove', 130, 100)) // dx=30 (< 80)
		element.dispatchEvent(touchEvent('touchend', 130, 100))

		vi.advanceTimersByTime(300)
		expect(onDismiss).not.toHaveBeenCalled()
		expect(element.style.transform).toBe('')
	})

	it('ignores mostly-vertical gestures so the page can scroll', () => {
		const element = document.createElement('div')
		const onDismiss = vi.fn()
		enableSwipeToDismiss(element, onDismiss)

		element.dispatchEvent(touchEvent('touchstart', 100, 100))
		element.dispatchEvent(touchEvent('touchmove', 120, 300)) // dy=200 > dx=20
		element.dispatchEvent(touchEvent('touchend', 120, 300))

		vi.advanceTimersByTime(300)
		expect(onDismiss).not.toHaveBeenCalled()
	})

	it('stops responding after teardown', () => {
		const element = document.createElement('div')
		const onDismiss = vi.fn()
		const teardown = enableSwipeToDismiss(element, onDismiss)
		teardown()

		element.dispatchEvent(touchEvent('touchstart', 100, 100))
		element.dispatchEvent(touchEvent('touchmove', 250, 100))
		element.dispatchEvent(touchEvent('touchend', 250, 100))

		vi.advanceTimersByTime(300)
		expect(onDismiss).not.toHaveBeenCalled()
	})
})
