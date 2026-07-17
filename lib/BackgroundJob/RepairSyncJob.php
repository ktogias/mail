<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\BackgroundJob;

use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Events\SynchronizationEvent;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\Sync\SyncService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJobList;
use OCP\BackgroundJob\TimedJob;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;

class RepairSyncJob extends TimedJob {
	/** @var int How many times to try taking a mailbox's sync locks */
	public const MAX_LOCK_ATTEMPTS = 3;

	/** @var int Long enough for an in-flight routine sync pass (seconds on
	 *           the largest mailboxes) to finish and release its locks */
	public const LOCK_RETRY_DELAY_SECONDS = 10;

	public function __construct(
		ITimeFactory $time,
		private SyncService $syncService,
		private AccountService $accountService,
		private IUserManager $userManager,
		private MailboxMapper $mailboxMapper,
		private IJobList $jobList,
		private LoggerInterface $logger,
		private IEventDispatcher $dispatcher,
	) {
		parent::__construct($time);

		$this->setInterval(3600 * 24 * 7);
		$this->setTimeSensitivity(self::TIME_INSENSITIVE);
	}

	#[\Override]
	protected function run($argument): void {
		$accountId = (int)$argument['accountId'];

		try {
			$account = $this->accountService->findById($accountId);
		} catch (DoesNotExistException $e) {
			$this->logger->debug("Could not find account <{$accountId}> removing from jobs");
			$this->jobList->remove(self::class, $argument);
			return;
		}

		if (!$account->getMailAccount()->canAuthenticateImap()) {
			$this->logger->debug('No authentication on IMAP possible, skipping background sync job');
			return;
		}

		$user = $this->userManager->get($account->getUserId());
		if ($user === null || !$user->isEnabled()) {
			$this->logger->debug(sprintf(
				'Account %d of user %s could not be found or was disabled, skipping background sync',
				$account->getId(),
				$account->getUserId()
			));
			return;
		}

		$rebuildThreads = false;
		$trashMailboxId = $account->getMailAccount()->getTrashMailboxId();
		$snoozeMailboxId = $account->getMailAccount()->getSnoozeMailboxId();
		$sentMailboxId = $account->getMailAccount()->getSentMailboxId();
		$junkMailboxId = $account->getMailAccount()->getJunkMailboxId();
		foreach ($this->mailboxMapper->findAll($account) as $mailbox) {
			$isExcluded = [
				$trashMailboxId === $mailbox->getId(),
				$snoozeMailboxId === $mailbox->getId(),
				$sentMailboxId === $mailbox->getId(),
				$junkMailboxId === $mailbox->getId(),
			];
			if (in_array(true, $isExcluded, true)) {
				continue;
			}

			for ($attempt = 1; $attempt <= self::MAX_LOCK_ATTEMPTS; $attempt++) {
				try {
					if ($this->syncService->repairSync($account, $mailbox) > 0) {
						$rebuildThreads = true;
					}
					break;
				} catch (MailboxLockedException $e) {
					// A lock collision only means a routine sync pass of this
					// mailbox is in flight right now. Those passes last
					// seconds; giving up immediately would postpone this
					// mailbox's repair by a whole week for a transient
					// condition, so wait out the in-flight pass and retry a
					// bounded number of times before moving on.
					if ($attempt === self::MAX_LOCK_ATTEMPTS) {
						$this->logger->warning("Mailbox {$mailbox->getId()} stayed locked through " . self::MAX_LOCK_ATTEMPTS . ' repair attempts, leaving it for the next run', [
							'exception' => $e,
						]);
						break;
					}
					$this->pause(self::LOCK_RETRY_DELAY_SECONDS);
				} catch (ServiceException $e) {
					// One broken mailbox must not abort the repair of every
					// mailbox after it in iteration order -- the same
					// starvation shape ImapToDbSynchronizer::syncAccount()
					// already guards against for the regular sync pass. No
					// retry here: unlike a lock collision, a real failure
					// (IMAP error, DB error) is unlikely to clear in seconds.
					$this->logger->warning("Repair sync failed for mailbox {$mailbox->getId()}, continuing with the account's remaining mailboxes", [
						'exception' => $e,
					]);
					break;
				}
			}
		}

		$this->dispatcher->dispatchTyped(
			new SynchronizationEvent($account, $this->logger, $rebuildThreads),
		);
	}

	/**
	 * Seam for unit tests: sleeping for real would slow the suite down.
	 */
	protected function pause(int $seconds): void {
		sleep($seconds);
	}
}
