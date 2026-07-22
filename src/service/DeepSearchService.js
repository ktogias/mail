/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

function amendResults(job) {
	return {
		...job,
		results: (job.results ?? []).map((envelope) => ({
			accountId: job.accountId,
			...envelope,
		})),
	}
}

export async function startDeepSearch({ mailboxId, filter, cursor, cursorId, sort, view, limit, prioritySplit = false, signal }) {
	const response = await axios.post(generateUrl('/apps/mail/api/search-jobs'), {
		mailboxId,
		filter,
		cursor,
		cursorId,
		sort,
		view,
		limit,
		prioritySplit,
	}, { signal })
	return amendResults(response.data)
}

export async function getDeepSearch(id, { signal } = {}) {
	const response = await axios.get(generateUrl('/apps/mail/api/search-jobs/{id}', { id }), { signal })
	return amendResults(response.data)
}

export async function cancelDeepSearch(id) {
	await axios.delete(generateUrl('/apps/mail/api/search-jobs/{id}', { id }))
}
