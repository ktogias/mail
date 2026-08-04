/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import ICAL from 'ical.js'
import TaskModal from '../../../components/TaskModal.vue'

/**
 * Creating a task, at the one point where it has to remember something.
 *
 * createTask() is called directly rather than through a mounted modal: the
 * property under test is what it does with the CalDAV response, and mounting
 * would need calendars, a store and a picker to reach the same line.
 */
describe('TaskModal.createTask', () => {
	const calendarWith = (createdUrl) => ({
		id: 'isi-comb',
		dav: { createVObject: vi.fn().mockResolvedValue({ url: createdUrl }) },
	})

	const context = { mainStore: { getAppVersion: '5.11.0' } }

	it('keeps the name CalDAV gave the new object', async () => {
		// The whole bug in one line. The response was awaited and thrown away,
		// so task.uri stayed empty and the link was built from the VTODO's UID
		// instead -- a different string, because cdav-library names the object
		// itself. Every link we stored pointed at a task that does not exist.
		const calendar = calendarWith('/remote.php/dav/calendars/kt/isi-comb/85D8FD67-52AA-4789-8E49-740B9B6B6BC2.ics')

		const task = await TaskModal.methods.createTask.call(context, {
			summary: 'Έντυπα πληρωμών',
			calendar,
		})

		expect(task.uri).toBe('85D8FD67-52AA-4789-8E49-740B9B6B6BC2.ics')
		// And the UID really is something else, which is why the two cannot be
		// used interchangeably.
		expect(task.uid).not.toBe('85D8FD67-52AA-4789-8E49-740B9B6B6BC2')
	})

	it('writes the message link into the VTODO as its URL property', async () => {
		// RFC 5545's URL is the standard place for "where this came from", and
		// the Tasks app treats it as a first-class field -- it reads it into
		// customUrl and writes it back on save, so an edit there does not drop
		// the value.
		const calendar = calendarWith('/remote.php/dav/calendars/kt/isi-comb/X.ics')

		const task = await TaskModal.methods.createTask.call(context, {
			summary: 'x',
			calendar,
			messageLink: 'https://home.example/cloud/apps/mail/message?messageId=%3Ca%40b%3E',
		})

		expect(task.vtodo.getFirstPropertyValue('url'))
			.toBe('https://home.example/cloud/apps/mail/message?messageId=%3Ca%40b%3E')
	})
	describe('reminders', () => {
		const calendar = () => calendarWith('/remote.php/dav/calendars/kt/isi-comb/X.ics')

		/**
		 * The VALARM the created task carries, if any.
		 *
		 * @param {object} task the created task
		 * @return {object|null} the alarm component
		 */
		const alarmOf = (task) => task.vtodo.getFirstSubcomponent('valarm')

		it('anchors the trigger to the due date', async () => {
			// RELATED=END on a VTODO is its DUE time (RFC 5545), which is what
			// "remind me before this is due" actually asks for.
			const task = await TaskModal.methods.createTask.call(context, {
				summary: 'Pay the invoice',
				calendar: calendar(),
				due: '2026-07-31T00:00:00Z',
				start: '2026-07-01T00:00:00Z',
				reminder: -3600,
			})

			const trigger = alarmOf(task).getFirstProperty('trigger')
			expect(trigger.getParameter('related')).toBe('END')
			expect(trigger.getFirstValue().toSeconds()).toBe(-3600)
			// What actually reaches the client. ical.js is free to normalise
			// the in-memory shape; the wire format is the contract.
			expect(ICAL.stringify(task.jCal)).toContain('TRIGGER;RELATED=END:-PT1H')
		})

		it('falls back to the start date when nothing is due', async () => {
			// An END-related trigger on a task with no DUE has no referent and
			// is invalid, not merely unhelpful.
			const task = await TaskModal.methods.createTask.call(context, {
				summary: 'x',
				calendar: calendar(),
				start: '2026-07-01T00:00:00Z',
				reminder: -900,
			})

			expect(alarmOf(task).getFirstProperty('trigger').getParameter('related')).toBe('START')
		})

		it('writes no alarm at all when there is no date to anchor to', async () => {
			// Both date pickers start empty in this modal, so this is the
			// ordinary case, not an edge one.
			const task = await TaskModal.methods.createTask.call(context, {
				summary: 'x',
				calendar: calendar(),
				reminder: -900,
			})

			expect(alarmOf(task)).toBeNull()
		})

		it('writes no alarm when no reminder was chosen', async () => {
			const task = await TaskModal.methods.createTask.call(context, {
				summary: 'x',
				calendar: calendar(),
				due: '2026-07-31T00:00:00Z',
				reminder: null,
			})

			expect(alarmOf(task)).toBeNull()
		})

		it('gives the alarm the description a DISPLAY action requires', async () => {
			// An alarm without one is invalid, and clients that honour task
			// alarms are this feature's entire audience.
			const task = await TaskModal.methods.createTask.call(context, {
				summary: 'Pay the invoice',
				calendar: calendar(),
				due: '2026-07-31T00:00:00Z',
				reminder: 0,
			})

			const alarm = alarmOf(task)
			expect(alarm.getFirstPropertyValue('action')).toBe('DISPLAY')
			expect(alarm.getFirstPropertyValue('description')).toBe('Pay the invoice')
		})
	})
	describe('the default that comes from settings', () => {
		const withPreferences = (preferences) => ({
			mainStore: {
				getPreference: (key, fallback) => preferences[key] ?? fallback,
			},
		})

		it('reads a different preference for each kind of task', () => {
			const ctx = withPreferences({
				'task-reminder-part-day': '-900',
				'task-reminder-full-day': '32400',
			})

			expect(TaskModal.methods.preferredReminder.call(ctx, false)).toBe('-900')
			expect(TaskModal.methods.preferredReminder.call(ctx, true)).toBe('32400')
		})

		it('ignores a stored value that does not belong to the set', () => {
			// Reachable by hand-editing: no server-side validation exists for
			// preference values. A timed offset on an all-day task would fire
			// at 23:45 the night before.
			const ctx = withPreferences({ 'task-reminder-full-day': '-900' })

			expect(TaskModal.methods.preferredReminder.call(ctx, true)).toBe('none')
		})

		it('re-reads the preference when the all-day toggle flips', () => {
			// The two option sets are disjoint, so a chosen value cannot carry
			// over. Falling back to the OTHER preference is what the user asked
			// for; keeping the old number would be silently wrong.
			const ctx = {
				...withPreferences({
					'task-reminder-part-day': '-900',
					'task-reminder-full-day': '32400',
				}),
				reminder: '-900',
				preferredReminder: TaskModal.methods.preferredReminder,
			}

			TaskModal.watch.isAllDay.call(ctx, true)

			expect(ctx.reminder).toBe('32400')
		})
	})
	describe('the default start date', () => {
		const ctxWith = (preferences) => ({
			mainStore: { getPreference: (key, fallback) => preferences[key] ?? fallback },
			preferredStartDate: TaskModal.methods.preferredStartDate,
			preferredReminder: TaskModal.methods.preferredReminder,
			startDateIsOurs: true,
			seededStartDate: null,
			startDate: null,
			reminder: 'none',
		})

		it('sets nothing unless the user has asked for it', () => {
			// The Tasks app dates a task only when the collection it was created
			// in implies one, and a message implies nothing. Off by default.
			expect(TaskModal.methods.preferredStartDate.call(ctxWith({}), true)).toBeNull()
		})

		it('seeds the picker from the preference', () => {
			const ctx = ctxWith({ 'task-start-date': '1' })

			const date = TaskModal.methods.preferredStartDate.call(ctx, true)

			expect(date).not.toBeNull()
			expect(Math.round((date - new Date()) / 86400000)).toBeGreaterThanOrEqual(0)
			// Remembered, so a later toggle can tell our value from the user's.
			expect(ctx.seededStartDate).toBe(date)
		})

		it('re-derives on the all-day toggle, because truncation differs', () => {
			// Day-truncated for an all-day task, hour-truncated otherwise, so
			// the same offset means a different moment either side of the
			// toggle.
			const ctx = ctxWith({ 'task-start-date': '0' })
			ctx.startDate = TaskModal.methods.preferredStartDate.call(ctx, false)
			const timed = ctx.startDate

			TaskModal.watch.isAllDay.call(ctx, true)

			expect(ctx.startDate).not.toBe(timed)
			expect(ctx.startDate.getHours()).toBe(0)
		})

		it('never overwrites a date the user picked themselves', () => {
			// Re-seeding on every toggle would throw away a deliberate choice.
			const ctx = ctxWith({ 'task-start-date': '0' })
			ctx.startDate = new Date('2026-12-24T00:00:00Z')
			ctx.startDateIsOurs = false

			TaskModal.watch.isAllDay.call(ctx, true)

			expect(ctx.startDate).toEqual(new Date('2026-12-24T00:00:00Z'))
		})

		it('stops treating the date as ours once it changes', () => {
			const ctx = ctxWith({ 'task-start-date': '0' })
			ctx.seededStartDate = new Date('2026-01-01T00:00:00Z')

			TaskModal.watch.startDate.call(ctx, new Date('2026-12-24T00:00:00Z'))

			expect(ctx.startDateIsOurs).toBe(false)
		})
	})
})
