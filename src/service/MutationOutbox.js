/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getCurrentUser } from '@nextcloud/auth'

const DB_NAME = 'nextcloud-mail-mutation-outbox-v1'
const STORE_NAME = 'operations'
const DB_VERSION = 1
const memoryFallback = new Map()
const listeners = new Set()
let databasePromise
let replayPromise

function currentUserId() {
	return getCurrentUser()?.uid ?? null
}

function newOperationId() {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID()
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function openDatabase() {
	if (databasePromise !== undefined) {
		return databasePromise
	}
	if (typeof indexedDB === 'undefined') {
		databasePromise = Promise.resolve(null)
		return databasePromise
	}
	databasePromise = new Promise((resolve) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION)
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE_NAME)) {
				request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
			}
		}
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => resolve(null)
	})
	return databasePromise
}

async function storeOperation(operation, notify = true) {
	const database = await openDatabase()
	if (database === null) {
		memoryFallback.set(operation.id, operation)
		if (notify) {
			await emitCount()
		}
		return
	}
	await new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, 'readwrite')
		transaction.objectStore(STORE_NAME).put(operation)
		transaction.oncomplete = resolve
		transaction.onerror = () => reject(transaction.error)
	})
	if (notify) {
		await emitCount()
	}
}

export async function removeOperation(id) {
	const database = await openDatabase()
	if (database === null) {
		memoryFallback.delete(id)
		await emitCount()
		return
	}
	await new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, 'readwrite')
		transaction.objectStore(STORE_NAME).delete(id)
		transaction.oncomplete = resolve
		transaction.onerror = () => reject(transaction.error)
	})
	await emitCount()
}

export async function listOperations() {
	const database = await openDatabase()
	if (database === null) {
		return [...memoryFallback.values()]
			.filter((operation) => operation.userId === currentUserId())
			.sort((left, right) => left.createdAt - right.createdAt)
	}
	return new Promise((resolve, reject) => {
		const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).getAll()
		request.onsuccess = () => resolve(request.result
			.filter((operation) => operation.userId === currentUserId())
			.sort((left, right) => left.createdAt - right.createdAt))
		request.onerror = () => reject(request.error)
	})
}

async function emitCount() {
	const count = (await listOperations()).length
	listeners.forEach((listener) => listener(count))
}

export function subscribePendingMutations(listener) {
	listeners.add(listener)
	listOperations().then((operations) => listener(operations.length))
	return () => listeners.delete(listener)
}

// An operation the replay gave up on. Nobody is awaiting a replayed
// operation -- the call that created it returned long ago -- so a definitive
// failure here reaches no catch block and no toast, and the optimistic state
// it left behind stays on screen describing something that never happened.
//
// Live on 2026-07-27: a mark-as-read got a 500 while Gmail was refusing
// authentication under connection pressure, was retried at 14:58 and
// cancelled, and by 14:59:50 the message row was gone, so the replay took a
// 404 and dropped the operation. The row kept rendering as read. Nothing
// anywhere told the user their action had been lost.
const abandonListeners = new Set()

export function subscribeAbandonedMutations(listener) {
	abandonListeners.add(listener)
	return () => abandonListeners.delete(listener)
}

function emitAbandoned(operation, error) {
	abandonListeners.forEach((listener) => listener({
		type: operation.type,
		payload: operation.payload,
		attempts: operation.attempts,
		status: error?.response?.status,
	}))
}

function isDefinitiveFailure(error) {
	const status = error?.response?.status
	return status >= 400
		&& status < 500
		&& ![408, 409, 425, 429].includes(status)
}

export async function executeDurableMutation({ type, payload, send }) {
	const operation = {
		id: newOperationId(),
		userId: currentUserId(),
		type,
		payload,
		createdAt: Date.now(),
		lastAttemptAt: null,
		attempts: 0,
	}
	// Persist before sending so a tab/process crash cannot lose the action.
	// Do not show the pending banner for a normal in-flight request; a retry
	// becomes user-visible only if the first attempt is ambiguous.
	await storeOperation(operation, false)
	try {
		const response = await send(operation.id)
		await removeOperation(operation.id)
		return response
	} catch (error) {
		if (isDefinitiveFailure(error)) {
			await removeOperation(operation.id)
		} else {
			operation.lastAttemptAt = Date.now()
			operation.attempts++
			await storeOperation(operation)
			error.mailMutationQueued = true
		}
		throw error
	}
}

export function replayMutationOutbox(send) {
	if (replayPromise !== undefined) {
		return replayPromise
	}
	replayPromise = (async () => {
		const operations = await listOperations()
		for (const operation of operations) {
			try {
				await send(operation)
				await removeOperation(operation.id)
			} catch (error) {
				if (isDefinitiveFailure(error)) {
					await removeOperation(operation.id)
					emitAbandoned(operation, error)
					continue
				}
				operation.lastAttemptAt = Date.now()
				operation.attempts++
				await storeOperation(operation)
				break
			}
		}
		await emitCount()
	})().finally(() => {
		replayPromise = undefined
	})
	return replayPromise
}

export async function resetMutationOutboxForTests() {
	memoryFallback.clear()
	const database = await openDatabase()
	if (database !== null) {
		await new Promise((resolve, reject) => {
			const transaction = database.transaction(STORE_NAME, 'readwrite')
			transaction.objectStore(STORE_NAME).clear()
			transaction.oncomplete = resolve
			transaction.onerror = () => reject(transaction.error)
		})
	}
	await emitCount()
}
