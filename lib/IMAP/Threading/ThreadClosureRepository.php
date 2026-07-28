<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP\Threading;

/**
 * The lookup ThreadClosure needs, kept behind an interface so the
 * equivalence harness can drive it over an in-memory corpus and so the
 * database implementation can be swapped without touching the resolver.
 *
 * One indexed equality lookup on this schema -- mail_messages_msgid_idx on
 * message_id -- and no schema change, which is what makes the incremental path
 * cheap enough to be worth having. The reverse direction needs no query: see
 * ThreadClosure.
 */
interface ThreadClosureRepository {
	/**
	 * thread_root_id of every stored message whose Message-ID is listed.
	 *
	 * @param string[] $messageIds
	 *
	 * @return string[]
	 */
	public function threadRootsOfMessages(array $messageIds): array;
}
