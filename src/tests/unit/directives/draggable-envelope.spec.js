/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import DraggableEnvelope, { DraggableEnvelopeDirective } from '../../../directives/drag-and-drop/draggable-envelope/index.js'

function createMockEl(id) {
	return {
		id,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		setAttribute: vi.fn(),
		classList: { add: vi.fn() },
	}
}

function createBinding(overrides = {}) {
	return {
		value: {
			accountId: 1,
			mailboxId: 11,
			databaseId: 42,
			draggableLabel: 'Message 42',
			selectedEnvelopes: [],
			isDraggable: true,
			...overrides,
		},
	}
}

describe('DraggableEnvelopeDirective', () => {
	const { bind, componentUpdated, unbind } = DraggableEnvelopeDirective
	let boundEls

	beforeEach(() => {
		boundEls = []
	})

	afterEach(() => {
		boundEls.forEach((el) => unbind(el))
		vi.restoreAllMocks()
	})

	it('updates only the instance owned by the changed row', () => {
		const el1 = createMockEl('el1')
		const el2 = createMockEl('el2')
		const updateSpy = vi.spyOn(DraggableEnvelope.prototype, 'update')
		const updatedBinding = createBinding({ databaseId: 42, selectedEnvelopes: [{ databaseId: 42 }] })

		bind(el1, createBinding({ databaseId: 42 }))
		bind(el2, createBinding({ databaseId: 43 }))
		boundEls.push(el1, el2)
		componentUpdated(el1, updatedBinding)

		expect(updateSpy).toHaveBeenCalledTimes(1)
		expect(updateSpy).toHaveBeenCalledWith(updatedBinding.value)
		expect(updateSpy.mock.contexts[0].el).toBe(el1)
	})

	it('updates synchronously without allocating a deferred timer per row', () => {
		const el = createMockEl('el1')
		const timerSpy = vi.spyOn(globalThis, 'setTimeout')

		bind(el, createBinding())
		boundEls.push(el)
		componentUpdated(el, createBinding({ selectedEnvelopes: [{ databaseId: 42 }] }))

		expect(timerSpy).not.toHaveBeenCalled()
	})

	it('removes the same bound listener references that were registered', () => {
		const el = createMockEl('el1')

		bind(el, createBinding())
		unbind(el)

		const added = el.addEventListener.mock.calls
		const removed = el.removeEventListener.mock.calls
		expect(removed).toHaveLength(2)
		for (let i = 0; i < 2; i++) {
			expect(removed[i][0]).toBe(added[i][0])
			expect(removed[i][1]).toBe(added[i][1])
		}
	})

	it('drops ownership on unbind so later updates cannot reach the old instance', () => {
		const el = createMockEl('el1')
		const updateSpy = vi.spyOn(DraggableEnvelope.prototype, 'update')

		bind(el, createBinding())
		unbind(el)
		componentUpdated(el, createBinding({ selectedEnvelopes: [{ databaseId: 42 }] }))

		expect(updateSpy).not.toHaveBeenCalled()
		expect(() => unbind(el)).not.toThrow()
	})
})
