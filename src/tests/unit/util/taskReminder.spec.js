/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
	ALL_DAY_REMINDER_OPTIONS,
	parseReminder,
	REMINDER_NONE,
	reminderChoices,
	reminderLabel,
	reminderRelatedTo,
	TIMED_REMINDER_OPTIONS,
} from '../../../util/taskReminder.js'

describe('taskReminder', () => {
	describe('reading a stored value', () => {
		it('refuses an offset belonging to the other kind of task', () => {
			// The two sets are disjoint by design: an all-day task is due at
			// midnight, so -900 ("15 minutes before") would put the alarm at
			// 23:45 the previous night. Accepting a timed offset for an all-day
			// task is the exact bug this rejection exists to prevent, and it is
			// reachable simply by toggling "All day" after choosing.
			expect(parseReminder('-900', false)).toBe(-900)
			expect(parseReminder('-900', true)).toBeNull()

			expect(parseReminder('32400', true)).toBe(32400)
			expect(parseReminder('32400', false)).toBeNull()
		})

		it('treats anything unrecognised as no reminder', () => {
			// Nothing on the server constrains a preference value --
			// PreferencesController::update() stores what it is handed -- so
			// the value has to be validated where it is USED, not only where it
			// is written. Otherwise a hand-edited preference ends up inside an
			// iCalendar object.
			for (const value of [null, undefined, '', 'none', 'soon', '-901', '1.5', NaN]) {
				expect(parseReminder(value, false)).toBeNull()
			}
		})

		it('accepts every offset it offers', () => {
			// Guards against the sets and the validator drifting apart, which
			// would leave a picker showing choices that silently become "none".
			for (const seconds of TIMED_REMINDER_OPTIONS) {
				expect(parseReminder(String(seconds), false)).toBe(seconds)
			}
			for (const seconds of ALL_DAY_REMINDER_OPTIONS) {
				expect(parseReminder(String(seconds), true)).toBe(seconds)
			}
		})
	})

	describe('labelling', () => {
		it('describes all-day offsets as whole days at a fixed hour', () => {
			// The all-day numbers look arbitrary (-54000, -140400) because they
			// are midnight-anchored offsets that land at 09:00. If the label
			// arithmetic is wrong the user picks the wrong day, so the mapping
			// is pinned rather than assumed.
			expect(reminderLabel(32400, true)).toContain('09:00')
			expect(reminderLabel(32400, true)).toMatch(/due date/)
			expect(reminderLabel(-54000, true)).toContain('1')
			expect(reminderLabel(-140400, true)).toContain('2')
			expect(reminderLabel(-226800, true)).toContain('3')
			expect(reminderLabel(-572400, true)).toContain('7')
		})

		it('picks the largest whole unit for timed offsets', () => {
			expect(reminderLabel(0, false)).toMatch(/due/)
			expect(reminderLabel(-300, false)).toContain('5')
			expect(reminderLabel(-3600, false)).toContain('1')
			expect(reminderLabel(-86400, false)).toContain('1')
			// 45 minutes is not a whole hour and must not be rounded into one.
			expect(reminderLabel(-2700, false)).toContain('45')
		})
	})

	it('offers "no reminder" first, so the default needs no scrolling', () => {
		const choices = reminderChoices(false)

		expect(choices[0].value).toBe(REMINDER_NONE)
		expect(choices).toHaveLength(TIMED_REMINDER_OPTIONS.length + 1)
		expect(reminderChoices(true)).toHaveLength(ALL_DAY_REMINDER_OPTIONS.length + 1)
	})

	describe('what the trigger is anchored to', () => {
		it('prefers the due date, which is what a task reminder means', () => {
			// RFC 5545: RELATED=END on a VTODO refers to its DUE time. "Remind
			// me before this is due" is the whole point, so DUE wins whenever
			// both dates exist.
			expect(reminderRelatedTo({ due: '2026-07-31', start: '2026-07-01' })).toBe('END')
		})

		it('falls back to the start date, because END without DUE is invalid', () => {
			expect(reminderRelatedTo({ start: '2026-07-01' })).toBe('START')
		})

		it('refuses to anchor when there is no date at all', () => {
			// Not a stylistic choice: a relative trigger with no referent
			// produces an object some clients reject outright.
			expect(reminderRelatedTo({})).toBeNull()
			expect(reminderRelatedTo({ due: null, start: null })).toBeNull()
		})
	})
})
