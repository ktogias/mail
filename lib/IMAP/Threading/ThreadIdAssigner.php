<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP\Threading;

use Generator;

/**
 * Walks a built thread forest and stamps each message with its thread's id.
 *
 * Lifted out of AccountSynchronizedThreadUpdaterListener so the equivalence
 * harness can compare a full rebuild against an incremental one using the SAME
 * code the account sync runs. An oracle that reimplements the thing it is
 * checking proves nothing about the thing it is checking.
 *
 * The id is a Message-ID, and for a thread whose root container is a
 * placeholder -- an ancestor referenced but never received -- it is that absent
 * ancestor's Message-ID. ThreadClosure depends on exactly this.
 */
final class ThreadIdAssigner {
	/**
	 * @param Container[] $threads
	 *
	 * @return Generator<int, DatabaseMessage>
	 */
	public static function assign(array $threads, ?string $threadId = null): Generator {
		foreach ($threads as $thread) {
			if (($message = $thread->getMessage()) !== null) {
				/** @var DatabaseMessage $message */
				if ($threadId === null) {
					// No parent -> let's use own ID
					$message->setThreadRootId($message->getId());
				} else {
					$message->setThreadRootId($threadId);
				}
				if ($message->isDirty()) {
					yield $message;
				}
			}

			yield from self::assign(
				$thread->getChildren(),
				$threadId ?? ($message === null ? $thread->getId() : $message->getId()),
			);
		}
	}
}
