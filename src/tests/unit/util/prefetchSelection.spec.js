/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'
import {
	PREFETCH_LIMIT,
	selectPrefetchIds,
	updateDirection,
} from '../../../util/prefetchSelection.js'

/**
 * @param {number} n how many
 * @param {number[]} unreadIds which ids are unread
 * @return {object[]} a list in display order, newest first
 */
function list(n, unreadIds = []) {
	return Array.from({ length: n }, (_, i) => ({
		databaseId: i + 1,
		flags: { seen: !unreadIds.includes(i + 1) },
	}))
}

describe('prefetch selection', () => {
	it('warms both sides of the open message', () => {
		// The two patterns worth supporting are opposites -- reading down from
		// the newest, and climbing back up from the oldest unread -- so a
		// prefetcher that only looks one way is wrong for one of them.
		const ids = selectPrefetchIds({ envelopes: list(40), anchorId: 20 })

		expect(ids.some((id) => id > 20)).toBe(true)
		expect(ids.some((id) => id < 20)).toBe(true)
		expect(ids).not.toContain(20)
		expect(ids).toHaveLength(PREFETCH_LIMIT)
	})

	it('favours the direction of travel without abandoning the other', () => {
		const down = selectPrefetchIds({ envelopes: list(40), anchorId: 20, direction: 'down' })
		const up = selectPrefetchIds({ envelopes: list(40), anchorId: 20, direction: 'up' })

		expect(down.filter((id) => id > 20)).toHaveLength(7)
		expect(down.filter((id) => id < 20)).toHaveLength(3)
		expect(up.filter((id) => id < 20)).toHaveLength(7)
		expect(up.filter((id) => id > 20)).toHaveLength(3)
	})

	it('gives a short side its unused slots to the other', () => {
		// Opening the newest message is the single most common case. Three of
		// ten slots would be spent on nothing above it, quietly wasting a
		// third of one IMAP connection every time.
		const ids = selectPrefetchIds({ envelopes: list(40), anchorId: 1, direction: 'down' })

		expect(ids).toHaveLength(PREFETCH_LIMIT)
		expect(ids.every((id) => id > 1)).toBe(true)
	})

	it('skips bodies already held and messages already read', () => {
		const envelopes = list(40, [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])
		const ids = selectPrefetchIds({
			envelopes,
			anchorId: 20,
			direction: 'down',
			unreadOnly: true,
			isKnown: (id) => id === 21,
		})

		expect(ids).not.toContain(21)
		expect(ids.every((id) => id >= 22)).toBe(true)
	})

	it('returns nothing when the anchor is not in the list', () => {
		// The open message can belong to another mailbox, or the list can have
		// been trimmed under it. Guessing a position would warm the wrong mail.
		expect(selectPrefetchIds({ envelopes: list(10), anchorId: 999 })).toEqual([])
	})

	it('never exceeds one connection\'s worth', () => {
		const ids = selectPrefetchIds({ envelopes: list(500), anchorId: 250 })

		expect(ids.length).toBeLessThanOrEqual(PREFETCH_LIMIT)
	})
})

describe('direction tracking', () => {
	it('follows a consistent reader', () => {
		let s = updateDirection(undefined, 5)
		s = updateDirection(s, 6)
		expect(s.direction).toBe('down')

		s = updateDirection(s, 7)
		expect(s.direction).toBe('down')
	})

	it('does not reverse on a single step back', () => {
		// Re-reading the previous message is not a change of plan. A strategy
		// that inverts on one stray tap spends the budget on the end the
		// reader just left.
		let s = updateDirection(undefined, 5)
		s = updateDirection(s, 6)
		s = updateDirection(s, 7)
		expect(s.direction).toBe('down')

		s = updateDirection(s, 6)
		expect(s.direction).toBe('down')
	})

	it('reverses once the reader is clearly going the other way', () => {
		let s = updateDirection(undefined, 5)
		s = updateDirection(s, 6)
		s = updateDirection(s, 5)
		s = updateDirection(s, 4)

		expect(s.direction).toBe('up')
	})

	it('ignores reopening the same message', () => {
		let s = updateDirection(undefined, 5)
		s = updateDirection(s, 6)
		const before = s.direction

		s = updateDirection(s, 6)
		expect(s.direction).toBe(before)
		expect(s.against).toBe(0)
	})
})
