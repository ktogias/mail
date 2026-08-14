<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Search;

use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MessageMapper;
use function array_filter;
use function array_slice;
use function array_values;
use function count;
use function hrtime;
use function is_array;
use function max;
use function min;
use function preg_match;
use function preg_replace;
use function trim;

/**
 * Searches backwards through a mailbox's history in bounded windows.
 *
 * There is no job, no row, no TTL and no reaper. One request advances the
 * search by as much as it can afford and hands back a continuation token; the
 * client decides whether to ask again. If it stops asking -- the user cancels,
 * the tab closes, the laptop shuts -- the search stops, because nothing was
 * ever created that could outlive it.
 *
 * This replaces a queued background job that walked one window per five-minute
 * cron tick. On 2026-08-14 thirteen of those, from one afternoon's typing, were
 * found still walking after nine and a half hours, having reached 1975 on a
 * mailbox whose oldest message is 2024-04-21.
 *
 * The measurements the shape comes from, all on that mailbox:
 *
 *   header-only window          21 ms   -- the whole depth is ~100 ms
 *   body window              3,500 ms   -- 99.8% of it the IMAP round trip
 *   IMAP SEARCH, 180 days    2,700 ms   -- and 2,704 ms for ALL of history
 *
 * So depth is nearly free and breadth is not, and breadth has no depth to
 * walk: one unbounded SEARCH answers the whole mailbox (see the Provider,
 * .107). The client therefore runs two of these searches concurrently, one
 * per mode -- they block on different resources, disk and network, and overlap
 * almost perfectly.
 */
class DeepSearchService {
	public const WINDOW_SECONDS = 180 * 24 * 60 * 60;

	/** Header terms only: local database, no IMAP. */
	public const MODE_HEADERS = 'headers';
	/** The filter as typed, body terms included: one IMAP round trip. */
	public const MODE_BODY = 'body';

	/**
	 * How long one request may spend walking windows.
	 *
	 * Checked BETWEEN windows, never inside one, so a window is always
	 * completed and a result is never half a window's worth. The first
	 * window therefore always runs however long it takes -- which for a
	 * body search is one IMAP round trip, and that is the point: the
	 * budget decides how much comes back in this response, not whether the
	 * expensive part happens.
	 */
	public const REQUEST_BUDGET_MS = 2000;

	public function __construct(
		private MessageMapper $messageMapper,
		private IMailSearch $mailSearch,
	) {
	}

	/**
	 * Advance one search by as many windows as the budget allows.
	 *
	 * @return array{results: array, searchedThrough: int, nextEnd: int|null, exhausted: bool, windows: int, durationMs: int, mode: string}
	 */
	public function search(
		Account $account,
		Mailbox $mailbox,
		string $effectiveUserId,
		string $filter,
		string $sortOrder,
		string $view,
		?int $cursorAt,
		?int $cursorId,
		int $limit,
		bool $prioritySplit,
		?int $nextEnd,
		string $mode,
	): array {
		$startedAt = hrtime(true);
		$filter = trim((string)preg_replace('/\s+/', ' ', $filter));
		if ($mode === self::MODE_HEADERS) {
			$filter = self::stripBodyTerms($filter);
		}

		// The floor of the walk: no message in this mailbox is older than
		// this, so every window below it is provably empty. Deep search
		// returns only locally cached rows -- IMAP contributes candidate
		// UIDs, the database performs the join -- so this is an exact
		// bound rather than an estimate. An empty mailbox yields
		// PHP_INT_MAX and terminates on the first window, for the same
		// reason.
		$floor = $this->messageMapper->findOldestSentAt($mailbox) ?? PHP_INT_MAX;

		$windowEnd = $nextEnd ?? $cursorAt ?? throw new \InvalidArgumentException('no cursor');
		$results = [];
		$windows = 0;
		$searchedThrough = $windowEnd;
		$exhausted = false;
		// Only the first window of a request may consume the composite
		// cursor; afterwards the walk is bounded by the window itself and
		// reusing the cursor would re-exclude rows it has already passed.
		$useCursor = $nextEnd === null;

		while (true) {
			$windowStart = max(1, $windowEnd - self::WINDOW_SECONDS + 1);
			$remaining = $prioritySplit ? $limit : max(1, $limit - count($results));

			$messages = $this->mailSearch->findMessages(
				$account,
				$mailbox,
				$sortOrder,
				$filter . " start:$windowStart end:$windowEnd",
				$useCursor ? $cursorAt : null,
				$remaining,
				$effectiveUserId,
				$view,
				$prioritySplit,
				$useCursor ? $cursorId : null,
			);
			$useCursor = false;
			$windows++;

			foreach ($messages as $message) {
				$serialized = is_array($message) ? $message : $message->jsonSerialize();
				$databaseId = (int)($serialized['databaseId'] ?? 0);
				if ($databaseId > 0 && !isset($results[$databaseId])) {
					$results[$databaseId] = $serialized;
				}
			}

			$searchedThrough = $windowStart;
			$windowEnd = $windowStart - 1;

			// The window CONTAINING the floor is searched before the walk
			// stops, so flooring can never skip a message; it only refuses
			// to search below the oldest one that exists.
			if ($windowStart <= max(1, $floor)) {
				$exhausted = true;
				break;
			}
			if ($this->pageIsFull($results, $limit, $prioritySplit, $view)) {
				break;
			}
			if ((hrtime(true) - $startedAt) / 1e6 >= self::REQUEST_BUDGET_MS) {
				break;
			}
		}

		return [
			// The client stamps every envelope with this: the list is
			// unified across accounts and an envelope without it cannot be
			// routed back to its own.
			'accountId' => $account->getId(),
			'results' => array_values($this->capResults(array_values($results), $limit, $prioritySplit, $view)),
			'searchedThrough' => $searchedThrough,
			'nextEnd' => $exhausted ? null : $windowEnd,
			'exhausted' => $exhausted,
			'windows' => $windows,
			'durationMs' => (int)round((hrtime(true) - $startedAt) / 1e6),
			'mode' => $mode,
		];
	}

	/**
	 * Drop `body:` terms so the headers stream never reaches IMAP.
	 *
	 * The body stream keeps the filter as typed, so it returns a superset of
	 * what the headers stream returns. That redundancy is deliberate: the
	 * database combines body UIDs and subject matches in one OR
	 * (MessageMapper::findIdsByQuery), and splitting a disjunction across two
	 * requests is exactly the kind of clever that goes subtly wrong. The
	 * duplicate rows cost one header search (~21 ms) and the client
	 * deduplicates by databaseId anyway.
	 */
	public static function stripBodyTerms(string $filter): string {
		return trim((string)preg_replace('/\s+/', ' ', (string)preg_replace('/(?:^|\s)body:\S+/i', ' ', $filter)));
	}

	public static function hasBodyTerms(string $filter): bool {
		return preg_match('/(?:^|\s)body:\S/i', $filter) === 1;
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
