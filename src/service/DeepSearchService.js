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
 * Mirrors DeepSearchService::stripBodyTerms() on the server.
 *
 * @param filter
 */
export function stripBodyTerms(filter) {
	return (filter ?? '')
		.replace(/(?:^|\s)body:\S+/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Is it worth searching headers separately from bodies?
 *
 * Only when something text-like survives the strip. A filter whose only text
 * predicate is `body:` would strip down to its structural tokens alone
 * (`not:starred is:pi-other`), and those match EVERY message rather than none
 * -- a header pass built from that would flood the list with unrelated mail.
 *
 * @param filter
 */
export function worthSplittingFromBody(filter) {
	return hasBodyTerms(filter)
		&& /(?:^|\s)(?:to|from|cc|bcc|subject):\S/i.test(stripBodyTerms(filter))
}

/**
 * Advance one search backwards through history by one bounded stretch.
 *
 * There is no job to start, poll or cancel. The response carries a
 * continuation token; asking again continues, and not asking ends the search.
 * That is the whole lifecycle -- a closed tab, a reload or a crash all stop it
 * for free, because nothing was created on the server that could outlive them.
 *
 * @param {object} params the search, plus `nextEnd` to continue a previous one
 * @param params.mailboxId
 * @param params.filter
 * @param params.cursor
 * @param params.cursorId
 * @param params.sort
 * @param params.view
 * @param params.limit
 * @param params.prioritySplit
 * @param params.nextEnd
 * @param params.mode
 * @param params.signal
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
