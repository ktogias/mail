<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\BackgroundJob;

use OCA\Mail\IMAP\ImapConnectionSemaphore;
use OCA\Mail\Service\Search\DeepSearchService;
use OCA\Mail\Service\Sync\SyncService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJobList;
use OCP\BackgroundJob\QueuedJob;
use OCP\ICacheFactory;
use OCP\IMemcache;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Advances one deep-search window, then yields back to the job runner.
 *
 * A distributed single-slot semaphore is shared by every account and user on
 * the instance.  This is the server-side bulkhead: at most one expensive deep
 * search runs at a time, independent of browser tab count or FPM concurrency.
 */
class DeepSearchJob extends QueuedJob {
	private const RETRY_SECONDS = 30;
	private const MAX_FAILURES = 3;

	public function __construct(
		ITimeFactory $time,
		private DeepSearchService $deepSearch,
		private SyncService $syncService,
		private ICacheFactory $cacheFactory,
		private IJobList $jobList,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);
	}

	#[\Override]
	protected function run($argument): void {
		$jobId = (int)($argument['jobId'] ?? 0);
		$iteration = (int)($argument['iteration'] ?? 0);
		$failures = (int)($argument['failures'] ?? 0);
		if ($jobId <= 0) {
			return;
		}

		try {
			$job = $this->deepSearch->getInternal($jobId);
		} catch (DoesNotExistException) {
			return;
		}

		if ($this->syncService->isServerBusy()
			|| $this->syncService->isAccountResponseSlow($job->getAccountId())) {
			$this->deepSearch->defer($jobId);
			$this->schedule($jobId, $iteration + 1, $failures, self::RETRY_SECONDS);
			return;
		}

		$cache = $this->cacheFactory->createDistributed('mail_deep_search_worker');
		$semaphore = $cache instanceof IMemcache
			? new ImapConnectionSemaphore($cache, 'global', 1)
			: null;
		if ($semaphore !== null && !$semaphore->acquire()) {
			$this->deepSearch->defer($jobId);
			$this->schedule($jobId, $iteration + 1, $failures, self::RETRY_SECONDS);
			return;
		}

		try {
			$needsAnotherChunk = $this->deepSearch->processChunk($jobId);
			if ($needsAnotherChunk) {
				$this->schedule($jobId, $iteration + 1, 0, 1);
			}
		} catch (Throwable $e) {
			$failures++;
			$this->logger->warning('Background deep search chunk failed', [
				'jobId' => $jobId,
				'failure' => $failures,
				'exception' => $e,
			]);
			if ($failures < self::MAX_FAILURES) {
				$this->deepSearch->retry($jobId, 'temporary_failure');
				$this->schedule($jobId, $iteration + 1, $failures, self::RETRY_SECONDS);
			} else {
				$this->deepSearch->fail($jobId, 'search_failed');
			}
		} finally {
			$semaphore?->release();
		}
	}

	private function schedule(int $jobId, int $iteration, int $failures, int $delay): void {
		$this->jobList->scheduleAfter(self::class, $this->time->getTime() + $delay, [
			'jobId' => $jobId,
			'iteration' => $iteration,
			'failures' => $failures,
		]);
	}
}
