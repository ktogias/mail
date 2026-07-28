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
use OCA\Mail\IMAP\ImapWorkClass;
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
 * Round-robins across every mailbox of the account that is in scope for
 * background sync and still isn't fully cached: one batch for mailbox A this
 * run, mailbox B the next, and so on, wrapping back to the start once every
 * incomplete mailbox has had a turn. A mailbox that finishes simply stops
 * appearing in the rotation (isCached() reflects it) -- no separate
 * bookkeeping needed for "done" mailboxes.
 *
 * "In scope" is not this job's own judgement call: it is whatever
 * ImapToDbSynchronizer::syncAccount() would go on to keep fresh. Finishing
 * the initial sync of a mailbox nobody syncs afterwards buys a stale copy at
 * full price.
 */
class BackfillJob extends TimedJob {
	private const INTERVAL = 15 * 60;
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
		// Deliberately TIME_SENSITIVE, not TIME_INSENSITIVE, even though
		// this work has no one waiting on it. Confirmed against
		// \OC\Core\Service\CronService::runCli(): TIME_INSENSITIVE isn't
		// just "lower priority" -- outside a configured
		// maintenance_window_start (3-7am UTC on this install),
		// getNext(onlyTimeSensitive: true) skips TIME_INSENSITIVE jobs
		// ENTIRELY, no matter how long their own interval has elapsed.
		// That would have limited this job to a ~4-hour nightly window
		// (turning a several-week backfill into several months) for a box
		// that's often in active use around the clock. INTERVAL (15 min)
		// and isServerBusy() already bound the actual load this job adds
		// per tick; TIME_SENSITIVE just means those ticks aren't also
		// confined to nighttime.
		$this->setTimeSensitivity(self::TIME_SENSITIVE);
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

		// isServerBusy() only sees CONCURRENCY (how many real syncs are in
		// flight instance-wide) -- it never caught this job's OWN IMAP
		// activity in the first place (this job calls the synchronizer
		// directly, not SyncService::syncMailbox(), so it never
		// incremented that counter either). This second, per-account
		// check catches LATENCY instead: if this account's IMAP provider
		// has recently been responding slowly (Gmail-side account
		// throttling, confirmed live 2026-07-12 -- mailbox 149 sync
		// regularly running 15-38s while this job kept adding its own
		// connections against the same account the whole time), skip
		// this tick rather than adding more pressure to an already
		// struggling account. A calm account elsewhere on the same
		// instance is unaffected.
		if ($this->syncService->isAccountResponseSlow($accountId)) {
			$this->logger->debug("Account {$accountId}'s IMAP provider has been responding slowly, skipping this tick");
			return;
		}

		// Only mailboxes cron actually keeps up to date are worth finishing:
		// see ImapToDbSynchronizer::isInBackgroundSyncScope(), which owns this
		// rule for both. Without the scope check this rotation consisted
		// entirely of mailboxes syncAccount() skips -- on the account that
		// exposed it, 5.9M messages across eight of them, led by a 3.1M-message
		// Gmail "All Mail" that is a duplicate of every other folder by
		// construction and can never complete. Confirmed live 2026-07-27: a
		// tick at 13:30:24Z spent its IMAP login on that mailbox and hit the
		// account's connection limit; interactive requests were being refused
		// by the provider in the same window.
		$incomplete = array_values(array_filter(
			$this->mailboxMapper->findAll($account),
			static fn (Mailbox $mailbox) => $mailbox->getSelectable()
				&& !$mailbox->isCached()
				&& ImapToDbSynchronizer::isInBackgroundSyncScope($account, $mailbox),
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

		// Wait for a connection slot rather than giving up on it.
		//
		// MAINTENANCE work gets waitMilliseconds = 0, so this job asked for a
		// slot, found the sync lane busy and abandoned the whole tick -- with
		// nothing to show for it until fifteen minutes later. That is exactly
		// backwards for the only caller here that has no one waiting on it:
		// the user's own reads keep their reserved slots either way, and this
		// job's alternative to waiting eight seconds is waiting fifteen
		// minutes.
		//
		// Confirmed live on 2026-07-28, minutes after background sync was
		// enabled for six large folders: every tick logged
		// "could not advance mailbox 179: IMAP account concurrency limit
		// reached" while the incremental sync of those same folders held the
		// lane. The backfill made no progress at all.
		//
		// The work class stays MAINTENANCE deliberately, so waiting buys
		// patience in the SYNC lane only -- it must never let a backfill
		// borrow the slot kept for what the user is looking at.
		$client = $this->clientFactory->getClient(
			$account,
			true,
			false,
			true,
			ImapWorkClass::MAINTENANCE,
		);
		$advanceCursor = true;
		$syncStartedAt = microtime(true);
		try {
			// batchSync: this job has no user waiting on it, and without the
			// flag every tick ends by dispatching SynchronizationEvent, whose
			// listener rebuilds the account's ENTIRE thread tree from scratch.
			// Measured live on 2026-07-28 against this account: "Threading
			// 169970 messages" at 274MB peak and ~6s, in the cron process, on
			// a box with 1.6GB of RAM -- every 15 minutes, for one batch of
			// old messages nobody is looking at.
			//
			// syncAccount() already passes exactly this for its per-mailbox
			// calls and dispatches once at the end of the pass; this call was
			// simply never given the same treatment. Thread ids for backfilled
			// messages are built by the next ordinary account sync.
			$this->synchronizer->sync($account, $client, $next, $this->logger, batchSync: true);
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
			// This job never goes through SyncService::syncMailbox(), so
			// this is the only place its own IMAP activity ever gets
			// timed for isAccountResponseSlow() -- feeds the same signal
			// this job itself checks above, so a slow tick here makes the
			// NEXT one (for this account) back off too.
			$this->syncService->recordSyncDuration($accountId, microtime(true) - $syncStartedAt);
			$client->logout();
		}

		if ($advanceCursor) {
			$this->config->setUserValue($account->getUserId(), 'mail', $cursorKey, (string)$next->getId());
		}
	}
}
