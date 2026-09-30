<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
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
use OCP\BackgroundJob\QueuedJob;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;
use function sleep;

/**
 * Repair ONE mailbox whose cache is provably out of step with IMAP.
 *
 * RepairSyncJob already reconciles every mailbox of an account, but it is a
 * TimedJob on a seven-day interval: a gap that opens on a Tuesday is invisible
 * until the following weekend, and for that whole time the unread badge (fed by
 * IMAP STATUS) counts a message that no list can show (fed by the cached rows).
 * That is exactly what happened to UID 7404 of a 6441-message INBOX on
 * 2026-09-29.
 *
 * ImapToDbSynchronizer::pruneSyncCriteria already has proof of such a gap in
 * hand on every single poll -- the STATUS message count against the local row
 * count -- so it queues this job instead of discarding the finding. One
 * mailbox, one cron cycle, no waiting for the weekly sweep.
 */
class RepairMailboxJob extends QueuedJob {
	/** @var int How many times to try taking the mailbox's sync locks */
	public const MAX_LOCK_ATTEMPTS = 3;

	/** @var int Long enough for an in-flight routine sync pass to finish */
	public const LOCK_RETRY_DELAY_SECONDS = 10;

	public function __construct(
		ITimeFactory $time,
		private SyncService $syncService,
		private AccountService $accountService,
		private MailboxMapper $mailboxMapper,
		private IUserManager $userManager,
		private IEventDispatcher $dispatcher,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);
	}

	#[\Override]
	protected function run($argument): void {
		$mailboxId = (int)$argument['mailboxId'];

		try {
			$mailbox = $this->mailboxMapper->findById($mailboxId);
		} catch (DoesNotExistException $e) {
			$this->logger->debug("Mailbox <$mailboxId> is gone, nothing to repair");
			return;
		}

		try {
			$account = $this->accountService->findById($mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			$this->logger->debug("Account <{$mailbox->getAccountId()}> is gone, nothing to repair");
			return;
		}

		if (!$account->getMailAccount()->canAuthenticateImap()) {
			$this->logger->debug('No authentication on IMAP possible, skipping mailbox repair');
			return;
		}

		$user = $this->userManager->get($account->getUserId());
		if ($user === null || !$user->isEnabled()) {
			$this->logger->debug(sprintf(
				'Account %d of user %s could not be found or was disabled, skipping mailbox repair',
				$account->getId(),
				$account->getUserId(),
			));
			return;
		}

		for ($attempt = 1; $attempt <= self::MAX_LOCK_ATTEMPTS; $attempt++) {
			try {
				$repaired = $this->syncService->repairSync($account, $mailbox);
				// Only a repair that actually moved rows needs the thread
				// forest rebuilt; a run that finds nothing must not pay for
				// one. Reported at info level either way, because "the
				// detector fired and the repair found nothing" is the signal
				// that the detector itself is wrong.
				$this->logger->info(sprintf(
					'Repaired %d message(s) in mailbox %d after a cache/IMAP mismatch',
					$repaired,
					$mailboxId,
				));
				if ($repaired > 0) {
					$this->dispatcher->dispatchTyped(
						new SynchronizationEvent($account, $this->logger, true, true),
					);
				}
				return;
			} catch (MailboxLockedException $e) {
				// A lock collision only means a routine sync pass is in
				// flight. Those last seconds; this job is queued, so waiting
				// it out is cheaper than dropping the repair and waiting for
				// the detector to fire again.
				if ($attempt === self::MAX_LOCK_ATTEMPTS) {
					$this->logger->warning("Mailbox $mailboxId stayed locked through " . self::MAX_LOCK_ATTEMPTS . ' repair attempts, leaving it for the next detection', [
						'exception' => $e,
					]);
					return;
				}
				$this->pause(self::LOCK_RETRY_DELAY_SECONDS);
			} catch (ServiceException $e) {
				// No retry: unlike a lock collision, an IMAP or DB failure is
				// unlikely to clear in seconds. The detector re-fires on the
				// next poll after the cooldown, so nothing is lost.
				$this->logger->warning("Repair of mailbox $mailboxId failed", [
					'exception' => $e,
				]);
				return;
			}
		}
	}

	/**
	 * Seam for unit tests: sleeping for real would slow the suite down.
	 */
	protected function pause(int $seconds): void {
		sleep($seconds);
	}
}
