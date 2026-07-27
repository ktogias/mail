/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import contract from '../../../../tests/fixtures/priority-section-contract.json'
import { classifyPrioritySection, threadIsUnread } from '../../../util/priorityInbox.js'

/**
 * The thread aggregates the server sends alongside each envelope: any-member
 * semantics, matching the SQL MAX() rollup in getPriorityInboxStats().
 *
 * @param {Array<object>} messages the thread's members
 * @return {object} the representative envelope the client would receive
 */
function envelopeFor(messages) {
	const newest = messages[messages.length - 1]
	return {
		flags: {
			seen: newest.seen,
			flagged: newest.flagged,
			important: newest.important,
			hasUnseenInThread: messages.some((message) => !message.seen),
			hasFlaggedInThread: messages.some((message) => message.flagged),
			hasImportantInThread: messages.some((message) => message.important),
		},
	}
}

describe('Priority section contract (client side)', () => {
	// The PHP half of this contract lives in
	// tests/Integration/Db/MessageMapperTest.php and reads the same fixture.
	// Both must agree; a change to one that is not mirrored in the other fails
	// here or there rather than in a screenshot three releases later.
	contract.cases.forEach((testCase) => {
		it(`classifies "${testCase.name}" the same way the database aggregate does`, () => {
			const envelope = envelopeFor(testCase.messages)

			expect(classifyPrioritySection(envelope, { threaded: true, sortFavorites: true }))
				.toBe(testCase.sortFavorites.section)
			expect(classifyPrioritySection(envelope, { threaded: true, sortFavorites: false }))
				.toBe(testCase.plain.section)
			expect(threadIsUnread(envelope.flags, true)).toBe(testCase.sortFavorites.unread)
			expect(testCase.plain.unread).toBe(testCase.sortFavorites.unread)
		})
	})

	it('falls back to the per-message flag when the server sent no aggregate', () => {
		// A flat-view envelope, or one that predates the aggregates being sent.
		const envelope = { flags: { seen: false, flagged: false, important: true } }

		expect(classifyPrioritySection(envelope, { threaded: true, sortFavorites: true })).toBe('important')
		expect(classifyPrioritySection(envelope, { threaded: false, sortFavorites: true })).toBe('important')
		expect(threadIsUnread(envelope.flags, true)).toBe(true)
	})

	it('ignores the thread aggregate in the flat view', () => {
		// The row stands for itself there, so a sibling's star must not pull it
		// into Favourites.
		const envelope = { flags: { seen: true, flagged: false, important: false, hasFlaggedInThread: true } }

		expect(classifyPrioritySection(envelope, { threaded: false, sortFavorites: true })).toBe('other')
		expect(classifyPrioritySection(envelope, { threaded: true, sortFavorites: true })).toBe('favorite')
	})
})
