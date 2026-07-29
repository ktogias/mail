/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
})
