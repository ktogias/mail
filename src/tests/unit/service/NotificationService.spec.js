/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { showNewMessagesNotification } from '../../../service/NotificationService.js'

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
	})

	const message = {
		from: [{ label: 'Jane Doe' }],
		subject: 'Hello',
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
})
