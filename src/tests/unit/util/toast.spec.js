/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as dialogs from '@nextcloud/dialogs'
import {
	registerToastDismissal,
	resetToastDismissalForTests,
	showError,
	showSuccess,
	showUndo,
} from '../../../util/toast.js'

vi.mock('@nextcloud/dialogs', async (importOriginal) => ({
	...(await importOriginal()),
	showError: vi.fn(),
	showSuccess: vi.fn(),
	showUndo: vi.fn(),
}))

describe('util/toast', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resetToastDismissalForTests()
		document.body.innerHTML = ''
	})

	it('makes every toast dismissible without the caller having to remember', () => {
		// @nextcloud/dialogs defaults close to false. WCAG 2.2.1 treats
		// content that disappears on a timer as needing a way to dismiss it,
		// and 44 of the 46 call sites were not passing the option.
		showSuccess('saved')
		showError('failed')

		expect(dialogs.showSuccess).toHaveBeenCalledWith('saved', expect.objectContaining({ close: true }))
		expect(dialogs.showError).toHaveBeenCalledWith('failed', expect.objectContaining({ close: true }))
	})

	it('lets a caller override the default rather than fighting it', () => {
		// UndoableAction has to pass its own timeout; a wrapper that clobbered
		// caller options would silently break it.
		showUndo('deleted', () => {}, { timeout: 1234 })

		expect(dialogs.showUndo).toHaveBeenCalledWith('deleted', expect.any(Function), {
			close: true,
			timeout: 1234,
		})
	})

	it('preserves an explicit close: false', () => {
		showError('persistent', { close: false })

		expect(dialogs.showError).toHaveBeenCalledWith('persistent', { close: false })
	})

	describe('Escape', () => {
		/**
		 * @param {HTMLElement} target element the keydown originates from
		 * @return {KeyboardEvent} the dispatched event
		 */
		const pressEscape = (target) => {
			const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			target.dispatchEvent(event)
			return event
		}

		it('dismisses the toast when the user is inside it', () => {
			registerToastDismissal()
			document.body.innerHTML = '<div class="toastify dialogs"><button id="undo">Undo</button></div>'

			pressEscape(document.querySelector('#undo'))

			expect(document.querySelector('.toastify.dialogs')).toBeNull()
		})

		it('leaves Escape alone everywhere else', () => {
			// The important half. A global Escape handler would take the undo
			// window away from anyone who pressed Escape to close the composer
			// or a modal -- losing the chance to undo is worse than having to
			// click the close button, so this must stay scoped to focus-within.
			registerToastDismissal()
			document.body.innerHTML = '<div class="toastify dialogs">deleted</div><input id="elsewhere">'

			const event = pressEscape(document.querySelector('#elsewhere'))

			expect(document.querySelector('.toastify.dialogs')).not.toBeNull()
			expect(event.defaultPrevented).toBe(false)
		})

		it('registers the listener once however many times it is called', () => {
			const spy = vi.spyOn(document, 'addEventListener')

			registerToastDismissal()
			registerToastDismissal()
			registerToastDismissal()

			expect(spy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
		})
	})
})
