<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP\Search;

use Horde_Imap_Client_Exception;
use Horde_Imap_Client_Search_Query;
use OCA\Mail\Account;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Service\Search\SearchQuery;
use OCP\ICache;
use OCP\ICacheFactory;
use function array_reduce;
use function json_decode;
use function json_encode;
use function md5;
use function sort;

class Provider {
	private const CACHE_TTL_SECONDS = 15;

	private ICache $cache;

	public function __construct(
		private IMAPClientFactory $clientFactory,
		ICacheFactory $cacheFactory,
	) {
		$this->cache = $cacheFactory->createDistributed('mail_body_search');
	}

	/**
	 * @return int[]
	 * @throws ServiceException
	 */
	public function findMatches(Account $account,
		Mailbox $mailbox,
		SearchQuery $searchQuery): array {
		// The priority inbox fans a single body search term out to TWO
		// requests per mailbox (is:pi-important and is:pi-other, each a
		// separate HTTP call), both landing within milliseconds of each
		// other -- confirmed live via nginx logs. Body search is a live
		// IMAP round-trip (new connection, auth, SEARCH, logout; see
		// getIdsLocally() in MailSearch.php, the only search mode that
		// doesn't run against the local, already-indexed database), so
		// that pair doubled the cost of an already-slow operation for no
		// reason -- the two sections search identically for the same
		// account+mailbox+terms. A short TTL is enough to collapse that
		// pair (and an identical retry a few seconds later) without
		// serving a search result that's meaningfully stale; it's a
		// cache of "what matched moments ago", not of mailbox state.
		$cacheKey = $this->buildCacheKey($account, $mailbox, $searchQuery);
		$cached = $this->cache->get($cacheKey);
		if ($cached !== null) {
			return json_decode($cached, true);
		}

		$client = $this->clientFactory->getClient($account);
		try {
			$fetchResult = $client->search(
				$mailbox->getName(),
				$this->convertMailQueryToHordeQuery($searchQuery)
			);
		} catch (Horde_Imap_Client_Exception $e) {
			throw new ServiceException('Could not get message IDs: ' . $e->getMessage(), 0, $e);
		} finally {
			$client->logout();
		}

		$ids = $fetchResult['match']->ids;
		$this->cache->set($cacheKey, json_encode($ids), self::CACHE_TTL_SECONDS);
		return $ids;
	}

	private function buildCacheKey(Account $account, Mailbox $mailbox, SearchQuery $searchQuery): string {
		$bodies = $searchQuery->getBodies();
		sort($bodies);
		return 'imap-body-search-' . md5($account->getId() . '-' . $mailbox->getId() . '-' . implode("\x00", $bodies));
	}

	/**
	 * @param SearchQuery $searchQuery
	 *
	 * @todo possible optimization: filter flags here as well as it might speed up IMAP search
	 *
	 * @return Horde_Imap_Client_Search_Query
	 */
	private function convertMailQueryToHordeQuery(SearchQuery $searchQuery): Horde_Imap_Client_Search_Query {
		return array_reduce(
			$searchQuery->getBodies(),
			static function (Horde_Imap_Client_Search_Query $query, string $textToken) {
				$query->text($textToken, true);
				return $query;
			},
			new Horde_Imap_Client_Search_Query()
		);
	}
}
