/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
	getPrioritySearchQueries,
	priorityImportantQuery,
	priorityInboxBaseQuery,
	priorityInboxSectionQueries,
	priorityOtherQuery,
} from '../../../util/priorityInbox.js'

describe('priorityInbox', () => {
	it('has correct query constants', () => {
		expect(priorityImportantQuery).toEqual('is:pi-important')
		expect(priorityOtherQuery).toEqual('is:pi-other')
	})

	it('returns all queries', () => {
		expect(getPrioritySearchQueries()).toEqual([
			'is:pi-important',
			'is:pi-other',
		])
	})

	it('builds the exact active compound keys around the canonical user filter', () => {
		const search = 'flags:unread match:allof not:starred'

		expect(priorityInboxBaseQuery(search)).toBe('flags:unread match:allof')
		expect(priorityInboxSectionQueries(search, true)).toEqual({
			favorite: 'flags:unread match:allof is:starred',
			important: 'flags:unread match:allof not:starred is:pi-important',
			other: 'flags:unread match:allof not:starred is:pi-other',
		})
	})

	it('does not retain a stale not:starred partition when Favorites are not separate', () => {
		expect(priorityInboxSectionQueries('not:starred', false)).toEqual({
			important: 'is:pi-important',
			other: 'is:pi-other',
		})
	})
})
