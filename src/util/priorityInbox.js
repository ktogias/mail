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
