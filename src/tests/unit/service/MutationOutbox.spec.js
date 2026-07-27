/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
	executeDurableMutation,
	listOperations,
	replayMutationOutbox,
	resetMutationOutboxForTests,
	subscribeAbandonedMutations,
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

	// A replay has no caller left to catch anything, so a definitive failure
	// there used to drop the operation in total silence while the optimistic
	// state it created stayed on screen. Live on 2026-07-27: a mark-as-read
	// that failed under IMAP connection pressure, was retried, and finally
	// 404ed because the row was gone -- the message kept rendering as read
	// and nothing ever said otherwise.
	it('announces an operation the replay gives up on', async () => {
		const networkError = new Error('Network Error')
		await expect(executeDurableMutation({
			type: 'set-flags',
			payload: { id: 1471105, flags: { seen: true } },
			send: async () => {
				throw networkError
			},
		})).rejects.toMatchObject({ mailMutationQueued: true })

		const abandoned = []
		const unsubscribe = subscribeAbandonedMutations((operation) => abandoned.push(operation))
		const gone = new Error('Not Found')
		gone.response = { status: 404 }
		await replayMutationOutbox(async () => {
			throw gone
		})
		unsubscribe()

		expect(abandoned).toEqual([expect.objectContaining({
			type: 'set-flags',
			payload: { id: 1471105, flags: { seen: true } },
			status: 404,
		})])
		await expect(listOperations()).resolves.toEqual([])
	})

	it('stays silent when the replay merely defers an ambiguous failure', async () => {
		const networkError = new Error('Network Error')
		await expect(executeDurableMutation({
			type: 'set-flags',
			payload: { id: 42, flags: { seen: true } },
			send: async () => {
				throw networkError
			},
		})).rejects.toMatchObject({ mailMutationQueued: true })

		const abandoned = []
		const unsubscribe = subscribeAbandonedMutations((operation) => abandoned.push(operation))
		await replayMutationOutbox(async () => {
			throw new Error('still offline')
		})
		unsubscribe()

		expect(abandoned).toEqual([])
		await expect(listOperations()).resolves.toHaveLength(1)
	})
})
