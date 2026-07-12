/**
 * SPDX-FileCopyrightText: 2018 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { curry } from 'ramda'
import { convertAxiosError } from '../errors/convert.js'
import MalformedSyncResponseError from '../errors/MalformedSyncResponseError.js'
import SyncIncompleteError from '../errors/SyncIncompleteError.js'
import { parseErrorResponse } from '../http/ErrorResponseParser.js'
import logger from '../logger.js'

const amendEnvelopeWithIds = curry((accountId, envelope) => ({
	accountId,
	...envelope,
}))

export function fetchEnvelope(accountId, id) {
	const url = generateUrl('/apps/mail/api/messages/{id}', {
		id,
	})

	return axios
		.get(url)
		.then((resp) => resp.data)
		.then(amendEnvelopeWithIds(accountId))
		.catch((error) => {
			if (error.response && error.response.status === 404) {
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

export function fetchEnvelopes(accountId, mailboxId, query, cursor, limit, sort, view, cacheBuster, signal) {
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

	return axios
		.get(url, {
			params,
			signal,
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
}
export async function fetchThread(id, { signal } = {}) {
	const url = generateUrl('apps/mail/api/messages/{id}/thread', {
		id,
	})
	const resp = await axios.get(url, { signal })
	return resp.data
}

export async function syncEnvelopes(accountId, id, ids, lastMessageTimestamp, query, init = false, sortOrder) {
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

/**
 * Set flags for envelope
 *
 * @param {number} id
 * @param {object} flags
 * @return {Promise<{hasUnseenInThread: boolean}>}
 */
export async function setEnvelopeFlags(id, flags) {
	const url = generateUrl('/apps/mail/api/messages/{id}/flags', {
		id,
	})

	const { data } = await axios.put(url, {
		flags,
	})
	return data
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

export async function fetchMessage(id, { signal } = {}) {
	const url = generateUrl('/apps/mail/api/messages/{id}/body', {
		id,
	})

	try {
		const resp = await axios.get(url, { signal })
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

		throw parseErrorResponse(error.response)
	}
}

export async function fetchMessageHtmlBody(id) {
	const url = generateUrl('/apps/mail/api/messages/{id}/html?plain=true', {
		id,
	})

	try {
		return (await axios.get(url)).data
	} catch (e) {
		throw convertAxiosError(e)
	}
}

export async function fetchMessageItineraries(id) {
	const url = generateUrl('/apps/mail/api/messages/{id}/itineraries', {
		id,
	})

	try {
		const resp = await axios.get(url)
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

		throw parseErrorResponse(error.response)
	}
}

export async function fetchMessageDkim(id) {
	const url = generateUrl('/apps/mail/api/messages/{id}/dkim', {
		id,
	})

	try {
		const resp = await axios.get(url)
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

		throw parseErrorResponse(error.response)
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
		return (await axios.delete(url)).data
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
	})
}

export function snoozeMessage(id, unixTimestamp, destMailboxId) {
	const url = generateUrl('/apps/mail/api/messages/{id}/snooze', {
		id,
	})

	return axios.post(url, {
		unixTimestamp,
		destMailboxId,
	})
}

export function unSnoozeMessage(id) {
	const url = generateUrl('/apps/mail/api/messages/{id}/unsnooze', {
		id,
	})

	return axios.post(url, {})
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
