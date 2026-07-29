/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { WorkClass } from './RequestCoordinator.js'

/**
 * A link to a message that keeps working after the message moves.
 *
 * Not /box/<mailboxId>/thread/<row id>: the mailbox id changes the moment the
 * message is filed somewhere else, and the row id changes on a re-index, so
 * that link rots exactly when someone comes back to an old task. The Message-ID
 * is what identifies a message for its whole life -- it is what RFC 2392's mid:
 * scheme is built on -- and DeepLinkController resolves it to wherever the
 * message lives at the moment the link is followed.
 *
 * The id travels as a query parameter because a Message-ID may legally contain
 * a slash, and %2F inside a path segment is rejected or silently decoded by web
 * servers before the router ever sees it.
 *
 * @param {string} messageId the RFC 5322 Message-ID, angle brackets included
 * @return {string} an absolute-path URL into this app
 */
export function messageDeepLink(messageId) {
	return generateUrl('/apps/mail/message?messageId={messageId}', { messageId })
}

/**
 * Where the Tasks app shows a single task.
 *
 * @param {string} calendarUri the calendar the task lives in
 * @param {string} taskUid the task's iCalendar UID
 * @return {string} an absolute-path URL into the Tasks app
 */
export function taskDeepLink(calendarUri, taskUid) {
	return generateUrl('/apps/tasks/#/calendars/{calendarUri}/tasks/{taskUid}', {
		calendarUri,
		taskUid,
	})
}

/**
 * Record that a task was made from a message.
 *
 * @param {number} messageId the local message row id
 * @param {object} link the task's identity
 * @param {string} link.calendarUri calendar the task was created in
 * @param {string} link.taskUid the task's iCalendar UID
 * @param {string} [link.summary] shown on the chip so it need not be fetched
 * @return {Promise<object>} the stored row
 */
export async function linkTaskToMessage(messageId, { calendarUri, taskUid, summary }) {
	const { data } = await axios.post(
		generateUrl('/apps/mail/api/messages/{messageId}/tasks', { messageId }),
		{ calendarUri, taskUid, summary },
		{ mailWorkClass: WorkClass.QUICK_MUTATION },
	)
	return data.task
}

/**
 * Every task made from any message in this message's thread.
 *
 * @param {number} messageId the local message row id
 * @param {object} [options] request options
 * @param {AbortSignal} [options.signal] cancels the request
 * @return {Promise<object[]>} the indexed tasks, possibly stale
 */
export async function fetchTasksForMessage(messageId, { signal } = {}) {
	const { data } = await axios.get(
		generateUrl('/apps/mail/api/messages/{messageId}/tasks', { messageId }),
		// NOT speculative. The coordinator does not merely deprioritise that
		// class -- it REJECTS it outright while there is foreground pressure
		// ("Speculative mail request dropped under foreground pressure"), and
		// opening a thread is foreground pressure by definition: the thread
		// fetch, the body fetch and the list loads are all in flight at that
		// moment. So this request was dropped essentially every time, the
		// rejection was caught and logged at debug, and the chip silently
		// never appeared. Confirmed from the access log: three 200s on
		// /messages/1600225/thread and not one /tasks request behind them.
		//
		// This is the content of the view the user is looking at, which is
		// what ACTIVE_CONTENT means. Same error, same reasoning, as the
		// section refill in .65.
		{ signal, mailWorkClass: WorkClass.ACTIVE_CONTENT },
	)
	return data.tasks ?? []
}

/**
 * Forget a task we have just found to be gone.
 *
 * The index cannot be told when a task is deleted in the Tasks app, so a
 * dangling row is normal and following the link is the only way we find out.
 * Cleaning up at that point is what keeps the indicator honest over time.
 *
 * @param {string} taskUid the task's iCalendar UID
 * @return {Promise<void>}
 */
export async function unlinkTask(taskUid) {
	await axios.delete(
		generateUrl('/apps/mail/api/tasks/{taskUid}', { taskUid }),
		{ mailWorkClass: WorkClass.QUICK_MUTATION },
	)
}
