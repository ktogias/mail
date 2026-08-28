<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Search;

use OCA\Mail\Db\Mailbox;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\ICacheFactory;
use OCP\IMemcache;
use Psr\Log\LoggerInterface;
use Throwable;
use function array_fill;
use function array_filter;
use function array_sum;
use function ceil;
use function count;
use function gmdate;
use function implode;
use function json_encode;
use function max;
use function min;
use function round;
use function usort;

/**
 * Records bounded, PII-safe metrics for physical free-text searches.
 *
 * Fixed histogram counters live in the distributed cache for eight days. This
 * captures fast searches even when Nextcloud's production log level suppresses
 * info messages, without adding database writes or high-cardinality query keys.
 * Only failures and searches lasting at least five seconds reach the log.
 */
class SearchTelemetry {
	private const SLOW_SEARCH_MILLISECONDS = 5000;
	private const DAY_SECONDS = 24 * 60 * 60;
	private const RETENTION_SECONDS = 8 * self::DAY_SECONDS;
	private const MAX_REPORT_DAYS = 8;

	private const PREDICATES = ['to', 'from', 'cc', 'bcc', 'subject', 'body'];
	private const WINDOW_CLASSES = ['recent_0_30d', 'recent_30_180d', 'deep_180d', 'bounded_other', 'unbounded_or_cursor'];
	private const HISTOGRAM_UPPER_BOUNDS_MS = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 60000, 120000];

	public function __construct(
		private LoggerInterface $logger,
		private ITimeFactory $time,
		private ICacheFactory $cacheFactory,
	) {
	}

	public function record(
		SearchQuery $query,
		Mailbox $mailbox,
		string $sortOrder,
		bool $prioritySplit,
		?int $limit,
		int $durationNanoseconds,
		?int $resultCount,
		string $status,
	): void {
		[$shapeMask, $shape, $termCount] = $this->queryShape($query);
		if ($shapeMask === 0) {
			return;
		}

		$durationMs = (int)round(max(0, $durationNanoseconds) / 1_000_000);
		$windowClass = $this->windowClass($query);
		try {
			$this->storeHistogram($windowClass, $shapeMask, $prioritySplit, $durationMs, $resultCount, $termCount, $status);
		} catch (Throwable) {
			// Metrics must never turn a successful mailbox read into a failure.
		}

		if ($status === 'ok' && $durationMs < self::SLOW_SEARCH_MILLISECONDS) {
			return;
		}

		$metric = [
			'event' => 'mail_search_slow_or_failed',
			'phase' => 'physical_search',
			'accountId' => $mailbox->getAccountId(),
			'mailboxId' => $mailbox->getId(),
			'queryShape' => $shape,
			'termCount' => $termCount,
			'backend' => ($shapeMask & (1 << 5)) !== 0 ? 'imap_body_and_database' : 'database',
			'windowClass' => $windowClass,
			'sort' => $sortOrder,
			'view' => $query->getThreaded() ? 'threaded' : 'singleton',
			'prioritySplit' => $prioritySplit,
			'hasCompositeCursor' => $query->getCursor() !== null && $query->getCursorId() !== null,
			'limit' => $limit,
			'durationMs' => $durationMs,
			'resultCount' => $resultCount,
			'status' => $status,
		];

		try {
			$this->logger->warning('mail_search_slow_or_failed ' . json_encode($metric, JSON_THROW_ON_ERROR));
		} catch (Throwable) {
			// A custom logger is part of observability, never the search path.
		}
	}

	/**
	 * How a body search resolved its per-word UID sets.
	 *
	 * The two-step path -- one OR search for candidates, then one restricted
	 * search per word -- is the only place in this app where a word can lose
	 * the messages it should have matched while everything reports success.
	 * A candidate set that comes back empty, or over the ceiling, or a single
	 * word whose restricted search returns nothing, all end the same way: a
	 * search that quietly returns fewer rows, status ok.
	 *
	 * That is not hypothetical. On 2026-08-28 `ifiroumelioti Ασυρματο δίκτυο`
	 * returned nothing while `ifigenia Ασυρματο δίκτυο` found the message --
	 * and the database half was verified sound, `ifiroumelioti` matching that
	 * very message's To header. Reasoning from the outside got two hypotheses
	 * wrong in a row, so this records what the path actually did.
	 *
	 * PII-safe like the rest of this class: word LENGTHS and set sizes, never
	 * the words. A search term is the most sensitive thing here.
	 *
	 * @param string $branch 'two_step', 'combined_fallback' or 'headers_only'
	 * @param int[] $termLengths one per free-text word, in query order
	 * @param int[] $uidCounts how many UIDs each of those words resolved to,
	 *                         parallel to $termLengths; empty for a branch
	 *                         that does not resolve per word
	 */
	public function recordBodyResolution(
		Mailbox $mailbox,
		string $branch,
		int $candidateCount,
		array $termLengths,
		array $uidCounts,
		int $combinedUidCount,
		int $durationNanoseconds,
	): void {
		$durationMs = (int)round(max(0, $durationNanoseconds) / 1_000_000);

		// A word that resolved to nothing is the interesting case, and it is
		// invisible in the search's own metric: the row count it produces is
		// indistinguishable from "there really was nothing".
		$starvedWords = count(array_filter($uidCounts, static fn (int $count) => $count === 0));
		$interesting = $starvedWords > 0
			|| $candidateCount === 0
			|| $branch !== 'two_step'
			|| $durationMs >= self::SLOW_SEARCH_MILLISECONDS;
		if (!$interesting) {
			return;
		}

		$metric = [
			'event' => 'mail_search_body_resolution',
			'phase' => 'body_resolution',
			'accountId' => $mailbox->getAccountId(),
			'mailboxId' => $mailbox->getId(),
			'branch' => $branch,
			'candidateCount' => $candidateCount,
			'termLengths' => $termLengths,
			'uidCounts' => $uidCounts,
			'starvedWords' => $starvedWords,
			'combinedUidCount' => $combinedUidCount,
			'durationMs' => $durationMs,
		];

		try {
			$this->logger->warning('mail_search_body_resolution ' . json_encode($metric, JSON_THROW_ON_ERROR));
		} catch (Throwable) {
			// Observability is never allowed to break the search itself.
		}
	}

	/** @return array<int, array<string, int|float|string|bool>> */
	public function summarize(int $days = 7): array {
		$cache = $this->cacheFactory->createDistributed('mail_search_metrics');
		if (!$cache instanceof IMemcache) {
			return [];
		}

		$days = min(self::MAX_REPORT_DAYS, max(1, $days));
		$aggregates = [];
		for ($dayOffset = 0; $dayOffset < $days; $dayOffset++) {
			$day = gmdate('Ymd', $this->time->getTime() - $dayOffset * self::DAY_SECONDS);
			foreach (self::WINDOW_CLASSES as $windowClass) {
				for ($shapeMask = 1; $shapeMask < (1 << count(self::PREDICATES)); $shapeMask++) {
					foreach ([false, true] as $prioritySplit) {
						$prefix = $this->cachePrefix($day, $windowClass, $shapeMask, $prioritySplit);
						$count = (int)($cache->get($prefix . 'count') ?? 0);
						if ($count === 0) {
							continue;
						}
						$groupKey = "$windowClass:$shapeMask:" . ($prioritySplit ? '1' : '0');
						if (!isset($aggregates[$groupKey])) {
							$aggregates[$groupKey] = [
								'windowClass' => $windowClass,
								'shapeMask' => $shapeMask,
								'prioritySplit' => $prioritySplit,
								'count' => 0,
								'errors' => 0,
								'slow' => 0,
								'durationMs' => 0,
								'resultCount' => 0,
								'termCount' => 0,
								'histogram' => array_fill(0, count(self::HISTOGRAM_UPPER_BOUNDS_MS), 0),
							];
						}
						$aggregate = &$aggregates[$groupKey];
						$aggregate['count'] += $count;
						foreach (['errors', 'slow', 'durationMs', 'resultCount', 'termCount'] as $counter) {
							$aggregate[$counter] += (int)($cache->get($prefix . $counter) ?? 0);
						}
						foreach (self::HISTOGRAM_UPPER_BOUNDS_MS as $bucket => $unused) {
							$aggregate['histogram'][$bucket] += (int)($cache->get($prefix . "bucket$bucket") ?? 0);
						}
						unset($aggregate);
					}
				}
			}
		}

		$rows = [];
		foreach ($aggregates as $aggregate) {
			$count = $aggregate['count'];
			$shapeMask = $aggregate['shapeMask'];
			$rows[] = [
				'windowClass' => $aggregate['windowClass'],
				'queryShape' => $this->shapeName($shapeMask),
				'backend' => ($shapeMask & (1 << 5)) !== 0 ? 'imap_body_and_database' : 'database',
				'prioritySplit' => $aggregate['prioritySplit'],
				'count' => $count,
				'errors' => $aggregate['errors'],
				'slow' => $aggregate['slow'],
				'p50UpperMs' => $this->percentileUpperBound($aggregate['histogram'], $count, 0.50),
				'p95UpperMs' => $this->percentileUpperBound($aggregate['histogram'], $count, 0.95),
				'p99UpperMs' => $this->percentileUpperBound($aggregate['histogram'], $count, 0.99),
				'avgMs' => round($aggregate['durationMs'] / $count, 1),
				'avgResults' => round($aggregate['resultCount'] / $count, 1),
				'avgTerms' => round($aggregate['termCount'] / $count, 1),
			];
		}
		usort($rows, static fn (array $a, array $b): int => [$b['p95UpperMs'], $b['count']] <=> [$a['p95UpperMs'], $a['count']]);
		return $rows;
	}

	private function storeHistogram(string $windowClass, int $shapeMask, bool $prioritySplit, int $durationMs, ?int $resultCount, int $termCount, string $status): void {
		$cache = $this->cacheFactory->createDistributed('mail_search_metrics');
		if (!$cache instanceof IMemcache) {
			return;
		}
		$prefix = $this->cachePrefix(gmdate('Ymd', $this->time->getTime()), $windowClass, $shapeMask, $prioritySplit);
		$this->increment($cache, $prefix . 'count', 1);
		$this->increment($cache, $prefix . 'durationMs', $durationMs);
		$this->increment($cache, $prefix . 'resultCount', max(0, $resultCount ?? 0));
		$this->increment($cache, $prefix . 'termCount', $termCount);
		if ($status !== 'ok') {
			$this->increment($cache, $prefix . 'errors', 1);
		}
		if ($durationMs >= self::SLOW_SEARCH_MILLISECONDS) {
			$this->increment($cache, $prefix . 'slow', 1);
		}
		$this->increment($cache, $prefix . 'bucket' . $this->histogramBucket($durationMs), 1);
	}

	private function increment(IMemcache $cache, string $key, int $step): void {
		$cache->add($key, 0, self::RETENTION_SECONDS);
		$cache->inc($key, $step);
	}

	private function cachePrefix(string $day, string $windowClass, int $shapeMask, bool $prioritySplit): string {
		return "$day:$windowClass:$shapeMask:" . ($prioritySplit ? '1:' : '0:');
	}

	/** @return array{int, string, int} */
	private function queryShape(SearchQuery $query): array {
		$predicates = [
			$query->getTo(),
			$query->getFrom(),
			$query->getCc(),
			$query->getBcc(),
			$query->getSubjects(),
			$query->getBodies(),
		];
		$shapeMask = 0;
		foreach ($predicates as $bit => $terms) {
			if ($terms !== []) {
				$shapeMask |= 1 << $bit;
			}
		}
		return [$shapeMask, $this->shapeName($shapeMask), array_sum(array_map('count', $predicates))];
	}

	private function shapeName(int $shapeMask): string {
		$names = [];
		foreach (self::PREDICATES as $bit => $name) {
			if (($shapeMask & (1 << $bit)) !== 0) {
				$names[] = $name;
			}
		}
		return implode('+', $names);
	}

	private function histogramBucket(int $durationMs): int {
		foreach (self::HISTOGRAM_UPPER_BOUNDS_MS as $bucket => $upperBound) {
			if ($durationMs <= $upperBound) {
				return $bucket;
			}
		}
		return count(self::HISTOGRAM_UPPER_BOUNDS_MS) - 1;
	}

	/** @param int[] $histogram */
	private function percentileUpperBound(array $histogram, int $count, float $percentile): int {
		$target = (int)ceil($count * $percentile);
		$seen = 0;
		foreach (self::HISTOGRAM_UPPER_BOUNDS_MS as $bucket => $upperBound) {
			$seen += $histogram[$bucket];
			if ($seen >= $target) {
				return $upperBound;
			}
		}
		return self::HISTOGRAM_UPPER_BOUNDS_MS[count(self::HISTOGRAM_UPPER_BOUNDS_MS) - 1];
	}

	private function windowClass(SearchQuery $query): string {
		if ($query->getStart() === null || $query->getEnd() === null) {
			return 'unbounded_or_cursor';
		}

		$start = (int)$query->getStart();
		$end = (int)$query->getEnd();
		$width = max(0, $end - $start + 1);
		$endAge = max(0, $this->time->getTime() - $end);

		if ($width <= 31 * self::DAY_SECONDS && $endAge <= 2 * self::DAY_SECONDS) {
			return 'recent_0_30d';
		}
		if ($width <= 151 * self::DAY_SECONDS
			&& $endAge >= 28 * self::DAY_SECONDS
			&& $endAge <= 32 * self::DAY_SECONDS) {
			return 'recent_30_180d';
		}
		if ($width <= 181 * self::DAY_SECONDS && $endAge >= 178 * self::DAY_SECONDS) {
			return 'deep_180d';
		}

		return 'bounded_other';
	}
}
