/**
 * SPDX-FileCopyrightText: 2018 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import pLimit from 'p-limit'
import { curry } from 'ramda'
import { convertAxiosError } from '../errors/convert.js'
import MalformedSyncResponseError from '../errors/MalformedSyncResponseError.js'
import SyncIncompleteError from '../errors/SyncIncompleteError.js'
import { parseErrorResponse } from '../http/ErrorResponseParser.js'
import logger from '../logger.js'
import {
	executeDurableMutation,
	replayMutationOutbox,
} from './MutationOutbox.js'
import { WorkClass } from './RequestCoordinator.js'

const amendEnvelopeWithIds = curry((accountId, envelope) => ({
	accountId,
	...envelope,
}))

// A free-text envelope search (to:/from:/cc:/bcc:/subject:/body: with a term) is
// expensive on this install: `body:` is a live IMAP SEARCH, and the others hit a
// mail DB (oc_mail_messages ~1.1 GB + oc_mail_recipients ~1 GB) far larger than
// the NAS's RAM, so each one is disk-I/O-bound and holds a PHP-FPM worker for
// tens of seconds. The priority/unified inbox fans a single user search out
// across every section (Favorites/Important/Other) AND every constituent mailbox
// at once, so one search became 5+ concurrent multi-second searches that both
// saturated the small dedicated mail FPM pool (4 workers) and thrashed the DB
// page cache -- everything else then queued and 504'd (observed live 2026-07-22,
// confirmed in a Firefox profile + FPM slow log). Cap concurrent free-text
// searches app-wide so they queue instead of stampeding, leaving workers free
// for interactive operations. Structural bucket filters (is:*, not:*, tags:*,
// match:*) and unfiltered fetches are all local, cheap, and never throttled.
const TEXT_SEARCH_MAX_CONCURRENCY = 2
const textSearchLimit = pLimit(TEXT_SEARCH_MAX_CONCURRENCY)
const isFreeTextSearch = (query) => typeof query === 'string' && /(?:^|\s)(?:to|from|cc|bcc|subject|body):/.test(query)
const envelopeFlagMutationLimit = pLimit(1)
const ACTIVE_MESSAGE_FETCH_ATTEMPTS = 3
const ACTIVE_MESSAGE_FETCH_RETRY_STATUSES = new Set([408, 425, 429, 502, 503, 504])
const ACTIVE_MESSAGE_FETCH_MAX_RETRY_AFTER_MS = 5_000

export const messageBodyRequestKey = (id) => `message-body:${id}`
export const messageThreadRequestKey = (id) => `message-thread:${id}`

function retryAfterMs(error, attempt, id) {
	const headers = error.response?.headers
	const retryAfter = typeof headers?.get === 'function'
		? headers.get('retry-after')
		: headers?.['retry-after']
	let serverDelay
	if (retryAfter !== undefined) {
		const seconds = Number(retryAfter)
		serverDelay = Number.isFinite(seconds)
			? seconds * 1_000
			: Date.parse(retryAfter) - Date.now()
	}

	const numericId = Number(id)
	const stagger = Number.isFinite(numericId) ? Math.abs(numericId) % 251 : 0
	const fallback = 500 * (2 ** attempt) + stagger
	return Math.min(
		ACTIVE_MESSAGE_FETCH_MAX_RETRY_AFTER_MS,
		Math.max(0, Number.isFinite(serverDelay) ? serverDelay : fallback),
	)
}

function waitForRetry(delay, signal) {
	if (signal?.aborted) {
		return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
	}

	return new Promise((resolve, reject) => {
		const retry = {}
		const onAbort = () => {
			clearTimeout(retry.timer)
			reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
		}
		retry.timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, delay)
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}

async function fetchActiveMessage(url, id, signal, attempt = 0) {
	try {
		return await axios.get(url, {
			signal,
			mailWorkClass: WorkClass.ACTIVE_CONTENT,
			mailRequestKey: messageBodyRequestKey(id),
		})
	} catch (error) {
		const status = error.response?.status
		if (
			!axios.isCancel(error)
			&& ACTIVE_MESSAGE_FETCH_RETRY_STATUSES.has(status)
			&& attempt < ACTIVE_MESSAGE_FETCH_ATTEMPTS - 1
		) {
			await waitForRetry(retryAfterMs(error, attempt, id), signal)
			return fetchActiveMessage(url, id, signal, attempt + 1)
		}
		throw error
	}
}

export function fetchEnvelope(accountId, id) {
	const url = generateUrl('/apps/mail/api/messages/{id}', {
		id,
	})

	return axios
		.get(url, {
			mailWorkClass: WorkClass.ACTIVE_CONTENT,
			mailAccountId: accountId,
		})
		.then((resp) => resp.data)
		.then(amendEnvelopeWithIds(accountId))
		.catch((error) => {
			if (error.response && [403, 404].includes(error.response.status)) {
				// MessagesController::show() intentionally returns 403 for a
				// row that no longer exists as well as for a row the current
				// user cannot access. For a caller fetching one already-known
				// envelope both answers are terminal: there is no envelope it
				// may keep or reconcile locally. Treat both like "gone" so a
				// deleted thread sibling cannot remain in the store and be
				// retried by every near-expiry reconciliation sweep forever.
				return undefined
			}
			if (!error.response) {
				// A network failure (or the browser killing an in-flight
				// request when the tab is backgrounded) never receives an
				// HTTP response -- nothing for parseErrorResponse() to
				// parse. Reject with the original error so its actual
				// message survives, instead of losing it.
				return Promise.reject(error)
			}
			return Promise.reject(parseErrorResponse(error.response))
		})
}

export function fetchEnvelopes(accountId, mailboxId, query, cursor, limit, sort, view, cacheBuster, signal, prioritySplit = false, cursorId, workClass = WorkClass.ACTIVE_CONTENT) {
	const url = generateUrl('/apps/mail/api/messages')
	const params = {
		mailboxId,
	}

	if (query) {
		params.filter = query
	}
	if (limit) {
		params.limit = limit
	}
	if (cursor) {
		params.cursor = cursor
		if (cursorId) {
			params.cursorId = cursorId
		}
	}
	if (sort) {
		params.sort = sort
	}
	if (view) {
		params.view = view
	}
	if (cacheBuster) {
		params.v = cacheBuster
	}
	if (prioritySplit) {
		params.prioritySplit = true
	}

	const run = () => axios
		.get(url, {
			params,
			signal,
			mailWorkClass: workClass,
			mailAccountId: accountId,
		})
		.then((resp) => resp.data)
		.then((envelopes) => envelopes.map(amendEnvelopeWithIds(accountId)))
		.catch((error) => {
			if (axios.isCancel(error)) {
				// A superseded search's abort is not a server error
				// response -- rethrow as-is so callers can tell the two
				// apart (same contract as fetchMessage()).
				throw error
			}
			throw convertAxiosError(error)
		})

	// Free-text searches queue behind the shared limiter; everything else runs
	// immediately. A queued search that gets aborted before it starts still
	// resolves instantly when dequeued -- axios rejects an already-aborted
	// signal without touching the network, so it never occupies a worker.
	return isFreeTextSearch(query) ? textSearchLimit(run) : run()
}
export async function fetchThread(id, { signal, speculative = false } = {}) {
	const url = generateUrl('apps/mail/api/messages/{id}/thread', {
		id,
	})
	const resp = await axios.get(url, {
		signal,
		mailWorkClass: speculative ? WorkClass.SPECULATIVE : WorkClass.ACTIVE_CONTENT,
		mailRequestKey: messageThreadRequestKey(id),
	})
	return resp.data
}

export async function syncEnvelopes(accountId, id, ids, lastMessageTimestamp, query, init = false, sortOrder, workClass = WorkClass.VISIBLE_REVALIDATION, states) {
	const url = generateUrl('/apps/mail/api/mailboxes/{id}/sync', {
		id,
	})

	try {
		const response = await axios.post(url, {
			ids,
			lastMessageTimestamp,
			init,
			sortOrder,
			query,
			states,
		}, {
			mailWorkClass: workClass,
			mailAccountId: accountId,
		})

		if (response.status === 202) {
			throw new SyncIncompleteError()
		}

		if (!Array.isArray(response.data?.newMessages) || !Array.isArray(response.data?.changedMessages)) {
			// Confirmed live: a 200 response whose body was missing
			// newMessages/changedMessages crashed on the .map() calls
			// below with a raw, uninformative TypeError instead of a
			// clear, retriable error -- the mailbox was then left
			// silently out of sync until the next unrelated refresh, with
			// no automatic retry (unlike MailboxLockedError/
			// SyncIncompleteError, which do retry). Root cause not yet
			// pinned down -- seen only under heavy concurrent load on a
			// resource-constrained NAS. Until it is, log the actual
			// response body for the next occurrence and let
			// syncEnvelopes() (mainStore/actions.js) retry once instead
			// of giving up immediately.
			logger.error('Sync response for mailbox is missing the expected fields', { mailboxId: id, data: response.data })
			throw new MalformedSyncResponseError(`Malformed sync response for mailbox ${id}`)
		}

		const amend = amendEnvelopeWithIds(accountId)
		return {
			newMessages: response.data.newMessages.map(amend),
			changedMessages: response.data.changedMessages.map(amend),
			vanishedMessages: response.data.vanishedMessages,
			stats: response.data.stats,
			// Rides every sync response for free -- see
			// SyncService::isServerBusy() -- so the watched-mailbox poller
			// can widen its own tick period under load.
			serverBusy: response.data.serverBusy === true,
		}
	} catch (e) {
		throw convertAxiosError(e)
	}
}

export async function clearCache(accountId, id) {
	const url = generateUrl('/apps/mail/api/mailboxes/{id}/sync', {
		id,
	})

	try {
		const response = await axios.delete(url)

		if (response.status === 202) {
			throw new SyncIncompleteError()
		}
	} catch (e) {
		throw convertAxiosError(e)
	}
}

// Flag mutations are already serialized app-wide by
// envelopeFlagMutationLimit, so anything the user does while one is in
// flight simply waits. Each one costs a full IMAP connect/auth -- measured
// live on 2026-07-26 at 2.6-5.6s with only 10-16% CPU -- so a run of
// per-message clicks turned into minutes of queue: eight messages meant
// eight round trips, back to back.
//
// Requests that are still waiting for that single slot have not been sent
// yet, so identical flag writes can still be merged into one batch. The
// group stays open only until the limiter admits it, which is exactly the
// window in which merging is free: no timer, no added latency for the
// first click, and a lone mutation still takes the single-message
// endpoint unchanged.
const FLAG_MUTATION_COALESCE_LIMIT = 50
const pendingFlagGroups = new Map()

function flagsSignature(flags) {
	return JSON.stringify(Object.keys(flags).sort().map((key) => [key, flags[key]]))
}

function createFlagGroup(signature, flags) {
	const ids = []
	const group = {
		flags,
		ids,
		join(id) {
			ids.push(id)
			return group.result.then((data) => {
				// A batch reports per-message state under `messages`; a
				// single-message send returns that state at the top level.
				const perMessage = data?.messages?.[String(id)] ?? (ids.length === 1 ? data : undefined)
				return {
					...perMessage,
					...(data?.importantTag ? { importantTag: data.importantTag } : {}),
				}
			})
		},
	}

	group.result = envelopeFlagMutationLimit(async () => {
		// Admitted: stop accepting joiners, so a mutation started from here
		// on opens the next group instead of mutating this payload.
		if (pendingFlagGroups.get(signature) === group) {
			pendingFlagGroups.delete(signature)
		}
		const batchedIds = ids.slice(0, FLAG_MUTATION_COALESCE_LIMIT)

		if (batchedIds.length === 1) {
			const url = generateUrl('/apps/mail/api/messages/{id}/flags', {
				id: batchedIds[0],
			})
			return executeDurableMutation({
				type: 'set-flags',
				payload: { id: batchedIds[0], flags },
				send: async (operationId) => {
					const { data } = await axios.put(url, {
						flags,
						operationId,
					}, {
						mailWorkClass: WorkClass.QUICK_MUTATION,
					})
					return data
				},
			})
		}

		return executeDurableMutation({
			type: 'set-flags-batch',
			payload: { ids: batchedIds, flags },
			send: async (operationId) => {
				const { data } = await axios.put(generateUrl('/apps/mail/api/messages/flags'), {
					ids: batchedIds,
					flags,
					operationId,
				}, {
					mailWorkClass: WorkClass.QUICK_MUTATION,
				})
				return data
			},
		})
	})

	return group
}

/**
 * Set flags for envelope
 *
 * @param {number} id
 * @param {object} flags
 * @return {Promise<{hasUnseenInThread: boolean}>}
 */
export async function setEnvelopeFlags(id, flags) {
	const signature = flagsSignature(flags)
	let group = pendingFlagGroups.get(signature)
	if (!group || group.ids.length >= FLAG_MUTATION_COALESCE_LIMIT) {
		group = createFlagGroup(signature, flags)
		pendingFlagGroups.set(signature, group)
	}
	return group.join(id)
}

export function resetFlagMutationCoalescingForTests() {
	pendingFlagGroups.clear()
}

export async function setEnvelopeFlagsBatch(ids, flags) {
	const url = generateUrl('/apps/mail/api/messages/flags')
	return envelopeFlagMutationLimit(() => executeDurableMutation({
		type: 'set-flags-batch',
		payload: { ids, flags },
		send: async (operationId) => {
			const { data } = await axios.put(url, {
				ids,
				flags,
				operationId,
			}, {
				mailWorkClass: WorkClass.QUICK_MUTATION,
			})
			return data
		},
	}))
}

export function replayQueuedMutations() {
	return envelopeFlagMutationLimit(() => replayMutationOutbox(async (operation) => {
		if (operation.type === 'set-flags') {
			const url = generateUrl('/apps/mail/api/messages/{id}/flags', {
				id: operation.payload.id,
			})
			const { data } = await axios.put(url, {
				flags: operation.payload.flags,
				operationId: operation.id,
			}, {
				mailWorkClass: WorkClass.QUICK_MUTATION,
			})
			return data
		}
		if (operation.type === 'set-flags-batch') {
			const { data } = await axios.put(generateUrl('/apps/mail/api/messages/flags'), {
				...operation.payload,
				operationId: operation.id,
			}, {
				mailWorkClass: WorkClass.QUICK_MUTATION,
			})
			return data
		}
		throw new Error(`Unsupported queued mail mutation: ${operation.type}`)
	}))
}

export async function createEnvelopeTag(displayName, color) {
	const url = generateUrl('/apps/mail/api/tags')

	const { data } = await axios.post(url, { displayName, color })
	return data
}

export async function setEnvelopeTag(id, imapLabel) {
	const url = generateUrl('/apps/mail/api/messages/{id}/tags/{imapLabel}', {
		id,
		imapLabel,
	})

	const { data } = await axios.put(url)
	return data
}
export async function updateEnvelopeTag(id, displayName, color) {
	const url = generateUrl('/apps/mail/api/tags/{id}', {
		id,
	})

	await axios.put(url, { displayName, color })
}

export async function deleteTag(id, accountId) {
	const url = generateUrl('/apps/mail/api/tags/{accountId}/delete/{id}', {
		accountId,
		id,
	})

	await axios.delete(url)
}

export async function removeEnvelopeTag(id, imapLabel) {
	const url = generateUrl('/apps/mail/api/messages/{id}/tags/{imapLabel}', {
		id,
		imapLabel,
	})

	const { data } = await axios.delete(url)
	return data
}

export async function fetchMessage(id, { signal, speculative = false } = {}) {
	const url = generateUrl('/apps/mail/api/messages/{id}/body', {
		id,
	})

	try {
		// A visible message load gets two short, bounded retries when reserved
		// capacity is briefly exhausted. Speculative prefetch remains one-shot
		// so it can never compete with the user's current action.
		const resp = speculative
			? await axios.get(url, {
					signal,
					mailWorkClass: WorkClass.SPECULATIVE,
					mailRequestKey: messageBodyRequestKey(id),
				})
			: await fetchActiveMessage(url, id, signal)
		return resp.data
	} catch (error) {
		if (error.response && error.response.status === 404) {
			return undefined
		}
		if (axios.isCancel(error)) {
			// A timeout/abort is not a server error response -- rethrow
			// as-is so callers can tell the two apart.
			throw error
		}
		if (!error.response) {
			// A network failure that isn't a recognized cancel -- e.g. the
			// browser itself killing an in-flight request when the tab is
			// backgrounded on mobile (confirmed live, Android). Still no
			// HTTP response to parse; rethrow the original error rather
			// than crash reading .headers off nothing.
			throw error
		}

		const parsed = parseErrorResponse(error.response)
		if (ACTIVE_MESSAGE_FETCH_RETRY_STATUSES.has(error.response.status)) {
			// Let the UI distinguish temporary capacity/network failures from
			// a genuine 404. Axios response bodies do not consistently carry
			// a user-facing message, which previously rendered as "Not found".
			parsed.isTransient = true
			parsed.httpStatus = error.response.status
		}
		throw parsed
	}
}

export async function fetchMessageHtmlBody(id) {
	const url = generateUrl('/apps/mail/api/messages/{id}/html?plain=true', {
		id,
	})

	try {
		return (await axios.get(url, {
			mailWorkClass: WorkClass.ACTIVE_CONTENT,
		})).data
	} catch (e) {
		throw convertAxiosError(e)
	}
}

function parseSupplementaryError(error) {
	const parsed = parseErrorResponse(error.response)
	if (parsed === null || typeof parsed !== 'object') {
		return parsed
	}

	const status = error.response.status
	return {
		...parsed,
		httpStatus: status,
		// Capacity rejection is expected load shedding for supplementary
		// metadata. Preserve that distinction after parseErrorResponse()
		// removes the Axios response wrapper so the component can stop the
		// rest of the same enrichment chain without logging a false error.
		...([425, 429].includes(status) ? { isTransient: true } : {}),
	}
}

/**
 * Ask the server to warm the body cache for several messages at once.
 *
 * Not an optimisation of the network -- it is one HTTP request instead of ten,
 * but that was never the expensive part. Every body request opens its own IMAP
 * connection and logs in, because PHP-FPM shares nothing between requests, and
 * Gmail throttles on login rate. Measured on this install: 212 distinct
 * messages opened in a day cost 230 live IMAP fetches and Gmail began refusing
 * to authenticate, which surfaces as "Mail server denied authentication" and
 * reads exactly like a wrong password.
 *
 * The server fetches this batch over a single connection. Ten messages, one
 * login.
 *
 * SPECULATIVE on purpose: this is work for messages not on screen, and being
 * dropped outright under foreground pressure is the correct outcome. It must
 * never take a slot from the body the user is actually waiting for.
 *
 * Failure is silent by contract. A prefetch that does not happen costs a
 * slower open later, nothing else, and the real fetch reports any genuine
 * problem.
 *
 * @param {number[]} ids message database ids, at most ten are honoured
 * @param {object} options options
 * @param {AbortSignal} options.signal abort signal
 * @return {Promise<void>}
 */
export async function prefetchMessageBodies(ids, { signal } = {}) {
	if (!ids || ids.length === 0) {
		return
	}

	const url = generateUrl('/apps/mail/api/messages/prefetch')

	try {
		await axios.post(url, { ids }, {
			signal,
			// PREFETCH, not SPECULATIVE. Speculative requests are rejected
			// outright whenever any foreground request is in flight, which
			// while triaging is always -- .94 shipped that way and never made
			// a single call. Prefetch queues instead and runs in the pauses.
			mailWorkClass: WorkClass.PREFETCH,
		})
	} catch (error) {
		// Deliberately swallowed, including capacity rejections and aborts.
		logger.debug('Prefetching message bodies did not complete', { error })
	}
}

export async function fetchMessageItineraries(id, { signal } = {}) {
	const url = generateUrl('/apps/mail/api/messages/{id}/itineraries', {
		id,
	})

	try {
		const resp = await axios.get(url, {
			signal,
			// Itinerary extraction enriches an already-rendered message. It
			// must yield to bodies, attachments and direct mutations rather
			// than occupying one of their browser-side request slots.
			mailWorkClass: WorkClass.SPECULATIVE,
		})
		return resp.data
	} catch (error) {
		if (error.response && error.response.status === 404) {
			return undefined
		}
		if (!error.response) {
			// No HTTP response at all -- a genuine network failure (see
			// fetchMessage() above for the reasoning). Rethrow the
			// original error rather than crash reading .headers off
			// nothing.
			throw error
		}

		throw parseSupplementaryError(error)
	}
}

export async function fetchMessageDkim(id, { signal } = {}) {
	const url = generateUrl('/apps/mail/api/messages/{id}/dkim', {
		id,
	})

	try {
		const resp = await axios.get(url, {
			signal,
			// DKIM details are useful secondary metadata, not a prerequisite
			// for displaying the message body.
			mailWorkClass: WorkClass.SPECULATIVE,
		})
		return resp.data
	} catch (error) {
		if (error.response && error.response.status === 404) {
			return undefined
		}
		if (!error.response) {
			// No HTTP response at all -- a genuine network failure (see
			// fetchMessage() above for the reasoning). Rethrow the
			// original error rather than crash reading .headers off
			// nothing.
			throw error
		}

		throw parseSupplementaryError(error)
	}
}

export async function saveDraft(accountId, data) {
	const url = generateUrl('/apps/mail/api/accounts/{accountId}/draft', {
		accountId,
	})

	try {
		return (await axios.post(url, data)).data
	} catch (e) {
		throw convertAxiosError(e)
	}
}

export async function deleteMessage(id) {
	const url = generateUrl('/apps/mail/api/messages/{id}', {
		id,
	})

	try {
		return (await axios.delete(url, {
			mailWorkClass: WorkClass.QUICK_MUTATION,
		})).data
	} catch (e) {
		throw convertAxiosError(e)
	}
}

export function moveMessage(id, destFolderId) {
	const url = generateUrl('/apps/mail/api/messages/{id}/move', {
		id,
	})

	return axios.post(url, {
		destFolderId,
	}, {
		mailWorkClass: WorkClass.QUICK_MUTATION,
	})
}

export async function saveMessage(id, directory) {
	const url = generateUrl('/apps/mail/api/messages/{id}/file', {
		id,
	})

	return await axios.post(url, {
		targetPath: directory,
	})
}

export function snoozeMessage(id, unixTimestamp, destMailboxId) {
	const url = generateUrl('/apps/mail/api/messages/{id}/snooze', {
		id,
	})

	return axios.post(url, {
		unixTimestamp,
		destMailboxId,
	}, {
		mailWorkClass: WorkClass.QUICK_MUTATION,
	})
}

export function unSnoozeMessage(id) {
	const url = generateUrl('/apps/mail/api/messages/{id}/unsnooze', {
		id,
	})

	return axios.post(url, {}, {
		mailWorkClass: WorkClass.QUICK_MUTATION,
	})
}

export async function sendMdn(id, data) {
	const url = generateUrl('/apps/mail/api/messages/{id}/mdn', {
		id,
	})

	try {
		await axios.post(url, data)
	} catch (e) {
		throw convertAxiosError(e)
	}
}
