<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP\Search;

use Horde_Imap_Client_Data_Format_Exception;
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
		} catch (Horde_Imap_Client_Exception|Horde_Imap_Client_Data_Format_Exception $e) {
			// Data_Format_Exception (thrown by build(), called inside
			// search() -- see convertMailQueryToHordeQuery()'s own
			// comment for when this used to happen) is a sibling of
			// Horde_Imap_Client_Exception, not a subclass of it, so the
			// original single-type catch here let it propagate
			// uncaught: a raw, unclean error instead of the same
			// ServiceException every other IMAP failure in this method
			// produces.
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
		$query = new Horde_Imap_Client_Search_Query();

		// IMAP SEARCH defaults to US-ASCII (RFC 3501 6.4.4) unless the
		// query explicitly declares a different charset -- and without
		// one, Horde_Imap_Client_Search_Query::build() constructs every
		// TEXT/BODY criterion as a Horde_Imap_Client_Data_Format_Astring,
		// which rejects any non-ASCII byte outright, entirely
		// client-side, before the request ever reaches the network.
		// Confirmed live: a Greek search term ("Ισηοπ") failed in under
		// a second with "String contains non-ASCII characters." -- this
		// app never told Horde what charset the search text was in, so
		// every non-Latin-script term (Greek here, but the same gap
		// applies to Cyrillic, CJK, or accented Latin) was rejected
		// before ever attempting to search anything. UTF-8 is a
		// universally supported SEARCH charset on real-world IMAP
		// servers (Gmail, Dovecot, Exchange, ...); declaring it makes
		// build() choose the *_Nonascii string format variants instead.
		$query->charset('UTF-8', false);

		return array_reduce(
			$searchQuery->getBodies(),
			static function (Horde_Imap_Client_Search_Query $query, string $textToken) {
				$query->text($textToken, true);
				return $query;
			},
			$query
		);
	}
}
