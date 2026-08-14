/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { WorkClass } from './RequestCoordinator.js'

/** Header terms only: local database, no IMAP. */
export const MODE_HEADERS = 'headers'
/** The filter as typed, body terms included: one IMAP round trip. */
export const MODE_BODY = 'body'

export const hasBodyTerms = (filter) => /(?:^|\s)body:\S/i.test(filter ?? '')

/**
 * Advance one search backwards through history by one bounded stretch.
 *
 * There is no job to start, poll or cancel. The response carries a
 * continuation token; asking again continues, and not asking ends the search.
 * That is the whole lifecycle -- a closed tab, a reload or a crash all stop it
 * for free, because nothing was created on the server that could outlive them.
 *
 * @param {object} params the search, plus `nextEnd` to continue a previous one
 * @return {Promise<object>} results and the token for the next stretch
 */
export async function deepSearch({
	mailboxId,
	filter,
	cursor,
	cursorId,
	sort,
	view,
	limit,
	prioritySplit = false,
	nextEnd = null,
	mode = MODE_HEADERS,
	signal,
}) {
	const response = await axios.post(generateUrl('/apps/mail/api/deep-search'), {
		mailboxId,
		filter,
		cursor,
		cursorId,
		sort,
		view,
		limit,
		prioritySplit,
		nextEnd,
		mode,
	}, {
		signal,
		mailWorkClass: WorkClass.MAINTENANCE,
	})
	return {
		...response.data,
		results: (response.data.results ?? []).map((envelope) => ({
			accountId: response.data.accountId,
			...envelope,
		})),
	}
}
