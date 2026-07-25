/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { enablePullToRefresh, PULL_REFRESH_THRESHOLD_PX } from '../../../util/pullToRefresh.js'

function touchEvent(type, y) {
	const event = new Event(type, { bubbles: true })
	event.touches = [{ clientY: y }]
	return event
}

describe('enablePullToRefresh', () => {
	it('is a no-op (and returns a safe teardown) when there is no container or indicator', () => {
		expect(() => enablePullToRefresh(null, null, { canStart: () => true, onRefresh: vi.fn() })()).not.toThrow()
	})

	it('calls onRefresh after a drag past the threshold is released', async () => {
		const container = document.createElement('div')
		const indicator = document.createElement('div')
		const onRefresh = vi.fn().mockResolvedValue()
		enablePullToRefresh(container, indicator, { canStart: () => true, onRefresh })

		container.dispatchEvent(touchEvent('touchstart', 100))
		container.dispatchEvent(touchEvent('touchmove', 100 + PULL_REFRESH_THRESHOLD_PX))
		container.dispatchEvent(touchEvent('touchend', 100 + PULL_REFRESH_THRESHOLD_PX))

		expect(onRefresh).toHaveBeenCalledTimes(1)
		await Promise.resolve()
		expect(indicator.style.transform).toBe('')
	})

	it('uses real finger travel for the threshold, not the resistance-scaled visual distance', () => {
		const container = document.createElement('div')
		const indicator = document.createElement('div')
		const onRefresh = vi.fn()
		enablePullToRefresh(container, indicator, { canStart: () => true, onRefresh })

		container.dispatchEvent(touchEvent('touchstart', 100))
		container.dispatchEvent(touchEvent('touchmove', 100 + PULL_REFRESH_THRESHOLD_PX - 1))
		container.dispatchEvent(touchEvent('touchend', 100 + PULL_REFRESH_THRESHOLD_PX - 1))
		expect(onRefresh).not.toHaveBeenCalled()

		container.dispatchEvent(touchEvent('touchstart', 100))
		container.dispatchEvent(touchEvent('touchmove', 100 + PULL_REFRESH_THRESHOLD_PX))
		container.dispatchEvent(touchEvent('touchend', 100 + PULL_REFRESH_THRESHOLD_PX))
		expect(onRefresh).toHaveBeenCalledTimes(1)
	})

	it('does not call onRefresh for a drag under the threshold (snaps back)', () => {
		const container = document.createElement('div')
		const indicator = document.createElement('div')
		const onRefresh = vi.fn()
		enablePullToRefresh(container, indicator, { canStart: () => true, onRefresh })

		container.dispatchEvent(touchEvent('touchstart', 100))
		container.dispatchEvent(touchEvent('touchmove', 110)) // dy=10, well under threshold
		container.dispatchEvent(touchEvent('touchend', 110))

		expect(onRefresh).not.toHaveBeenCalled()
		expect(indicator.style.transform).toBe('')
	})

	it('ignores an upward drag (not a pull-down gesture)', () => {
		const container = document.createElement('div')
		const indicator = document.createElement('div')
		const onRefresh = vi.fn()
		enablePullToRefresh(container, indicator, { canStart: () => true, onRefresh })

		container.dispatchEvent(touchEvent('touchstart', 100))
		container.dispatchEvent(touchEvent('touchmove', 50)) // moved up
		container.dispatchEvent(touchEvent('touchend', 50))

		expect(onRefresh).not.toHaveBeenCalled()
	})

	it('never starts the gesture at all when canStart() returns false', () => {
		const container = document.createElement('div')
		const indicator = document.createElement('div')
		const onRefresh = vi.fn()
		enablePullToRefresh(container, indicator, { canStart: () => false, onRefresh })

		container.dispatchEvent(touchEvent('touchstart', 100))
		container.dispatchEvent(touchEvent('touchmove', 100 + PULL_REFRESH_THRESHOLD_PX * 2))
		container.dispatchEvent(touchEvent('touchend', 100 + PULL_REFRESH_THRESHOLD_PX * 2))

		expect(onRefresh).not.toHaveBeenCalled()
	})

	it('stops responding after teardown', () => {
		const container = document.createElement('div')
		const indicator = document.createElement('div')
		const onRefresh = vi.fn()
		const teardown = enablePullToRefresh(container, indicator, { canStart: () => true, onRefresh })
		teardown()

		container.dispatchEvent(touchEvent('touchstart', 100))
		container.dispatchEvent(touchEvent('touchmove', 100 + PULL_REFRESH_THRESHOLD_PX * 2))
		container.dispatchEvent(touchEvent('touchend', 100 + PULL_REFRESH_THRESHOLD_PX * 2))

		expect(onRefresh).not.toHaveBeenCalled()
	})
})
