/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Copies of a message the thread view hides behind the one it renders.
 *
 * Thread.vue's dedupeFolderCopies() keeps exactly one row per Message-ID, so
 * the same mail delivered twice is presented as a single message. The copies
 * it drops are never rendered, so they can never be opened, so nothing ever
 * marks them read -- while the thread's unread aggregate still counts them.
 *
 * The live case: a meeting invitation arrived directly and again through the
 * [OOP_TSC] mailing list, one minute apart, in the same INBOX. Both carry the
 * identical Message-ID, and the list only rewrote the Subject. The thread
 * header said "1 message"; the blue unread dot never cleared no matter how
 * many times it was opened, because the copy being read was not the copy
 * keeping the dot alive.
 *
 * Presenting N copies as one message means reading it reads all of them. That
 * is the contract this restores.
 */

/**
 * Find the still-unread copies shadowed by an envelope.
 *
 * Scoped to the same account, matching the dedup it mirrors: the original case
 * dedupeFolderCopies() was written for is one message appearing in INBOX and
 * in a special view like [Gmail]/Important, which are different mailboxes of
 * the same account. Crossing accounts would be a different message that merely
 * shares an id.
 *
 * @param {object[]} envelopes every envelope currently known
 * @param {object} envelope the copy that was read
 * @return {number[]} database ids of the unread copies it stands for
 */
export function findShadowedUnreadCopies(envelopes, envelope) {
	if (!envelope?.messageId || !Array.isArray(envelopes)) {
		return []
	}

	return envelopes
		.filter((other) => other
			&& other.databaseId !== envelope.databaseId
			&& other.messageId === envelope.messageId
			&& other.accountId === envelope.accountId
			&& other.flags?.seen === false)
		.map((other) => other.databaseId)
}
