<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\BackgroundJob;

use Horde_Imap_Client;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\Sync\ImapToDbSynchronizer;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\QueuedJob;
use OCP\IConfig;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;
use Throwable;
use function sleep;

/**
 * Let a mailbox's flag sync catch up once, with the time it actually needs.
 *
 * The flags phase asks the server what changed since its last token. On
 * 2026-10-01 the Gmail INBOX's token had fallen 7,440 changed messages
 * behind: Gmail took 36 s to answer that SEARCH MODSEQ, against a 20 s
 * background read deadline, and 35 s per chunk when restricted to known UIDs
 * (Gmail does not narrow the work). Every attempt failed, so the token never
 * advanced, so the window only grew -- a spiral with no exit. Flags changed on
 * Gmail stopped reaching the cache entirely: the unread badge (IMAP STATUS)
 * said 3, the Unread filter (the cache) said none.
 *
 * With a current token the same SEARCH takes 1.3 s. So the cure is one pass
 * that is allowed to finish: 88 s measured, in cron's CLI rather than an FPM
 * request with a 45 s ceiling, and with a read deadline sized for the stale
 * window rather than for an interactive poll. After it, ordinary polls are
 * cheap again and this job has nothing more to do.
 */
class FlagsCatchUpJob extends QueuedJob {
	/** @var int Read deadline for the catch-up pass, unless configured */
	public const DEFAULT_CATCH_UP_READ_TIMEOUT_SECONDS = 180;

	/** @var int How many times to try taking the mailbox's sync locks */
	public const MAX_LOCK_ATTEMPTS = 3;

	/** @var int Long enough for an in-flight routine sync pass to finish */
	public const LOCK_RETRY_DELAY_SECONDS = 10;

	public function __construct(
		ITimeFactory $time,
		private ImapToDbSynchronizer $synchronizer,
		private IMAPClientFactory $clientFactory,
		private AccountService $accountService,
		private MailboxMapper $mailboxMapper,
		private IUserManager $userManager,
		private IConfig $config,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);
	}

	#[\Override]
	protected function run($argument): void {
		$mailboxId = (int)$argument['mailboxId'];

		try {
			$mailbox = $this->mailboxMapper->findById($mailboxId);
			$account = $this->accountService->findById($mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			$this->logger->debug("Mailbox <$mailboxId> or its account is gone, no flags to catch up");
			return;
		}

		if (!$account->getMailAccount()->canAuthenticateImap()) {
			return;
		}
		$user = $this->userManager->get($account->getUserId());
		if ($user === null || !$user->isEnabled()) {
			return;
		}

		$readTimeout = max(
			1,
			(int)$this->config->getSystemValue('app.mail.imap.catch-up-timeout', self::DEFAULT_CATCH_UP_READ_TIMEOUT_SECONDS),
		);

		for ($attempt = 1; $attempt <= self::MAX_LOCK_ATTEMPTS; $attempt++) {
			// Cron can wait for this account's connection slot; an
			// interactive request could not afford to.
			$client = $this->clientFactory->getClient($account, waitForSlot: true);
			// Both: Horde polls a silent read every `timeout` seconds and gives
			// up at `read_timeout` (see IMAPClientFactory::getClient()).
			$client->setParam('timeout', $readTimeout);
			$client->setParam('read_timeout', $readTimeout);
			try {
				$this->synchronizer->sync(
					$account,
					$client,
					$mailbox,
					$this->logger,
					Horde_Imap_Client::SYNC_FLAGSUIDS,
				);
				$this->logger->info("Flags of mailbox $mailboxId caught up");
				return;
			} catch (MailboxLockedException $e) {
				if ($attempt === self::MAX_LOCK_ATTEMPTS) {
					$this->logger->warning("Mailbox $mailboxId stayed locked through " . self::MAX_LOCK_ATTEMPTS . ' flag catch-up attempts, leaving it for the next failure to re-queue', [
						'exception' => $e,
					]);
					return;
				}
				$this->pause(self::LOCK_RETRY_DELAY_SECONDS);
			} catch (Throwable $e) {
				// A server that cannot answer even with this much time will
				// fail the next routine pass too, which re-queues this job
				// after its cooldown. Nothing is gained by retrying now.
				$this->logger->warning("Flag catch-up of mailbox $mailboxId failed", [
					'exception' => $e,
				]);
				return;
			} finally {
				$client->logout();
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
