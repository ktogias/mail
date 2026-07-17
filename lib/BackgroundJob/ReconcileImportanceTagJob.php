<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\BackgroundJob;

use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Db\Tag;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Service\AccountService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJobList;
use OCP\BackgroundJob\TimedJob;
use Psr\Log\LoggerInterface;

/**
 * Nightly reconciliation for the flag/tag importance split: backfills the
 * user-wide $label1 tag mapping for messages whose per-copy
 * flag_important is set but whose tag row is missing -- the residue of a
 * partially-failed classifier write (flagMessage() succeeded,
 * tagMessage() didn't -- confirmed live) or of any client writing only
 * the importance keyword.
 *
 * Deliberately lightweight so it never weighs on the cron run: one
 * bounded DB query per account (no IMAP connection at any point, no
 * ORDER BY, LIMIT-terminated -- see
 * MessageMapper::findImportantMessageIdsWithoutTag()), at most
 * MAX_MAPPINGS_PER_RUN plain tag-row inserts, once per day,
 * time-insensitive. A backlog larger than one batch simply drains across
 * consecutive nights.
 */
class ReconcileImportanceTagJob extends TimedJob {
	/**
	 * Upper bound of tag mappings written per run -- keeps the job's
	 * write volume trivially small for the cron slot even on the first
	 * run against years of accumulated divergence.
	 */
	public const MAX_MAPPINGS_PER_RUN = 500;

	public function __construct(
		ITimeFactory $time,
		private AccountService $accountService,
		private MessageMapper $messageMapper,
		private TagMapper $tagMapper,
		private IJobList $jobList,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);

		$this->setInterval(24 * 60 * 60);
		$this->setTimeSensitivity(self::TIME_INSENSITIVE);
	}

	/**
	 * @return void
	 */
	#[\Override]
	protected function run($argument) {
		$accountId = (int)$argument['accountId'];

		try {
			$account = $this->accountService->findById($accountId);
		} catch (DoesNotExistException $e) {
			$this->logger->debug("Could not find account <{$accountId}> removing from jobs");
			$this->jobList->remove(self::class, $argument);
			return;
		}

		$userId = $account->getUserId();
		try {
			$importantTag = $this->tagMapper->getTagByImapLabel(Tag::LABEL_IMPORTANT, $userId);
		} catch (DoesNotExistException $e) {
			// No important tag yet for this user -- nothing to reconcile
			// toward. The tag is created on demand by the first real
			// tagging action; until then a missing mapping is not a
			// divergence.
			return;
		}

		$messageIds = $this->messageMapper->findImportantMessageIdsWithoutTag(
			$accountId,
			$importantTag->getId(),
			self::MAX_MAPPINGS_PER_RUN,
		);
		if ($messageIds === []) {
			return;
		}

		foreach ($messageIds as $messageId) {
			$this->tagMapper->tagMessage($importantTag, $messageId, $userId);
		}
		$this->logger->info('Backfilled ' . count($messageIds) . " missing importance tag mappings for account {$accountId}");
	}
}
