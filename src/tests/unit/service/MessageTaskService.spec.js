/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import {
	fetchTasksForMessage,
	linkTaskToMessage,
	messageDeepLink,
	taskDeepLink,
	taskUriOf,
} from '../../../service/MessageTaskService.js'
import { WorkClass } from '../../../service/RequestCoordinator.js'

vi.mock('@nextcloud/axios')

describe('MessageTaskService', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('does not ask for the task index speculatively', () => {
		// The coordinator REJECTS speculative requests outright while there is
		// foreground pressure -- it does not queue them. Opening a thread is
		// foreground pressure by definition (thread fetch, body fetch, list
		// loads), so this request was dropped essentially every time and the
		// chip silently never appeared. Confirmed from the access log: three
		// 200s on /messages/<id>/thread with no /tasks request behind them.
		axios.get.mockResolvedValue({ data: { tasks: [] } })

		fetchTasksForMessage(42)

		const [, options] = axios.get.mock.calls[0]
		expect(options.mailWorkClass).not.toBe(WorkClass.SPECULATIVE)
		expect(options.mailWorkClass).toBe(WorkClass.ACTIVE_CONTENT)
	})

	it('writes the link as a quick mutation', () => {
		axios.post.mockResolvedValue({ data: { task: {} } })

		linkTaskToMessage(42, { calendarUri: 'personal', taskUid: 'uid-1' })

		const [, , options] = axios.post.mock.calls[0]
		expect(options.mailWorkClass).toBe(WorkClass.QUICK_MUTATION)
	})
	describe('the two links', () => {
		it('addresses a task by its CalDAV object name, not its UID', () => {
			// Read off the Tasks app's own router: the route is
			// `/calendars/:calendarId/tasks/:taskId` and every push it makes
			// passes `task.uri` -- the object's `.ics` basename. That is a
			// DIFFERENT string from the VTODO's UID, because cdav-library names
			// a newly created object with an identifier of its own, so a task
			// with UID e179a093-... lives at 85D8FD67-....ics. Linking by UID
			// produced a URL that resolved to nothing.
			const url = taskDeepLink('isi-comb', '85D8FD67-52AA-4789-8E49-740B9B6B6BC2.ics')

			expect(url).toContain('/apps/tasks/calendars/isi-comb/tasks/85D8FD67-52AA-4789-8E49-740B9B6B6BC2.ics')
			// Tasks runs on createWebHistory, so the path is real. A fragment
			// lands on the calendar view with no task selected.
			expect(url).not.toContain('#')
		})

		it('falls back to <uid>.ics for rows written before the name was recorded', () => {
			// Right for anything the Tasks app created itself, wrong for the few
			// this bug produced -- which cannot be recovered without walking the
			// whole calendar. Better a conventional guess than no link at all.
			expect(taskUriOf({ taskUid: 'abc', taskUri: 'real-name.ics' })).toBe('real-name.ics')
			expect(taskUriOf({ taskUid: 'abc' })).toBe('abc.ics')
		})

		it('writes the message link as an absolute URI', () => {
			// A webroot is set on purpose. Without one this assertion is
			// vacuous for the failure that actually shipped in .81:
			// getBaseUrl() is origin + webroot and generateUrl() prefixes the
			// webroot too, so concatenating them gave /cloud/cloud/apps/mail
			// -- invisible when the webroot is the empty string, which is
			// jsdom's default and was the whole reason this passed.
			window._oc_webroot = '/cloud'
			// This value goes into the VTODO's URL property, and an iCalendar
			// URL is defined as a URI -- a bare path is not one. It also leaves
			// the browser: the .ics syncs to phones and desktop clients, where
			// `/apps/mail/...` resolves against nothing.
			const url = messageDeepLink('<a@b.example>')

			expect(url).toMatch(/^https?:\/\//)
			expect(url).toContain('/apps/mail/message?messageId=')
			// The Message-ID travels as a query parameter and stays encoded: it
			// may legally contain a slash, which a path segment would not
			// survive.
			expect(url).toContain('%3Ca%40b.example%3E')
			// The property is that the webroot appears EXACTLY ONCE. Stated
			// that way rather than as a literal prefix, because generateUrl
			// inserts /index.php when mod_rewrite is not advertised -- true in
			// jsdom, false on the live instance -- and that is not what this
			// test is about.
			expect(url.match(/\/cloud/g)).toHaveLength(1)
		})

		it('sends the object name along with the UID when indexing', () => {
			axios.post.mockResolvedValue({ data: { task: {} } })

			linkTaskToMessage(42, { calendarUri: 'personal', taskUid: 'uid-1', taskUri: 'NAME.ics' })

			const [, body] = axios.post.mock.calls[0]
			expect(body.taskUri).toBe('NAME.ics')
			expect(body.taskUid).toBe('uid-1')
		})
	})
})
