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

/**
 * Find every still-unread copy shadowed by the READ messages of a thread.
 *
 * findShadowedUnreadCopies() answers this for one envelope, and is called when
 * that envelope is expanded. That leaves a hole .132 showed live: a copy whose
 * visible twin was read long ago is only ever tidied if someone expands that
 * twin again. In a 327-message conversation the thread opens on its newest
 * message, the read twin stays collapsed three hundred rows up, and the hidden
 * copy keeps the whole thread bold in the list forever -- while every message
 * the thread view shows is already read, so nothing on screen explains why.
 *
 * A visible copy that is READ stands for its hidden copies, which is the
 * contract above. A visible copy that is UNREAD does not: it will be expanded
 * and read in its own right, and its copies follow it then. Only the first
 * kind is answered here, so this never marks anything read that the user has
 * not already read in some copy.
 *
 * One pass over the known envelopes rather than one per visible message: a
 * long thread times a large store is the case this exists for.
 *
 * @param {object[]} envelopes every envelope currently known
 * @param {object[]} visible the messages the thread view renders
 * @return {number[]} database ids of the unread copies they stand for
 */
export function findShadowedUnreadCopiesOfThread(envelopes, visible) {
	if (!Array.isArray(envelopes) || !Array.isArray(visible) || visible.length === 0) {
		return []
	}

	const visibleIds = new Set()
	const readKeys = new Set()
	for (const envelope of visible) {
		if (!envelope) {
			continue
		}
		visibleIds.add(envelope.databaseId)
		if (envelope.messageId && envelope.flags?.seen === true) {
			readKeys.add(`${envelope.accountId}\u0000${envelope.messageId}`)
		}
	}
	if (readKeys.size === 0) {
		return []
	}

	return envelopes
		.filter((other) => other
			&& other.messageId
			&& other.flags?.seen === false
			&& !visibleIds.has(other.databaseId)
			&& readKeys.has(`${other.accountId}\u0000${other.messageId}`))
		.map((other) => other.databaseId)
}
