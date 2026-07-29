/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { fetchTasksForMessage, linkTaskToMessage } from '../../../service/MessageTaskService.js'
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
})
