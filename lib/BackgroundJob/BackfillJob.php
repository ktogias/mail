<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\BackgroundJob;

use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Exception\IncompleteSyncException;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\Sync\ImapToDbSynchronizer;
use OCA\Mail\Service\Sync\SyncService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJobList;
use OCP\BackgroundJob\TimedJob;
use OCP\IConfig;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;
use Throwable;
use function sprintf;
use function usort;

/**
 * Finishes the initial sync of mailboxes too large to complete in a single
 * batch, without needing a browser tab (or a manually run CLI script) to
 * stay open for however many hours that takes.
 *
 * Deliberately separate from SyncJob (the frequent, day-to-day incremental
 * sync) rather than folded into it: this is background catch-up work with
 * no user waiting on it, so it runs rarely (once per INTERVAL, using
 * TimedJob's own built-in "don't call run() again until enough time has
 * passed" mechanism -- the same idiom every other infrequent job in this
 * app already uses, see QuotaJob/PreviewEnhancementProcessingJob/
 * TrainImportanceClassifierJob), does at most ONE batch (~5000 messages,
 * see ImapToDbSynchronizer::runInitialSync()) per run, and skips the tick
 * entirely if the server is already busy (SyncService::isServerBusy(),
 * the same signal the frontend's own adaptive polling already reacts to).
 *
 * Round-robins across every mailbox of the account that still isn't fully
 * cached: one batch for mailbox A this run, mailbox B the next, and so on,
 * wrapping back to the start once every incomplete mailbox has had a turn.
 * A mailbox that finishes simply stops appearing in the rotation (isCached()
 * reflects it) -- no separate bookkeeping needed for "done" mailboxes.
 */
class BackfillJob extends TimedJob {
	private const INTERVAL = 45 * 60;
	private const CURSOR_KEY_PREFIX = 'backfill-last-mailbox-';

	public function __construct(
		ITimeFactory $time,
		private IUserManager $userManager,
		private AccountService $accountService,
		private MailboxMapper $mailboxMapper,
		private ImapToDbSynchronizer $synchronizer,
		private SyncService $syncService,
		private IMAPClientFactory $clientFactory,
		private IConfig $config,
		private LoggerInterface $logger,
		private IJobList $jobList,
	) {
		parent::__construct($time);

		$this->setInterval(self::INTERVAL);
		// This work has no one waiting on it -- unlike SyncJob (a user
		// just opened the app and expects to see new mail), delaying a
		// backfill tick under load costs nothing but a little more time
		// to finish, which is the entire point.
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
			$this->logger->debug('No authentication on IMAP possible, skipping backfill job');
			return;
		}

		$user = $this->userManager->get($account->getUserId());
		if ($user === null || !$user->isEnabled()) {
			$this->logger->debug(sprintf(
				'Account %d of user %s could not be found or was disabled, skipping backfill job',
				$account->getId(),
				$account->getUserId()
			));
			return;
		}

		if ($this->syncService->isServerBusy()) {
			$this->logger->debug("Server is busy, skipping this account's backfill tick");
			return;
		}

		$incomplete = array_values(array_filter(
			$this->mailboxMapper->findAll($account),
			static fn (Mailbox $mailbox) => $mailbox->getSelectable() && !$mailbox->isCached(),
		));
		if ($incomplete === []) {
			return;
		}
		usort($incomplete, static fn (Mailbox $a, Mailbox $b) => $a->getId() <=> $b->getId());

		$cursorKey = self::CURSOR_KEY_PREFIX . $accountId;
		$lastId = (int)$this->config->getUserValue($account->getUserId(), 'mail', $cursorKey, '0');
		$next = null;
		foreach ($incomplete as $mailbox) {
			if ($mailbox->getId() > $lastId) {
				$next = $mailbox;
				break;
			}
		}
		// Wrap around: either nothing was past the cursor, or the mailbox
		// the cursor pointed at has since finished/disappeared.
		$next ??= $incomplete[0];

		$client = $this->clientFactory->getClient($account);
		$advanceCursor = true;
		try {
			$this->synchronizer->sync($account, $client, $next, $this->logger);
			$this->logger->debug("Backfill: mailbox {$next->getId()} finished its initial sync");
		} catch (IncompleteSyncException $e) {
			// Expected -- one batch done, more left for a future tick.
			$this->logger->debug("Backfill: mailbox {$next->getId()} advanced one batch, still incomplete", [
				'exception' => $e,
			]);
		} catch (MailboxLockedException $e) {
			// Another process (a user's own browser, or this same job for
			// a different account) is already syncing this mailbox right
			// now -- same reasoning as syncAccount()'s own handling of
			// this exact exception. No progress was made, so don't move
			// the cursor past it: worth retrying THIS mailbox again next
			// tick rather than skipping it for a whole rotation.
			$this->logger->debug("Backfill: mailbox {$next->getId()} is locked by another process, will retry next tick", [
				'exception' => $e,
			]);
			$advanceCursor = false;
		} catch (Throwable $e) {
			$this->logger->error("Backfill: could not advance mailbox {$next->getId()}: {$e->getMessage()}", [
				'exception' => $e,
			]);
		} finally {
			$client->logout();
		}

		if ($advanceCursor) {
			$this->config->setUserValue($account->getUserId(), 'mail', $cursorKey, (string)$next->getId());
		}
	}
}
