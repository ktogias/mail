/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest'
import { findShadowedUnreadCopies } from '../../../util/shadowedCopies.js'

const envelope = (databaseId, messageId, seen, accountId = 4) => ({
	databaseId,
	messageId,
	accountId,
	flags: { seen },
})

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
