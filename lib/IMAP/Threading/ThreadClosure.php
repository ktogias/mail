<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP\Threading;

use function array_filter;
use function array_merge;
use function array_unique;
use function array_values;

/**
 * Which existing threads a batch of new messages can possibly disturb.
 *
 * Rebuilding every thread of an account to absorb a handful of new messages is
 * the whole cost of threading: measured on 2026-07-28, 169,970 messages and
 * 274MB to update threads whose median size is one message. This narrows the
 * input to the threads a batch can actually reach.
 *
 * Two directions, and both are exact rather than heuristic:
 *
 *   FORWARD  - the batch's References name existing messages. Those messages'
 *              threads are in scope, and a single new message naming two of
 *              them merges both.
 *
 *   BACKWARD - existing messages may already reference a message in the batch
 *              as an ancestor we never received. This needs no lookup at all,
 *              which is the pleasant surprise of this schema: ThreadIdAssigner
 *              uses the ROOT CONTAINER'S id as thread_root_id, and for a thread
 *              hanging off a missing ancestor that container is the placeholder
 *              built from the absent Message-ID. Such a thread therefore carries
 *              thread_root_id = the new message's own Message-ID, so listing the
 *              batch's Message-IDs as roots already selects those orphans. A
 *              dedicated reverse lookup was written first and removed once the
 *              harness showed it could not change any answer.
 *
 * What this deliberately does NOT cover is ThreadBuilder's step 5, which merges
 * root-level threads that share a normalised subject with no reference between
 * them. No closure can reach those: the blast radius is not connected. They are
 * left to a periodic full rebuild, and the equivalence harness asserts this gap
 * explicitly rather than letting it be discovered later.
 */
final class ThreadClosure {
	/**
	 * @param string[] $batchMessageIds Message-IDs of the new or changed messages
	 * @param string[] $batchReferences every Message-ID referenced by that batch
	 * @param ThreadClosureRepository $repository
	 *
	 * @return string[] thread_root_ids to rebuild, without duplicates
	 */
	public static function resolve(
		array $batchMessageIds,
		array $batchReferences,
		ThreadClosureRepository $repository,
	): array {
		$forward = $repository->threadRootsOfMessages(
			self::clean($batchReferences),
		);

		// The batch's own Message-IDs are roots in their own right: a thread
		// waiting on one of them as a missing ancestor already carries it as
		// its thread_root_id, and a message that references nothing forms a
		// thread rooted at itself. Both fall out of this one line.
		return self::clean(array_merge($forward, $batchMessageIds));
	}

	/**
	 * @param string[] $ids
	 *
	 * @return string[]
	 */
	private static function clean(array $ids): array {
		return array_values(array_unique(array_filter(
			$ids,
			static fn (?string $id): bool => $id !== null && $id !== '',
		)));
	}
}
