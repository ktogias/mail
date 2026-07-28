<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Listener;

use OCA\Mail\AppInfo\Application;
use OCA\Mail\Contracts\IUserPreferences;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Events\SynchronizationEvent;
use OCA\Mail\IMAP\Threading\DatabaseMessage;
use OCA\Mail\IMAP\Threading\ThreadBuilder;
use OCA\Mail\IMAP\Threading\ThreadIdAssigner;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IConfig;
use function array_chunk;
use function gc_collect_cycles;
use function iterator_to_array;

/**
 * @template-implements IEventListener<Event|SynchronizationEvent>
 */
class AccountSynchronizedThreadUpdaterListener implements IEventListener {
	private const WRITE_IDS_CHUNK_SIZE = 500;
	private const LAST_FULL_REBUILD_PREFIX = 'threads-rebuilt-at-';
	private const FULL_REBUILD_INTERVAL_SECONDS = 24 * 60 * 60;

	public function __construct(
		private IUserPreferences $preferences,
		private MessageMapper $mapper,
		private ThreadBuilder $builder,
		private IConfig $config,
		private ITimeFactory $timeFactory,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!($event instanceof SynchronizationEvent)) {
			// Unrelated
			return;
		}
		$logger = $event->getLogger();
		$userId = $event->getAccount()->getUserId();

		if ($this->preferences->getPreference($userId, 'layout-message-view', 'threaded') !== 'threaded') {
			$event->getLogger()->debug('Skipping threading as the user prefers a flat view');
			return;
		}

		if (!$event->isRebuildThreads()) {
			$event->getLogger()->debug('Skipping threading as there were no significant changes');
			return;
		}

		// Never in a browser request. This pass loads every message of the
		// account -- 274MB and ~6s here -- and the only reason it still exists
		// is ThreadBuilder's step 5, subject-only merges that no closure can
		// reach. Nobody should wait on that while opening a mailbox.
		//
		// Account-wide syncs come from SyncJob on cron and from occ; the web
		// path syncs one mailbox at a time and dispatches with the flag unset.
		// So this costs cron nothing it was not already paying, and adds no
		// queue and no new way to fail.
		if (!$event->isBackgroundSync()) {
			$event->getLogger()->debug('Skipping full thread rebuild outside a background sync');
			return;
		}

		$accountId = $event->getAccount()->getId();

		// This is now the RECONCILIATION pass, not the hot path.
		// IncrementalThreadUpdaterListener threads each batch of new messages
		// against just the threads it can reach, which is exact for everything
		// except ThreadBuilder's step 5 -- subject-only merges between threads
		// that reference nothing of each other, which no closure can reach.
		//
		// Running the full rebuild after every sync to catch those cost 274MB
		// and ~6s per sync of this account (measured 2026-07-28, 169,970
		// messages), inside whichever request happened to trigger it. Once a
		// day is enough for a merge heuristic that most clients omit entirely
		// -- see the note in ThreadBuilder::groupBySubject().
		$now = $this->timeFactory->getTime();
		$lastFullRebuild = (int)$this->config->getAppValue(
			Application::APP_ID,
			self::LAST_FULL_REBUILD_PREFIX . $accountId,
			'0',
		);
		if ($now - $lastFullRebuild < self::FULL_REBUILD_INTERVAL_SECONDS) {
			$logger->debug("Skipping full thread rebuild for account $accountId, reconciled recently");
			return;
		}

		$logger->debug("Building threads for account $accountId");
		$messages = $this->mapper->findThreadingData($event->getAccount());
		$nMessages = count($messages);
		$logger->debug("Account $accountId has $nMessages messages with threading information");
		$threads = $this->builder->build($messages, $logger);
		$nThreads = count($threads);
		$logger->debug("Account $accountId has $nThreads threads");
		/** @var DatabaseMessage[] $flattened */
		$flattened = iterator_to_array(ThreadIdAssigner::assign($threads), false);
		$nFlattened = count($flattened);
		$logger->debug("Account $accountId has $nFlattened messages with a new thread IDs");
		$chunkSize = self::WRITE_IDS_CHUNK_SIZE;
		foreach (array_chunk($flattened, self::WRITE_IDS_CHUNK_SIZE) as $chunk) {
			$this->mapper->writeThreadIds($chunk);

			$logger->debug("Chunk of $chunkSize messages updated");
		}

		// Recorded only on success: a rebuild that threw must not push the
		// next attempt a day out.
		$this->config->setAppValue(
			Application::APP_ID,
			self::LAST_FULL_REBUILD_PREFIX . $accountId,
			(string)$now,
		);

		// Free memory
		unset($flattened, $threads, $messages);
		gc_collect_cycles();
	}
}
