/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	FALLBACK_LIST_TRANSITION_MS,
	listTransitionDurationMs,
	resetListTransitionDurationCache,
} from '../../../util/listTransitionDuration.js'

describe('listTransitionDurationMs', () => {
	beforeEach(() => {
		resetListTransitionDurationCache()
		vi.restoreAllMocks()
	})

	function themeValue(raw) {
		vi.spyOn(window, 'getComputedStyle').mockReturnValue({
			getPropertyValue: () => raw,
		})
	}

	// The CSS says `calc(var(--animation-slow) / 2)`, so the number handed to
	// Vue has to be half of the theme's value or the transition classes come
	// off at the wrong moment.
	it('is half of --animation-slow', () => {
		themeValue('300ms')

		expect(listTransitionDurationMs()).toBe(150)
	})

	it('understands a value given in seconds', () => {
		// `s` has to be tested after `ms`, or every millisecond value matches
		// it and comes out a thousand times too long.
		themeValue('0.4s')

		expect(listTransitionDurationMs()).toBe(200)
	})

	it('treats a bare number as milliseconds', () => {
		themeValue('300')

		expect(listTransitionDurationMs()).toBe(150)
	})

	it('falls back to what the stylesheet resolves to when the variable is missing', () => {
		themeValue('')

		expect(listTransitionDurationMs()).toBe(FALLBACK_LIST_TRANSITION_MS)
	})

	it('falls back rather than handing Vue something it would reject', () => {
		// isValidDuration() only accepts a real number; NaN would make Vue warn
		// and fall straight back to sniffing the computed style.
		themeValue('inherit')

		const duration = listTransitionDurationMs()
		expect(Number.isFinite(duration)).toBe(true)
		expect(duration).toBeGreaterThan(0)
	})

	it('reads the theme once for the lifetime of the page', () => {
		themeValue('300ms')

		listTransitionDurationMs()
		listTransitionDurationMs()
		listTransitionDurationMs()

		// The point of the whole exercise: one computed-style read in total,
		// instead of one per transitioning element per frame.
		expect(window.getComputedStyle).toHaveBeenCalledTimes(1)
	})
})
