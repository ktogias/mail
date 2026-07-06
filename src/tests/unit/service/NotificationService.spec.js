/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import router from '../../../router.js'
import { showNewMessagesNotification } from '../../../service/NotificationService.js'

vi.mock('../../../router.js', () => ({
	__esModule: true,
	default: {
		push: vi.fn(() => Promise.resolve()),
	},
}))

describe('service/NotificationService test suite', () => {
	let NotificationMock

	beforeEach(() => {
		NotificationMock = vi.fn(function(title, options) {
			this.title = title
			this.options = options
			this.close = vi.fn()
		})
		NotificationMock.permission = 'granted'
		vi.stubGlobal('Notification', NotificationMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		vi.clearAllMocks()
	})

	const message = {
		databaseId: 123,
		mailboxId: 31,
		from: [{ label: 'Jane Doe' }],
		subject: 'Hello',
	}
	const secondMessage = {
		databaseId: 124,
		mailboxId: 31,
		from: [{ label: 'John Doe' }],
		subject: 'Hello again',
	}

	// showNewMessagesNotification() kicks off the async permission check
	// without awaiting it, so give its microtasks a chance to run before
	// asserting.
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

	it('shows a notification when the window is not focused', async () => {
		vi.spyOn(document, 'hasFocus').mockReturnValue(false)

		showNewMessagesNotification([message])
		await flush()

		expect(NotificationMock).toHaveBeenCalledTimes(1)
	})

	it('does not notify the window the user is actively reading in', async () => {
		vi.spyOn(document, 'hasFocus').mockReturnValue(true)

		showNewMessagesNotification([message])
		await flush()

		expect(NotificationMock).not.toHaveBeenCalled()
	})

	it('clicking a single-message notification focuses the window and opens that message', async () => {
		vi.spyOn(document, 'hasFocus').mockReturnValue(false)
		const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})

		showNewMessagesNotification([message])
		await flush()

		const notification = NotificationMock.mock.instances[0]
		notification.onclick()
		// The router is imported lazily inside the click handler.
		await flush()

		expect(focus).toHaveBeenCalled()
		expect(router.push).toHaveBeenCalledWith({
			name: 'message',
			params: {
				mailboxId: 31,
				threadId: 123,
			},
		})
		expect(notification.close).toHaveBeenCalled()
	})

	it('clicking a multi-message notification opens the receiving mailbox instead', async () => {
		vi.spyOn(document, 'hasFocus').mockReturnValue(false)
		vi.spyOn(window, 'focus').mockImplementation(() => {})

		showNewMessagesNotification([message, secondMessage])
		await flush()

		NotificationMock.mock.instances[0].onclick()
		// The router is imported lazily inside the click handler.
		await flush()

		expect(router.push).toHaveBeenCalledWith({
			name: 'mailbox',
			params: {
				mailboxId: 31,
			},
		})
	})
})
