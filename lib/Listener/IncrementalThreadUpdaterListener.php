<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Listener;

use OCA\Mail\Account;
use OCA\Mail\Contracts\IUserPreferences;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Events\NewMessagesSynchronized;
use OCA\Mail\IMAP\Threading\DatabaseMessage;
use OCA\Mail\IMAP\Threading\ThreadBuilder;
use OCA\Mail\IMAP\Threading\ThreadClosure;
use OCA\Mail\IMAP\Threading\ThreadClosureRepository;
use OCA\Mail\IMAP\Threading\ThreadIdAssigner;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use Psr\Log\LoggerInterface;
use function array_chunk;
use function array_filter;
use function array_map;
use function array_merge;
use function array_values;
use function count;
use function iterator_to_array;

/**
 * Threads a batch of newly arrived messages without rebuilding the account.
 *
 * The full rebuild that used to run after every sync loaded every message of
 * the account and rebuilt the whole JWZ forest: measured on 2026-07-28,
 * 169,970 messages and 274MB at ~6s, inside the web request the user was
 * waiting on, and identically whether one message had arrived or a thousand.
 * Median thread size on that account is one message.
 *
 * This narrows the input to the threads the batch can actually reach -- see
 * ThreadClosure for why the two directions are exact and what they leave out.
 * The subject-only merges of ThreadBuilder's step 5 are NOT reachable from any
 * closure, so the periodic full rebuild remains the thing that reconciles
 * those; this listener does not replace it, it keeps it off the hot path.
 *
 * @template-implements IEventListener<Event|NewMessagesSynchronized>
 */
class IncrementalThreadUpdaterListener implements IEventListener {
	private const WRITE_IDS_CHUNK_SIZE = 500;

	public function __construct(
		private MessageMapper $mapper,
		private ThreadBuilder $builder,
		private IUserPreferences $preferences,
		private LoggerInterface $logger,
	) {
	}

	public function handle(Event $event): void {
		if (!($event instanceof NewMessagesSynchronized)) {
			return;
		}

		$account = $event->getAccount();
		$userId = $account->getUserId();
		if ($this->preferences->getPreference($userId, 'layout-message-view', 'threaded') !== 'threaded') {
			return;
		}

		// Only messages that take part in a reply chain can change any thread.
		// One with no references is rooted at itself, which is exactly what
		// toDbMessage() already wrote at insert, and findThreadingData()
		// excludes them from the full rebuild for the same reason.
		$batch = array_values(array_filter(
			$event->getMessages(),
			static fn ($message): bool => $message->getMessageId() !== null
				&& ($message->getInReplyTo() !== null || ($message->getReferences() ?? '[]') !== '[]'),
		));
		if ($batch === []) {
			return;
		}

		$threadingBatch = array_map(
			static fn ($message): DatabaseMessage => DatabaseMessage::fromRowData(
				$message->getId(),
				$message->getSubject() ?? '',
				$message->getMessageId(),
				$message->getReferences(),
				$message->getInReplyTo(),
				$message->getThreadRootId(),
			),
			$batch,
		);

		$roots = ThreadClosure::resolve(
			array_map(static fn (DatabaseMessage $m): string => $m->getId(), $threadingBatch),
			array_merge([], ...array_map(static fn (DatabaseMessage $m): array => $m->getReferences(), $threadingBatch)),
			$this->repositoryFor($account),
		);

		// The batch itself is already in the database by the time this runs, so
		// fetching by root picks it up along with everything it can reach; no
		// separate merge, and no chance of threading a stale copy of a message
		// against a fresh copy of its neighbours.
		$closure = $this->mapper->findThreadingDataForRoots($account, $roots);
		if ($closure === []) {
			return;
		}

		$threads = $this->builder->build($closure, $this->logger);
		/** @var DatabaseMessage[] $flattened */
		$flattened = iterator_to_array(ThreadIdAssigner::assign($threads), false);
		foreach (array_chunk($flattened, self::WRITE_IDS_CHUNK_SIZE) as $chunk) {
			$this->mapper->writeThreadIds($chunk);
		}

		$this->logger->debug(sprintf(
			'Threaded %d messages across %d threads for %d new messages',
			count($closure),
			count($roots),
			count($threadingBatch),
		));
	}

	private function repositoryFor(Account $account): ThreadClosureRepository {
		$mapper = $this->mapper;
		return new class($mapper, $account) implements ThreadClosureRepository {
			public function __construct(
				private MessageMapper $mapper,
				private Account $account,
			) {
			}

			public function threadRootsOfMessages(array $messageIds): array {
				return $this->mapper->findThreadRootsOfMessageIds($this->account, $messageIds);
			}
		};
	}
}
