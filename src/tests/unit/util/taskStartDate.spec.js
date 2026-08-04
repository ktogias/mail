/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
	parseStartOffset,
	START_NONE,
	START_OFFSET_OPTIONS,
	startDateFor,
	startOffsetChoices,
} from '../../../util/taskStartDate.js'

describe('taskStartDate', () => {
	describe('reading a stored value', () => {
		it('accepts every offset it offers', () => {
			for (const days of START_OFFSET_OPTIONS) {
				expect(parseStartOffset(String(days))).toBe(days)
			}
		})

		it('treats anything unrecognised as no start date', () => {
			// Validated on READ: PreferencesController::update() stores whatever
			// it is handed, so this is the only thing between a hand-edited
			// value and a date calculation.
			for (const value of [null, undefined, '', 'none', 'soon', '2', '-1', '1.5', NaN]) {
				expect(parseStartOffset(value)).toBeNull()
			}
		})

		it('rejects a negative offset, which would date the task in the past', () => {
			// A start date before today makes the task current immediately AND
			// look as though it was deferred, which is nonsense. 0 is the way
			// to say "current now".
			expect(parseStartOffset('-3')).toBeNull()
			expect(parseStartOffset('0')).toBe(0)
		})
	})

	it('offers "no start date" first, which is the default', () => {
		// The Tasks app dates a task only when the collection it was created in
		// implies one; a message implies nothing, so nothing is set unless the
		// user asks. Off by default is the behaviour to preserve.
		const choices = startOffsetChoices()

		expect(choices[0].value).toBe(START_NONE)
		expect(choices).toHaveLength(START_OFFSET_OPTIONS.length + 1)
	})

	describe('resolving an offset to a date', () => {
		it('sets nothing when no offset is stored', () => {
			expect(startDateFor(null, true)).toBeNull()
		})

		it('truncates to the day for an all-day task', () => {
			// Otherwise an all-day task carries a meaningless time of day.
			const date = startDateFor(1, true)

			expect(date.getHours()).toBe(0)
			expect(date.getMinutes()).toBe(0)
			expect(date.getSeconds()).toBe(0)
		})

		it('truncates to the hour for a timed task, keeping the hour', () => {
			// The clock is pinned because the obvious assertion is vacuous:
			// minutes and seconds are zero under BOTH truncations, so a version
			// that always truncated to the day passed this test unchanged.
			// Proven by making exactly that change. What distinguishes them is
			// the HOUR, and asserting it against the real clock would be a
			// 1-in-24 flake at midnight.
			vi.useFakeTimers()
			try {
				vi.setSystemTime(new Date(2026, 6, 31, 14, 37, 12))

				expect(startDateFor(0, false).getHours()).toBe(14)
				expect(startDateFor(0, false).getMinutes()).toBe(0)
				expect(startDateFor(0, false).getSeconds()).toBe(0)
				// The same moment, day-truncated, is a different answer.
				expect(startDateFor(0, true).getHours()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		})

		it('counts whole days forward from today', () => {
			const today = startDateFor(0, true)
			const inThree = startDateFor(3, true)

			expect(Math.round((inThree - today) / 86400000)).toBe(3)
		})
	})
})
