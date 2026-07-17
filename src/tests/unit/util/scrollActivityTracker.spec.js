/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

describe('scrollActivityTracker', () => {
	let module

	beforeEach(async () => {
		vi.resetModules()
		vi.useFakeTimers()
		module = await import('../../../util/scrollActivityTracker.js')
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('reports no recent scroll activity before any scroll event has ever fired', () => {
		expect(module.isScrollingRecently()).toBe(false)
	})

	it('reports recent scroll activity immediately after a scroll event', () => {
		window.dispatchEvent(new Event('scroll'))

		expect(module.isScrollingRecently()).toBe(true)
	})

	it('stops reporting recent activity once the idle window elapses', () => {
		window.dispatchEvent(new Event('scroll'))
		vi.advanceTimersByTime(150)

		expect(module.isScrollingRecently()).toBe(false)
	})

	it('catches a scroll event fired on a nested, non-bubbling element via the capture phase', () => {
		// Real `scroll` events don't bubble -- this only works at all if
		// the listener is attached with `capture: true`.
		const nested = document.createElement('div')
		document.body.appendChild(nested)

		nested.dispatchEvent(new Event('scroll', { bubbles: false }))

		expect(module.isScrollingRecently()).toBe(true)
		document.body.removeChild(nested)
	})

	it('attaches its window listener eagerly, at import time, as a capture-phase passive listener', async () => {
		vi.resetModules()
		const addEventListenerSpy = vi.spyOn(window, 'addEventListener')

		await import('../../../util/scrollActivityTracker.js')

		const scrollCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === 'scroll')
		expect(scrollCalls).toHaveLength(1)
		expect(scrollCalls[0]).toEqual(['scroll', expect.any(Function), { capture: true, passive: true }])
	})
})
