/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Search query for important and unread messages inside priority inbox */
export const priorityImportantQuery = 'is:pi-important'

/** Search query for other messages inside priority inbox */
export const priorityOtherQuery = 'is:pi-other'

const prioritySectionTokens = new Set([
	'is:starred',
	'not:starred',
	priorityImportantQuery,
	priorityOtherQuery,
])

/**
 * Return an array of all search queries inside the priority inbox
 *
 * @return {(string)[]}
 */
export function getPrioritySearchQueries() {
	return [
		priorityImportantQuery,
		priorityOtherQuery,
	]
}

/**
 * Remove the structural Priority-section predicate from the user's current
 * search. The backend's prioritySplit query applies Favorite -> Important ->
 * Other itself, so splitting an already section-filtered query would make two
 * of the three result partitions empty.
 *
 * @param {string|undefined} query
 * @return {string|undefined}
 */
export function priorityInboxBaseQuery(query) {
	const base = (query ?? '')
		.split(/\s+/)
		.filter(Boolean)
		.filter((token) => !prioritySectionTokens.has(token))
		.join(' ')
	return base || undefined
}

/**
 * Build the exact envelope-list keys rendered by MailboxThread. Keeping this
 * in one utility prevents resume/pull refresh from updating a bare
 * is:pi-other bucket while the screen is actually reading a compound key such
 * as "flags:unread match:allof not:starred is:pi-other".
 *
 * @param {string|undefined} searchQuery
 * @param {boolean} sortFavorites
 * @return {{favorite?: string, important: string, other: string}}
 */
export function priorityInboxSectionQueries(searchQuery, sortFavorites) {
	const baseTokens = (searchQuery ?? '')
		.split(/\s+/)
		.filter(Boolean)
		.filter((token) => !prioritySectionTokens.has(token))
	const partitionedBase = sortFavorites ? [...baseTokens, 'not:starred'] : baseTokens
	const append = (token) => [...partitionedBase, token].join(' ')
	const queries = {
		important: append(priorityImportantQuery),
		other: append(priorityOtherQuery),
	}

	if (sortFavorites) {
		queries.favorite = [...baseTokens, 'is:starred'].join(' ')
	}

	return queries
}

/**
 * THE single client-side reading of "does this thread carry <flag>".
 *
 * Every surface that decides which Priority section something belongs to
 * must go through here. This one expression used to be written out
 * verbatim in four places in mainStore/actions.js alone, next to four
 * separate classifiers, and each copy was corrected only when a screenshot
 * exposed it: .25 fixed list membership, .26 the thread aggregates, .28 the
 * counters -- the same decision, three layers, three separate bugs.
 *
 * In threaded mode the thread-wide aggregate the server computes is the
 * authority; the per-message flag is only the fallback for an envelope that
 * arrived without one, and the whole reading in the flat view.
 *
 * @param {object} flags an envelope's flags
 * @param {'flagged'|'important'} flag the per-message flag
 * @param {boolean} threaded whether the threaded view is active
 * @return {boolean}
 */
export function threadCarriesFlag(flags, flag, threaded) {
	const perMessage = (flags ?? {})[flag] === true
	if (!threaded) {
		return perMessage
	}
	const aggregate = flag === 'flagged'
		? (flags ?? {}).hasFlaggedInThread
		: (flags ?? {}).hasImportantInThread
	return aggregate ?? perMessage
}

/**
 * The unread counterpart of threadCarriesFlag(). Kept beside it so the two
 * cannot drift into different notions of "thread-wide".
 *
 * @param {object} flags an envelope's flags
 * @param {boolean} threaded whether the threaded view is active
 * @return {boolean}
 */
export function threadIsUnread(flags, threaded) {
	const perMessage = (flags ?? {}).seen === false
	if (!threaded) {
		return perMessage
	}
	return (flags ?? {}).hasUnseenInThread ?? perMessage
}

/**
 * Classify an envelope into a Priority Inbox section.
 *
 * Mirrors MessageMapper::getPriorityInboxStats() exactly, including the
 * `sortFavorites` branch: when favourites are NOT sorted separately the
 * server has no favourite bucket at all and a starred message is bucketed
 * purely by importance. A shared fixture asserts both implementations agree
 * -- see tests/fixtures/priority-section-contract.json.
 *
 * @param {object} envelope the envelope to classify
 * @param {object} options
 * @param {boolean} options.threaded whether the threaded view is active
 * @param {boolean} options.sortFavorites whether favourites get their own section
 * @return {'favorite'|'important'|'other'}
 */
export function classifyPrioritySection(envelope, { threaded, sortFavorites }) {
	const flags = envelope?.flags ?? {}
	const important = threadCarriesFlag(flags, 'important', threaded)
	if (sortFavorites && threadCarriesFlag(flags, 'flagged', threaded)) {
		return 'favorite'
	}
	return important ? 'important' : 'other'
}
