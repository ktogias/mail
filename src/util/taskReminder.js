/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { translatePlural as n, translate as t } from '@nextcloud/l10n'

/**
 * Reminders on a task created from a message.
 *
 * One owner for the whole notion: the offered values, what they mean, whether
 * a stored value is usable, and what to call it. The modal and the settings
 * panel both read from here, so the two can never drift into offering
 * different sets or labelling the same number differently.
 *
 * WHAT THESE ACTUALLY DO. A VALARM inside a VTODO produces no notification
 * anywhere in Nextcloud: the dav app's ReminderService skips every component
 * that is not a VEVENT (`if ($child->name !== 'VEVENT') { continue; }`), and
 * the Tasks app has no notifier of its own. Confirmed against the live data
 * too -- every row in oc_calendar_reminders is a VEVENT.
 *
 * They fire in CalDAV clients that read task alarms: Thunderbird, DAVx5 with
 * Tasks.org, Apple Reminders. That is the honest scope of this feature, and it
 * is worth having because those are where a phone actually buzzes. Inside
 * Nextcloud the working mechanism remains the due date, which the Tasks app
 * surfaces in "Today"/"Current" and its dashboard widget.
 */

/** Stored when the user wants no reminder. Calendar spells it this way too. */
export const REMINDER_NONE = 'none'

/**
 * Offsets in seconds, negative meaning "before".
 *
 * Copied from the Calendar app rather than invented, so a person who has set a
 * default there meets the same list here. Calendar builds them in one function
 * keyed on all-day (`function ia(e=!1){return e?[...]:[...]}`) and these are
 * its two arrays verbatim.
 */
export const TIMED_REMINDER_OPTIONS = Object.freeze([
	0,
	-300,
	-600,
	-900,
	-1800,
	-2700,
	-3600,
	-7200,
	-10800,
	-86400,
	-172800,
])

/**
 * All-day offsets, which are POSITIVE or large-negative by design.
 *
 * An all-day task is due at midnight, so "15 minutes before" would mean 23:45
 * the previous night -- technically a reminder, practically useless. Calendar
 * solves this by offering offsets that land at 09:00: +9h is the morning of
 * the due date, -15h the morning before, and so on. Same reason its validator
 * only permits positive values for the full-day setting.
 */
export const ALL_DAY_REMINDER_OPTIONS = Object.freeze([
	32400,
	-54000,
	-140400,
	-226800,
	-572400,
])

/** The hour the all-day offsets are built around; used only for labelling. */
const ALL_DAY_HOUR = 9

/**
 * The offsets offered for one kind of task.
 *
 * @param {boolean} allDay whether the task has no time of day
 * @return {readonly number[]} offsets in seconds
 */
export function reminderOptions(allDay) {
	return allDay ? ALL_DAY_REMINDER_OPTIONS : TIMED_REMINDER_OPTIONS
}

/**
 * Read a stored preference into an offset.
 *
 * Validated on READ, not merely on write. Nothing on the server constrains a
 * preference value -- PreferencesController::update() stores whatever it is
 * given -- so the only place this can be made safe is where it is used. A
 * value that is not an integer, or that does not belong to the set offered for
 * this kind of task, is treated as "no reminder" rather than written into an
 * iCalendar object.
 *
 * @param {string|number|null|undefined} value the stored preference
 * @param {boolean} allDay which option set applies
 * @return {number|null} the offset in seconds, or null for no reminder
 */
export function parseReminder(value, allDay) {
	if (value === null || value === undefined || value === REMINDER_NONE || value === '') {
		return null
	}

	const seconds = Number(value)
	if (!Number.isInteger(seconds)) {
		return null
	}

	return reminderOptions(allDay).includes(seconds) ? seconds : null
}

/**
 * How to describe an offset.
 *
 * @param {number} seconds the offset, negative meaning before
 * @param {boolean} allDay which option set it belongs to
 * @return {string} a translated label
 */
export function reminderLabel(seconds, allDay) {
	if (allDay) {
		// Every all-day offset lands at the same hour; only the day differs.
		// Expressed as whole days so the arithmetic stays out of the label.
		const days = Math.round((ALL_DAY_HOUR * 3600 - seconds) / 86400)
		const time = `${String(ALL_DAY_HOUR).padStart(2, '0')}:00`
		if (days === 0) {
			return t('mail', 'On the due date at {time}', { time })
		}
		return n('mail', '%n day before at {time}', '%n days before at {time}', days, { time })
	}

	if (seconds === 0) {
		return t('mail', 'When the task is due')
	}

	const before = Math.abs(seconds)
	if (before % 86400 === 0) {
		return n('mail', '%n day before', '%n days before', before / 86400)
	}
	if (before % 3600 === 0) {
		return n('mail', '%n hour before', '%n hours before', before / 3600)
	}
	return n('mail', '%n minute before', '%n minutes before', before / 60)
}

/**
 * The choices a picker should show, "None" first.
 *
 * @param {boolean} allDay which option set applies
 * @return {Array<{value: string, label: string}>} pickable choices
 */
export function reminderChoices(allDay) {
	return [
		{ value: REMINDER_NONE, label: t('mail', 'No reminder') },
		...reminderOptions(allDay).map((seconds) => ({
			value: String(seconds),
			label: reminderLabel(seconds, allDay),
		})),
	]
}

/**
 * What a relative trigger on this task should be anchored to.
 *
 * RFC 5545 defines RELATED=END on a VTODO as its DUE time, which is the anchor
 * a task reminder actually means -- "remind me before this is due". DTSTART is
 * the fallback, because an END-related trigger on a task with no DUE is not
 * merely unhelpful, it is invalid: there is no end for it to be relative to.
 * With neither date there is nothing to anchor to at all, and writing the
 * alarm anyway would produce an object some clients reject.
 *
 * @param {object} dates the task's dates
 * @param {Date|string|null} [dates.due] the due date, if the user picked one
 * @param {Date|string|null} [dates.start] the start date, if the user picked one
 * @return {string|null} 'END', 'START', or null when no reminder is possible
 */
export function reminderRelatedTo({ due, start }) {
	if (due) {
		return 'END'
	}
	if (start) {
		return 'START'
	}
	return null
}
