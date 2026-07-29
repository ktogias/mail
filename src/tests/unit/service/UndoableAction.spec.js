/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TOAST_PERMANENT_TIMEOUT, TOAST_UNDO_TIMEOUT } from '@nextcloud/dialogs'
import { deferWithUndo } from '../../../service/UndoableAction.js'
import { showUndo } from '../../../util/toast.js'

vi.mock('../../../util/toast.js', () => ({ showUndo: vi.fn() }))

/**
 * The real showUndo puts an element in the DOM; deferWithUndo finds it by
 * diffing the document, and everything about hovering hangs off that element.
 * A mock returning only a handle would exercise none of it.
 *
 * @param {Function} onUndo invoked to simulate the user clicking Undo
 * @return {{element: HTMLElement, hideToast: Function}} the fake toast
 */
function renderFakeToast(onUndo) {
	const element = document.createElement('div')
	element.className = 'toastify dialogs'
	document.body.appendChild(element)
	const handle = {
		element,
		hideToast: vi.fn(() => element.remove()),
		clickUndo: () => onUndo(),
	}
	return handle
}

describe('deferWithUndo', () => {
	let action
	let toast

	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
		document.body.innerHTML = ''
		action = vi.fn().mockResolvedValue(undefined)
		showUndo.mockImplementation((message, onUndo) => {
			toast = renderFakeToast(onUndo)
			return toast
		})
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('gives the toast no timer of its own', async () => {
		// One clock. The toast used to count down independently of the window
		// that actually gates the action, so pausing one would have left the
		// Undo button on screen after the delete had already gone through, or
		// taken it away while it had not.
		const pending = deferWithUndo({ message: 'deleted', action })

		expect(showUndo).toHaveBeenCalledWith('deleted', expect.any(Function), expect.objectContaining({
			timeout: TOAST_PERMANENT_TIMEOUT,
		}))

		await vi.advanceTimersByTimeAsync(TOAST_UNDO_TIMEOUT)
		await pending
	})

	it('runs the action and hides the toast once the window passes', async () => {
		const pending = deferWithUndo({ message: 'deleted', action })

		expect(action).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(TOAST_UNDO_TIMEOUT)
		await pending

		expect(action).toHaveBeenCalledTimes(1)
		expect(toast.hideToast).toHaveBeenCalled()
	})

	it('holds the window while the pointer rests on the toast', async () => {
		// The part users actually feel: moving towards Undo must not cost them
		// the chance to press it.
		const onUndo = vi.fn()
		const pending = deferWithUndo({ message: 'deleted', action, onUndo })

		await vi.advanceTimersByTimeAsync(TOAST_UNDO_TIMEOUT / 2)
		toast.element.dispatchEvent(new Event('pointerenter'))

		// Well past the original deadline, and still undoable.
		await vi.advanceTimersByTimeAsync(TOAST_UNDO_TIMEOUT * 2)
		expect(action).not.toHaveBeenCalled()

		toast.element.dispatchEvent(new Event('pointerleave'))
		await vi.advanceTimersByTimeAsync(TOAST_UNDO_TIMEOUT)
		await pending

		expect(action).toHaveBeenCalledTimes(1)
	})

	it('holds it for a keyboard user too', async () => {
		const pending = deferWithUndo({ message: 'deleted', action })

		toast.element.dispatchEvent(new Event('focusin'))
		await vi.advanceTimersByTimeAsync(TOAST_UNDO_TIMEOUT * 2)
		expect(action).not.toHaveBeenCalled()

		toast.element.dispatchEvent(new Event('focusout'))
		await vi.advanceTimersByTimeAsync(TOAST_UNDO_TIMEOUT)
		await pending

		expect(action).toHaveBeenCalledTimes(1)
	})

	it('does not let a resting pointer defer a delete forever', async () => {
		// A pointer that comes to rest on the toast never produces a leave
		// event. Without a cap the message stays hidden from the list but is
		// never actually deleted, and a reload puts it back.
		const pending = deferWithUndo({ message: 'deleted', action })

		toast.element.dispatchEvent(new Event('pointerenter'))
		await vi.advanceTimersByTimeAsync(60_000 + TOAST_UNDO_TIMEOUT + 1_000)
		await pending

		expect(action).toHaveBeenCalledTimes(1)
	})

	it('ends the window the moment Undo is clicked', async () => {
		// Without this the promise keeps counting after the decision is made --
		// and the pointer is still on the toast right after a click, so the
		// hold would stretch it further still.
		const onUndo = vi.fn()
		const pending = deferWithUndo({ message: 'deleted', action, onUndo })

		toast.element.dispatchEvent(new Event('pointerenter'))
		toast.clickUndo()
		await pending

		expect(onUndo).toHaveBeenCalledTimes(1)
		expect(action).not.toHaveBeenCalled()
	})
})
