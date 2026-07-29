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

		expect(dialogs.showUndo).toHaveBeenCalledWith('deleted', expect.any(Function), expect.objectContaining({
			close: true,
			timeout: 1234,
		}))
	})

	it('preserves an explicit close: false', () => {
		showError('persistent', { close: false })

		expect(dialogs.showError).toHaveBeenCalledWith('persistent', expect.objectContaining({ close: false }))
	})

	describe('stacking', () => {
		// Toastify already stacks -- it writes a cumulative inline `top` -- but
		// the stylesheet has to overwrite `top` to get the toasts off the corner
		// where they covered the thread's buttons, and that flattened the stack:
		// a second action landed exactly on top of the first, so acting quickly
		// meant losing sight of the undo windows still open.
		//
		// Toastify inserts the NEWEST first in the DOM (oldestFirst: true), so
		// document order is newest to oldest.

		/**
		 * @param {number} height pretend rendered height
		 * @return {HTMLElement} a toast element already in the document
		 */
		const addToast = (height = 48) => {
			const element = document.createElement('div')
			element.className = 'toastify dialogs'
			Object.defineProperty(element, 'offsetHeight', { value: height, configurable: true })
			// Newest first, exactly as toastify inserts them.
			document.body.insertBefore(element, document.body.firstChild)
			return element
		}

		/** @return {string[]} each toast's bottom offset, newest first */
		const offsets = () => [...document.querySelectorAll('.toastify.dialogs')]
			.map((el) => el.style.getPropertyValue('--mail-toast-offset'))

		beforeEach(() => {
			dialogs.showSuccess.mockImplementation(() => ({ hideToast: vi.fn() }))
		})

		it('puts each new toast above the one before instead of on top of it', () => {
			addToast(48)
			showSuccess('first')
			expect(offsets()).toEqual(['16px'])

			addToast(48)
			showSuccess('second')

			// Newest nearest the edge, the older one pushed up by its own height
			// plus the gap. Distinct offsets is the whole point.
			expect(offsets()).toEqual([
				'16px',
				'72px',
			])
		})

		it('measures each toast rather than assuming they are all the same height', () => {
			addToast(100)
			addToast(20)
			showSuccess('trigger a restack')

			const [newest, oldest] = offsets()
			expect(newest).toBe('16px')
			// 16 + 20 (the newest one's real height) + 8 gap
			expect(oldest).toBe('44px')
		})

		it('retires the oldest once the stack is full', () => {
			// A burst of deletes would otherwise pile past the top of the screen.
			for (let i = 0; i < 6; i++) {
				addToast(48)
			}
			showSuccess('trigger a restack')

			expect(document.querySelectorAll('.toastify.dialogs')).toHaveLength(5)
		})

		it('closes the gap when a toast in the middle goes away', () => {
			addToast(48)
			addToast(48)
			addToast(48)
			showSuccess('trigger a restack')
			expect(offsets()).toHaveLength(3)

			// onRemove is what toastify calls once the element has left.
			document.querySelectorAll('.toastify.dialogs')[1].remove()
			const { onRemove } = dialogs.showSuccess.mock.calls.at(-1)[1]
			onRemove()

			expect(offsets()).toEqual([
				'16px',
				'72px',
			])
		})

		it('still runs a caller\'s own onRemove', () => {
			const callerOnRemove = vi.fn()
			showSuccess('saved', { onRemove: callerOnRemove })

			dialogs.showSuccess.mock.calls.at(-1)[1].onRemove()

			expect(callerOnRemove).toHaveBeenCalledTimes(1)
		})
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
