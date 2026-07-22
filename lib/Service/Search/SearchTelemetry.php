<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Search;

use OCA\Mail\Db\Mailbox;
use OCP\AppFramework\Utility\ITimeFactory;
use Psr\Log\LoggerInterface;
use Throwable;
use function array_sum;
use function count;
use function implode;
use function json_encode;
use function max;
use function round;

/**
 * Emits one bounded, PII-safe metric for every physical free-text search.
 *
 * The raw filter and its terms are deliberately never logged. Fixed-shape
 * dimensions make p50/p95/p99 aggregation possible without creating a second
 * high-cardinality database workload on small installations.
 */
class SearchTelemetry {
	private const SLOW_SEARCH_MILLISECONDS = 5000;
	private const DAY_SECONDS = 24 * 60 * 60;

	public function __construct(
		private LoggerInterface $logger,
		private ITimeFactory $time,
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
		$shape = $this->queryShape($query);
		if ($shape === null) {
			return;
		}

		$durationMs = (int)round(max(0, $durationNanoseconds) / 1_000_000);
		$termCount = array_sum([
			count($query->getTo()),
			count($query->getFrom()),
			count($query->getCc()),
			count($query->getBcc()),
			count($query->getSubjects()),
			count($query->getBodies()),
		]);
		$metric = [
			'event' => 'mail_search_metric',
			'phase' => 'physical_search',
			'accountId' => $mailbox->getAccountId(),
			'mailboxId' => $mailbox->getId(),
			'queryShape' => $shape,
			'termCount' => $termCount,
			'backend' => $query->getBodies() === [] ? 'database' : 'imap_body_and_database',
			'windowClass' => $this->windowClass($query),
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
			$message = 'mail_search_metric ' . json_encode($metric, JSON_THROW_ON_ERROR);
			if ($status !== 'ok' || $durationMs >= self::SLOW_SEARCH_MILLISECONDS) {
				$this->logger->warning($message);
			} else {
				$this->logger->info($message);
			}
		} catch (Throwable) {
			// Observability must never turn a successful mailbox read into an
			// application failure, including when a custom logger misbehaves.
		}
	}

	private function queryShape(SearchQuery $query): ?string {
		$predicates = [];
		foreach ([
			'to' => $query->getTo(),
			'from' => $query->getFrom(),
			'cc' => $query->getCc(),
			'bcc' => $query->getBcc(),
			'subject' => $query->getSubjects(),
			'body' => $query->getBodies(),
		] as $name => $terms) {
			if ($terms !== []) {
				$predicates[] = $name;
			}
		}

		return $predicates === [] ? null : implode('+', $predicates);
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
