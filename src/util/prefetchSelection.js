/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Which message bodies to warm, given where the reader is and where they are
 * going.
 *
 * All of the judgement lives here, deliberately: no network, no store, no Vue.
 * Every earlier attempt at this feature was reasoned about rather than tested,
 * and two of those four diagnoses were wrong. This file is the part that can
 * be proven.
 *
 * The measurement that produced it: with prefetching anchored to the top ten
 * of the list, 82 messages were opened over fifteen minutes and 79 of them
 * came live from IMAP. The head of the list never moved, because the reader
 * was going DOWN it rather than clearing it from the top, so the prefetcher
 * was asked for work exactly twice. Anchoring on the open message instead is
 * what fixes that.
 */

/** One connection's worth. Bias the split, never raise this: a larger batch
 * holds a worker and an IMAP connection open for longer, which is the cost
 * this whole feature exists to avoid. */
export const PREFETCH_LIMIT = 10

/** How the split moves with the reader. Ahead gets the larger share. */
const SPLIT = Object.freeze({
	down: { ahead: 7, behind: 3 },
	up: { ahead: 3, behind: 7 },
	none: { ahead: 5, behind: 5 },
})

/**
 * Update the direction the reader appears to be moving.
 *
 * Requires two consecutive moves against the current trend before flipping.
 * One jump backwards to re-read something is not a change of direction, and a
 * strategy that inverts on every stray tap is worse than having no strategy:
 * it would spend the budget on whichever end the reader just left.
 *
 * Pure, so the flapping behaviour is testable without a browser.
 *
 * @param {object} state previous state
 * @param {string} [state.direction] 'down' | 'up' | 'none'
 * @param {number} [state.lastIndex] index of the previously opened message
 * @param {number} [state.against] consecutive moves against the trend
 * @param {number} index list index of the message just opened
 * @return {{direction: string, lastIndex: number, against: number}} next state
 */
export function updateDirection({ direction = 'none', lastIndex, against = 0 } = {}, index) {
	if (!Number.isInteger(index)) {
		return { direction, lastIndex, against }
	}
	if (!Number.isInteger(lastIndex) || index === lastIndex) {
		return { direction, lastIndex: index, against }
	}

	// Down the list means further from the top, which is older mail.
	const moved = index > lastIndex ? 'down' : 'up'

	if (direction === 'none' || moved === direction) {
		return { direction: moved, lastIndex: index, against: 0 }
	}
	if (against + 1 >= 2) {
		return { direction: moved, lastIndex: index, against: 0 }
	}
	return { direction, lastIndex: index, against: against + 1 }
}

/**
 * Choose the ids to warm around the open message.
 *
 * Both directions are always covered, because the two reading patterns worth
 * supporting are opposites: working down from the newest, and scrolling to the
 * oldest unread and climbing back up. The direction only decides the split.
 *
 * Whatever one side cannot supply goes to the other. At the top of the list
 * there is nothing behind the anchor, and spending three of ten slots on
 * nothing would quietly waste a third of the budget in the single most common
 * case -- opening the newest message.
 *
 * @param {object} options options
 * @param {object[]} options.envelopes the list, in display order
 * @param {number} options.anchorId databaseId of the open message
 * @param {string} [options.direction] 'down' | 'up' | 'none'
 * @param {boolean} [options.unreadOnly] skip already-read messages
 * @param {number} [options.limit] how many ids at most
 * @param {Function} [options.isKnown] id => true when the body is already held
 * @return {number[]} ids to warm, nearest the anchor first
 */
export function selectPrefetchIds({
	envelopes,
	anchorId,
	direction = 'none',
	unreadOnly = false,
	limit = PREFETCH_LIMIT,
	isKnown = () => false,
} = {}) {
	if (!Array.isArray(envelopes) || envelopes.length === 0 || limit <= 0) {
		return []
	}

	const anchorIndex = envelopes.findIndex((envelope) => envelope?.databaseId === anchorId)
	if (anchorIndex === -1) {
		return []
	}

	const wanted = (envelope) => {
		if (!envelope || !Number.isInteger(envelope.databaseId)) {
			return false
		}
		if (isKnown(envelope.databaseId)) {
			return false
		}
		// `seen` true means read. Skipping read neighbours matters more than it
		// looks: unread density among the newest 200 runs from 72% on the busy
		// account down to 5% on a quiet one, so without this the quiet
		// mailboxes would spend almost the whole budget on mail already read.
		if (unreadOnly && envelope.flags?.seen === true) {
			return false
		}
		return true
	}

	const collect = (step, max) => {
		const found = []
		for (let i = anchorIndex + step; i >= 0 && i < envelopes.length && found.length < max; i += step) {
			if (wanted(envelopes[i])) {
				found.push(envelopes[i].databaseId)
			}
		}
		return found
	}

	const split = SPLIT[direction] ?? SPLIT.none
	// Collect the full limit each way, then take the split from what exists, so
	// a short side can hand its unused slots to the other.
	const ahead = collect(1, limit)
	const behind = collect(-1, limit)

	const takeAhead = Math.min(ahead.length, Math.max(split.ahead, limit - behind.length))
	const takeBehind = Math.min(behind.length, limit - takeAhead)

	// Interleaved nearest-first: the message immediately after the anchor is
	// likelier to be opened next than the seventh one in the favoured
	// direction, whichever way the reader is going.
	const picked = []
	const a = ahead.slice(0, takeAhead)
	const b = behind.slice(0, takeBehind)
	const first = direction === 'up' ? b : a
	const second = direction === 'up' ? a : b
	for (let i = 0; i < Math.max(first.length, second.length); i++) {
		if (i < first.length) {
			picked.push(first[i])
		}
		if (i < second.length) {
			picked.push(second[i])
		}
	}

	return picked.slice(0, limit)
}
