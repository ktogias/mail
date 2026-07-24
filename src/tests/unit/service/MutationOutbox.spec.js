/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
	executeDurableMutation,
	listOperations,
	replayMutationOutbox,
	resetMutationOutboxForTests,
	subscribePendingMutations,
} from '../../../service/MutationOutbox.js'

describe('MutationOutbox', () => {
	beforeEach(async () => {
		await resetMutationOutboxForTests()
	})

	it('removes an operation after a confirmed response', async () => {
		const response = await executeDurableMutation({
			type: 'set-flags',
			payload: { id: 42, flags: { seen: true } },
			send: async (operationId) => ({ operationId }),
		})

		expect(response.operationId).toBeTypeOf('string')
		await expect(listOperations()).resolves.toEqual([])
	})

	it('keeps an ambiguous failure and replays the same operation id', async () => {
		const networkError = new Error('Network Error')
		await expect(executeDurableMutation({
			type: 'set-flags',
			payload: { id: 42, flags: { seen: true } },
			send: async () => {
				throw networkError
			},
		})).rejects.toMatchObject({ mailMutationQueued: true })
		const [pending] = await listOperations()

		const send = vi.fn().mockResolvedValue({})
		await replayMutationOutbox(send)

		expect(send).toHaveBeenCalledWith(expect.objectContaining({
			id: pending.id,
			type: 'set-flags',
		}))
		await expect(listOperations()).resolves.toEqual([])
	})

	it('does not flash the pending banner for a successful in-flight request', async () => {
		const counts = []
		const unsubscribe = subscribePendingMutations((count) => counts.push(count))
		await Promise.resolve()

		await executeDurableMutation({
			type: 'set-flags',
			payload: { id: 42, flags: { seen: true } },
			send: async () => ({}),
		})

		expect(counts).not.toContain(1)
		unsubscribe()
	})
})
