/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { translatePlural as n, translate as t } from '@nextcloud/l10n'
import moment from '@nextcloud/moment'

/**
 * A default START date for a task created from a message.
 *
 * A start date, deliberately, and not a due date.
 *
 * A task made from an email needs to resurface somewhere or it is filed and
 * forgotten -- and inside Nextcloud the due date is the only thing that
 * surfaces anything, since a VALARM in a VTODO notifies nothing (see
 * util/taskReminder.js). The obvious fix is to give every such task a due
 * date, and it is the wrong one: an invented deadline makes everything overdue,
 * the overdue marker stops meaning anything, and the user learns to ignore it.
 *
 * The Tasks app already offers the way out. Its "Current" collection is what a
 * task enters by having STARTED -- creating a task there sets `start` to now,
 * not `due` -- so a start date buys the visibility without claiming a deadline
 * that does not exist. It is the defer-versus-due distinction OmniFocus makes,
 * and the honest half of it is the one we need.
 *
 * Which is also why the Tasks app itself has no "default due date" setting: it
 * dates a task only when the collection it was created in implies one
 * (`getAdditionalTaskProperties`). A message implies neither, so nothing is set
 * unless the user asks for it -- the default here is "none".
 */

/** Stored when no start date should be set. Spelled as in taskReminder.js. */
export const START_NONE = 'none'

/**
 * Offsets in whole days from today.
 *
 * Days, not the seconds the reminder offsets use: a defer date is a day-grained
 * idea, and the two settings answer different questions. 0 means the task is
 * current immediately, which is the common case for something that arrived by
 * email; the larger offsets are for deliberately putting it out of sight.
 */
export const START_OFFSET_OPTIONS = Object.freeze([0, 1, 3, 7])

/**
 * Read a stored preference into an offset in days.
 *
 * Validated on READ. Nothing on the server constrains a preference value --
 * PreferencesController::update() stores whatever it is handed -- so a value
 * that is not one of the offered offsets has to become "no start date" rather
 * than reach a date calculation.
 *
 * @param {string|number|null|undefined} value the stored preference
 * @return {number|null} whole days from today, or null for no start date
 */
export function parseStartOffset(value) {
	if (value === null || value === undefined || value === START_NONE || value === '') {
		return null
	}

	const days = Number(value)
	if (!Number.isInteger(days)) {
		return null
	}

	return START_OFFSET_OPTIONS.includes(days) ? days : null
}

/**
 * How to describe an offset.
 *
 * @param {number} days whole days from today
 * @return {string} a translated label
 */
export function startOffsetLabel(days) {
	if (days === 0) {
		return t('mail', 'Today')
	}
	if (days === 1) {
		return t('mail', 'Tomorrow')
	}
	return n('mail', 'In %n day', 'In %n days', days)
}

/**
 * The choices a picker should show, "none" first.
 *
 * @return {Array<{value: string, label: string}>} pickable choices
 */
export function startOffsetChoices() {
	return [
		{ value: START_NONE, label: t('mail', 'No start date') },
		...START_OFFSET_OPTIONS.map((days) => ({
			value: String(days),
			label: startOffsetLabel(days),
		})),
	]
}

/**
 * The actual date an offset resolves to.
 *
 * Truncated the way the Tasks app truncates the start date it proposes for a
 * task that has none: to the day when the task is all-day, to the hour
 * otherwise (`u.startOf(this.allDay ? "day" : "hour")`). Without that an
 * all-day task carries a meaningless time, and a timed one carries a start
 * that drifts by seconds depending on when the modal happened to open.
 *
 * @param {number|null} days whole days from today, or null
 * @param {boolean} allDay whether the task has no time of day
 * @return {Date|null} the start date, or null when none should be set
 */
export function startDateFor(days, allDay) {
	if (days === null) {
		return null
	}

	return moment()
		.add(days, 'days')
		.startOf(allDay ? 'day' : 'hour')
		.toDate()
}
