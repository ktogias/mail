/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'
import { findShadowedUnreadCopies, findShadowedUnreadCopiesOfThread } from '../../../util/shadowedCopies.js'

function envelope(databaseId, messageId, seen, accountId = 4) {
	return {
		databaseId,
		messageId,
		accountId,
		flags: { seen },
	}
}

describe('shadowed copies', () => {
	it('finds the unread twin the thread view hides', () => {
		// The live case: the same invitation delivered directly and through a
		// mailing list, one minute apart, same INBOX, same Message-ID. The
		// thread renders one of them, so the other can never be opened and its
		// unread state kept the dot alive forever.
		const envelopes = [
			envelope(2060653, '<PATP264MB6782@outlook.com>', true),
			envelope(2060652, '<PATP264MB6782@outlook.com>', false),
			envelope(9, '<other@example.com>', false),
		]

		expect(findShadowedUnreadCopies(envelopes, envelopes[0])).toEqual([2060652])
	})

	it('ignores copies that are already read', () => {
		const envelopes = [
			envelope(1, '<a@example.com>', true),
			envelope(2, '<a@example.com>', true),
		]

		expect(findShadowedUnreadCopies(envelopes, envelopes[0])).toEqual([])
	})

	it('never crosses accounts', () => {
		// A shared Message-ID across two accounts is two different deliveries
		// to two different mailboxes. Reading one says nothing about the other.
		const envelopes = [
			envelope(1, '<a@example.com>', true, 4),
			envelope(2, '<a@example.com>', false, 13),
		]

		expect(findShadowedUnreadCopies(envelopes, envelopes[0])).toEqual([])
	})

	it('does not match itself', () => {
		const self = envelope(1, '<a@example.com>', false)

		expect(findShadowedUnreadCopies([self], self)).toEqual([])
	})

	it('returns nothing without a Message-ID to group by', () => {
		// Rows with no Message-ID cannot be grouped, and dedupeFolderCopies()
		// keeps them all as-is, so nothing is hidden and nothing is owed.
		const envelopes = [
			envelope(1, undefined, true),
			envelope(2, undefined, false),
		]

		expect(findShadowedUnreadCopies(envelopes, envelopes[0])).toEqual([])
	})
})

describe('shadowed copies of a whole thread', () => {
	it('finds the unread copy hidden behind a read message nobody will expand', () => {
		// The .133 case: the same GitHub review notification delivered twice,
		// fifteen hours apart. The thread shows the read copy; the unread one
		// kept a 327-message thread bold in the list.
		const twin = envelope(2076973, '<review/5337787773@github.com>', true, 3)
		const hidden = envelope(2077442, '<review/5337787773@github.com>', false, 3)
		const newest = envelope(2079189, '<newest@github.com>', true, 3)

		expect(findShadowedUnreadCopiesOfThread([twin, hidden, newest], [twin, newest])).toEqual([2077442])
	})

	it('never marks copies of a message that is unread where it is shown', () => {
		// That message will be expanded and read in its own right, and its
		// copies follow it then. Reading it on the user's behalf here would
		// mark something read that nobody has read in any copy.
		const shown = envelope(1, '<a@example.com>', false)
		const hidden = envelope(2, '<a@example.com>', false)

		expect(findShadowedUnreadCopiesOfThread([shown, hidden], [shown])).toEqual([])
	})

	it('never returns a copy that is itself on screen', () => {
		const a = envelope(1, '<a@example.com>', true)
		const b = envelope(2, '<a@example.com>', false)

		expect(findShadowedUnreadCopiesOfThread([a, b], [a, b])).toEqual([])
	})

	it('stays inside the account, as the dedup it mirrors does', () => {
		const shown = envelope(1, '<a@example.com>', true, 4)
		const elsewhere = envelope(2, '<a@example.com>', false, 5)

		expect(findShadowedUnreadCopiesOfThread([shown, elsewhere], [shown])).toEqual([])
	})

	it('cannot group rows without a Message-ID', () => {
		const shown = envelope(1, undefined, true)
		const other = envelope(2, undefined, false)

		expect(findShadowedUnreadCopiesOfThread([shown, other], [shown])).toEqual([])
	})

	it('is inert on empty or malformed input', () => {
		expect(findShadowedUnreadCopiesOfThread(undefined, [])).toEqual([])
		expect(findShadowedUnreadCopiesOfThread([], undefined)).toEqual([])
		expect(findShadowedUnreadCopiesOfThread([envelope(1, '<a>', false)], [])).toEqual([])
	})
})
