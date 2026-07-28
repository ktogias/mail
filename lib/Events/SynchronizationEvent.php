<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Events;

use OCA\Mail\Account;
use OCP\EventDispatcher\Event;
use Psr\Log\LoggerInterface;

class SynchronizationEvent extends Event {
	/**
	 * @param bool $backgroundSync true when this came from an account-wide
	 *                             sync -- SyncJob on cron, or occ -- rather
	 *                             than from a single mailbox sync triggered by
	 *                             a browser. Only the former may pay for the
	 *                             full thread reconciliation.
	 */
	public function __construct(
		private Account $account,
		private LoggerInterface $logger,
		private bool $rebuildThreads,
		private bool $backgroundSync = false,
	) {
		parent::__construct();
	}

	public function isBackgroundSync(): bool {
		return $this->backgroundSync;
	}

	public function getAccount(): Account {
		return $this->account;
	}

	public function getLogger(): LoggerInterface {
		return $this->logger;
	}

	public function isRebuildThreads(): bool {
		return $this->rebuildThreads;
	}
}
