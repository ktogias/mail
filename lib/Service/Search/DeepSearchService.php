<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Search;

use JsonException;
use OCA\Mail\Account;
use OCA\Mail\BackgroundJob\DeepSearchJob as DeepSearchBackgroundJob;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\SearchJob;
use OCA\Mail\Db\SearchJobMapper;
use OCA\Mail\Service\AccountService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJobList;
use OCP\DB\Exception;
use function array_values;
use function count;
use function hash;
use function json_decode;
use function json_encode;
use function max;
use function preg_replace;
use function trim;

/**
 * Creates and advances one-page, cursor-keyed deep searches.
 *
 * The foreground request has already searched the newest 180 days.  A job
 * advances towards the past in bounded 180-day windows and stops as soon as
 * one UI page is full.  This is intentionally not a persistent search index:
 * storage is O(active jobs * one page), and every row has a short TTL.
 */
class DeepSearchService {
	public const WINDOW_SECONDS = 180 * 24 * 60 * 60;
	public const ACTIVE_TTL_SECONDS = 60 * 60;
	public const COMPLETE_TTL_SECONDS = 30 * 60;

	public function __construct(
		private SearchJobMapper $jobMapper,
		private MailboxMapper $mailboxMapper,
		private AccountService $accountService,
		private IMailSearch $mailSearch,
		private IJobList $jobList,
		private ITimeFactory $time,
	) {
	}

	/**
	 * Return an existing equivalent job or create/reset a durable one.
	 *
	 * The key includes the mailbox cache generation and the composite cursor,
	 * so identical consumers coalesce while a changed mailbox or next page does
	 * not accidentally reuse stale work.
	 */
	public function start(
		string $userId,
		string $effectiveUserId,
		Account $account,
		Mailbox $mailbox,
		string $filter,
		string $sortOrder,
		string $view,
		int $cursorAt,
		?int $cursorId,
		int $limit,
		bool $prioritySplit = false,
	): SearchJob {
		$filter = trim((string)preg_replace('/\s+/', ' ', $filter));
		$generation = $mailbox->getCacheBuster();
		$jobKey = hash('sha256', implode("\0", [
			$userId,
			$effectiveUserId,
			(string)$account->getId(),
			(string)$mailbox->getId(),
			$generation,
			$filter,
			$sortOrder,
			$view,
			(string)$cursorAt,
			(string)($cursorId ?? ''),
			(string)$limit,
			$prioritySplit ? 'split' : 'single',
		]));
		$now = $this->time->getTime();
		// Opportunistic cleanup keeps storage bounded even on an instance
		// whose hourly background runner is delayed or temporarily disabled.
		$this->jobMapper->deleteExpired($now);

		try {
			$job = $this->jobMapper->findByJobKey($jobKey);
			if ($job->getExpiresAt() >= $now
				&& !in_array($job->getStatus(), [SearchJob::STATUS_FAILED, SearchJob::STATUS_CANCELLED], true)) {
				return $job;
			}
			$this->initialize($job, $userId, $effectiveUserId, $account, $mailbox, $generation, $filter, $sortOrder, $view, $cursorAt, $cursorId, $limit, $prioritySplit, $now);
			$this->jobMapper->update($job);
		} catch (DoesNotExistException) {
			$job = new SearchJob();
			$job->setJobKey($jobKey);
			$this->initialize($job, $userId, $effectiveUserId, $account, $mailbox, $generation, $filter, $sortOrder, $view, $cursorAt, $cursorId, $limit, $prioritySplit, $now);
			try {
				/** @var SearchJob $job */
				$job = $this->jobMapper->insert($job);
			} catch (Exception $e) {
				// A concurrent identical POST may have won the unique job_key
				// insert.  Coalesce only if that exact row now exists; otherwise
				// preserve the original database failure.
				try {
					$job = $this->jobMapper->findByJobKey($jobKey);
				} catch (DoesNotExistException) {
					throw $e;
				}
				return $job;
			}
		}

		$this->jobList->add(DeepSearchBackgroundJob::class, [
			'jobId' => $job->getId(),
			'iteration' => 0,
			'failures' => 0,
		]);
		return $job;
	}

	private function initialize(
		SearchJob $job,
		string $userId,
		string $effectiveUserId,
		Account $account,
		Mailbox $mailbox,
		string $generation,
		string $filter,
		string $sortOrder,
		string $view,
		int $cursorAt,
		?int $cursorId,
		int $limit,
		bool $prioritySplit,
		int $now,
	): void {
		$job->setUserId($userId);
		$job->setEffectiveUserId($effectiveUserId);
		$job->setAccountId($account->getId());
		$job->setMailboxId($mailbox->getId());
		$job->setMailboxGeneration($generation);
		$job->setFilter($filter);
		$job->setSortOrder($sortOrder);
		$job->setView($view);
		$job->setStatus(SearchJob::STATUS_QUEUED);
		$job->setCursorAt($cursorAt);
		$job->setCursorId($cursorId);
		$job->setNextEnd($cursorAt);
		$job->setSearchedThrough($cursorAt);
		$job->setPageLimit($limit);
		$job->setPrioritySplit($prioritySplit);
		$job->setResultCount(0);
		$job->setChunksDone(0);
		$job->setResultPayload('[]');
		$job->setCancelRequested(false);
		$job->setExhausted(false);
		$job->setErrorCode(null);
		$job->setCreatedAt($now);
		$job->setUpdatedAt($now);
		$job->setExpiresAt($now + self::ACTIVE_TTL_SECONDS);
	}

	public function getForUser(int $id, string $userId): SearchJob {
		return $this->jobMapper->findForUser($id, $userId);
	}

	public function getInternal(int $id): SearchJob {
		return $this->jobMapper->findById($id);
	}

	public function cancel(int $id, string $userId): bool {
		return $this->jobMapper->requestCancel($id, $userId, $this->time->getTime());
	}

	/**
	 * Process exactly one bounded time window.
	 *
	 * @return bool true when another queued chunk is required
	 * @throws JsonException
	 */
	public function processChunk(int $id): bool {
		$job = $this->jobMapper->findById($id);
		if ($job->getCancelRequested() || $this->isTerminal($job)) {
			return false;
		}

		$now = $this->time->getTime();
		$job->setStatus(SearchJob::STATUS_RUNNING);
		$job->setUpdatedAt($now);
		$job->setExpiresAt($now + self::ACTIVE_TTL_SECONDS);
		if (!$this->jobMapper->storeWorkerState($job)) {
			return false;
		}

		$account = $this->accountService->findById($job->getAccountId());
		$mailbox = $this->mailboxMapper->findById($job->getMailboxId());
		if ($account->getUserId() !== $job->getEffectiveUserId()
			|| $mailbox->getAccountId() !== $account->getId()) {
			$this->fail($id, 'scope_changed');
			return false;
		}

		$windowEnd = max(1, $job->getNextEnd());
		$windowStart = max(1, $windowEnd - self::WINDOW_SECONDS + 1);
		$remaining = $job->getPrioritySplit()
			? $job->getPageLimit()
			: max(1, $job->getPageLimit() - $job->getResultCount());
		$windowFilter = $job->getFilter() . " start:$windowStart end:$windowEnd";
		$messages = $this->mailSearch->findMessages(
			$account,
			$mailbox,
			$job->getSortOrder(),
			$windowFilter,
			$job->getCursorAt(),
			$remaining,
			$job->getEffectiveUserId(),
			$job->getView(),
			$job->getPrioritySplit(),
			$job->getCursorId(),
		);

		/** @var array<int, array<string, mixed>> $existing */
		$existing = json_decode($job->getResultPayload() ?? '[]', true, 512, JSON_THROW_ON_ERROR);
		$byId = [];
		foreach ([...$existing, ...$messages] as $message) {
			$serialized = is_array($message) ? $message : $message->jsonSerialize();
			$databaseId = (int)($serialized['databaseId'] ?? 0);
			if ($databaseId > 0 && !isset($byId[$databaseId])) {
				$byId[$databaseId] = $serialized;
			}
		}
		$results = $this->capResults(array_values($byId), $job->getPageLimit(), $job->getPrioritySplit(), $job->getView());

		$job->setResultPayload(json_encode($results, JSON_THROW_ON_ERROR));
		$job->setResultCount(count($results));
		$job->setChunksDone($job->getChunksDone() + 1);
		$job->setSearchedThrough($windowStart);
		$job->setCursorAt(null);
		$job->setCursorId(null);
		$job->setNextEnd(max(0, $windowStart - 1));
		$job->setUpdatedAt($now);
		$job->setErrorCode(null);

		$pageFull = $this->pageIsFull($results, $job->getPageLimit(), $job->getPrioritySplit(), $job->getView());
		$historyExhausted = $windowStart <= 1;
		if ($pageFull || $historyExhausted) {
			$job->setStatus(SearchJob::STATUS_COMPLETE);
			$job->setExhausted($historyExhausted && !$pageFull);
			$job->setExpiresAt($now + self::COMPLETE_TTL_SECONDS);
		} else {
			$job->setStatus(SearchJob::STATUS_QUEUED);
			$job->setExpiresAt($now + self::ACTIVE_TTL_SECONDS);
		}

		if (!$this->jobMapper->storeWorkerState($job)) {
			return false;
		}
		return !$pageFull && !$historyExhausted;
	}

	public function defer(int $id): void {
		$job = $this->jobMapper->findById($id);
		if ($job->getCancelRequested() || $this->isTerminal($job)) {
			return;
		}
		$now = $this->time->getTime();
		$job->setStatus(SearchJob::STATUS_QUEUED);
		$job->setUpdatedAt($now);
		$job->setExpiresAt($now + self::ACTIVE_TTL_SECONDS);
		$this->jobMapper->storeWorkerState($job);
	}

	public function fail(int $id, string $errorCode): void {
		$job = $this->jobMapper->findById($id);
		if ($job->getCancelRequested() || $this->isTerminal($job)) {
			return;
		}
		$now = $this->time->getTime();
		$job->setStatus(SearchJob::STATUS_FAILED);
		$job->setErrorCode($errorCode);
		$job->setUpdatedAt($now);
		$job->setExpiresAt($now + self::COMPLETE_TTL_SECONDS);
		$this->jobMapper->storeWorkerState($job);
	}

	public function retry(int $id, string $errorCode): void {
		$job = $this->jobMapper->findById($id);
		if ($job->getCancelRequested() || $this->isTerminal($job)) {
			return;
		}
		$now = $this->time->getTime();
		$job->setStatus(SearchJob::STATUS_QUEUED);
		$job->setErrorCode($errorCode);
		$job->setUpdatedAt($now);
		$job->setExpiresAt($now + self::ACTIVE_TTL_SECONDS);
		$this->jobMapper->storeWorkerState($job);
	}

	public function deleteExpired(): int {
		return $this->jobMapper->deleteExpired($this->time->getTime());
	}

	/** @return array<string, mixed> */
	public function serialize(SearchJob $job): array {
		try {
			$results = json_decode($job->getResultPayload() ?? '[]', true, 512, JSON_THROW_ON_ERROR);
		} catch (JsonException) {
			$results = [];
		}
		return [
			'id' => $job->getId(),
			'accountId' => $job->getAccountId(),
			'mailboxId' => $job->getMailboxId(),
			'status' => $job->getStatus(),
			'results' => $results,
			'resultCount' => $job->getResultCount(),
			'prioritySplit' => $job->getPrioritySplit(),
			'chunksCompleted' => $job->getChunksDone(),
			'searchedThrough' => $job->getSearchedThrough(),
			'exhausted' => $job->getExhausted(),
			'errorCode' => $job->getErrorCode(),
			'expiresAt' => $job->getExpiresAt(),
		];
	}

	private function isTerminal(SearchJob $job): bool {
		return in_array($job->getStatus(), [
			SearchJob::STATUS_COMPLETE,
			SearchJob::STATUS_CANCELLED,
			SearchJob::STATUS_FAILED,
		], true);
	}

	/** @param array<int, array<string, mixed>> $results */
	private function capResults(array $results, int $limit, bool $prioritySplit, string $view): array {
		if (!$prioritySplit) {
			return array_slice($results, 0, $limit);
		}
		$counts = ['favorite' => 0, 'important' => 0, 'other' => 0];
		return array_values(array_filter($results, function (array $result) use (&$counts, $limit, $view): bool {
			$section = $this->prioritySection($result, $view);
			if ($counts[$section] >= $limit) {
				return false;
			}
			$counts[$section]++;
			return true;
		}));
	}

	/** @param array<int, array<string, mixed>> $results */
	private function pageIsFull(array $results, int $limit, bool $prioritySplit, string $view): bool {
		if (!$prioritySplit) {
			return count($results) >= $limit;
		}
		$counts = ['favorite' => 0, 'important' => 0, 'other' => 0];
		foreach ($results as $result) {
			$counts[$this->prioritySection($result, $view)]++;
		}
		return min($counts) >= $limit;
	}

	/** @param array<string, mixed> $result */
	private function prioritySection(array $result, string $view): string {
		$flags = is_array($result['flags'] ?? null) ? $result['flags'] : [];
		$threaded = $view === IMailSearch::VIEW_THREADED;
		$flagged = $threaded
			? ($flags['hasFlaggedInThread'] ?? ($flags['flagged'] ?? false))
			: ($flags['flagged'] ?? false);
		$important = $threaded
			? ($flags['hasImportantInThread'] ?? ($flags['important'] ?? false))
			: ($flags['important'] ?? false);
		if ($flagged === true) {
			return 'favorite';
		}
		return $important === true ? 'important' : 'other';
	}
}
