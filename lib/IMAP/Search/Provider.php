<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP\Search;

use Horde_Imap_Client_Data_Format_Exception;
use Horde_Imap_Client_Exception;
use Horde_Imap_Client_Ids;
use Horde_Imap_Client_Search_Query;
use OCA\Mail\Account;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Service\Search\SearchQuery;
use OCP\ICache;
use OCP\ICacheFactory;
use function array_reduce;
use function array_unique;
use function json_decode;
use function json_encode;
use function md5;
use function sort;

class Provider {
	/**
	 * Long enough to serve a whole search session -- the first page, the
	 * priority fan-out, and scrolling for more some seconds later.
	 *
	 * Freshness is governed by the mailbox cache buster in the key, not by
	 * this number: it is a hash of the three sync tokens, so any new,
	 * changed or vanished message produces a different key and the stale
	 * entry is simply never read again. Before that was in the key, 15
	 * seconds was the only thing standing between the cache and a stale
	 * result, which is why it was so short.
	 */
	private const CACHE_TTL_SECONDS = 300;

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
		// account+mailbox+terms.
		//
		// It now also collapses every window of a progressive search into
		// one round trip, which is the larger win: the SEARCH is issued
		// unbounded and keyed on the mailbox cache buster rather than on
		// the date range, so freshness comes from the sync tokens instead
		// of from a short expiry.
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

	/**
	 * Every message carrying AT LEAST ONE of the words, in one round trip.
	 *
	 * The first half of covering "one word in the headers, another in the
	 * body". This narrows the mailbox to candidates; it deliberately cannot
	 * say WHICH word matched which message, which is what
	 * findMatchesWithinCandidates() then supplies per word.
	 *
	 * @param string[] $terms
	 * @return int[]
	 * @throws ServiceException
	 */
	public function findAnyMatch(Account $account, Mailbox $mailbox, array $terms): array {
		$terms = array_values(array_unique($terms));
		if ($terms === []) {
			return [];
		}
		$cacheKey = 'imap-body-any-' . md5(implode("\x00", [
			(string)$account->getId(),
			(string)$mailbox->getId(),
			$mailbox->getCacheBuster(),
			...$terms,
		]));
		$cached = $this->cache->get($cacheKey);
		if ($cached !== null) {
			return json_decode($cached, true);
		}

		$query = new Horde_Imap_Client_Search_Query();
		$query->charset('UTF-8', false);
		$alternatives = [];
		foreach ($terms as $term) {
			$one = new Horde_Imap_Client_Search_Query();
			$one->text($term, true);
			$alternatives[] = $one;
		}
		$query->orSearch($alternatives);

		$client = $this->clientFactory->getClient($account);
		try {
			$result = $client->search($mailbox->getName(), $query);
		} catch (Horde_Imap_Client_Exception|Horde_Imap_Client_Data_Format_Exception $e) {
			throw new ServiceException('Could not get candidate message IDs: ' . $e->getMessage(), 0, $e);
		} finally {
			$client->logout();
		}
		$ids = $result['match']->ids;
		$this->cache->set($cacheKey, json_encode($ids), self::CACHE_TTL_SECONDS);
		return $ids;
	}

	/**
	 * Which of these candidates have this one word in their body.
	 *
	 * Restricting a SEARCH to a UID set is the cheap axis. Measured on a
	 * 6,020-message mailbox: a full-mailbox TEXT search cost 6,507 ms, the
	 * same search over 200 candidates 163 ms, over 2,234 candidates 2,798 ms
	 * -- roughly 1.25 ms per candidate rather than a fixed round trip.
	 *
	 * That is the opposite of the DATE range, which changes nothing (see
	 * convertMailQueryToHordeQuery). Assuming one generalised to the other is
	 * how this approach was dismissed once before.
	 *
	 * @param int[] $candidates
	 * @return int[]
	 * @throws ServiceException
	 */
	public function findMatchesWithinCandidates(Account $account, Mailbox $mailbox, string $term, array $candidates): array {
		if ($candidates === []) {
			return [];
		}
		sort($candidates);
		// The candidate set is part of the question, so it is part of the key.
		$cacheKey = 'imap-body-within-' . md5(implode("\x00", [
			(string)$account->getId(),
			(string)$mailbox->getId(),
			$mailbox->getCacheBuster(),
			$term,
			md5(implode(',', $candidates)),
		]));
		$cached = $this->cache->get($cacheKey);
		if ($cached !== null) {
			return json_decode($cached, true);
		}

		$query = new Horde_Imap_Client_Search_Query();
		$query->charset('UTF-8', false);
		$query->text($term, true);
		$query->ids(new Horde_Imap_Client_Ids($candidates));

		$client = $this->clientFactory->getClient($account);
		try {
			$result = $client->search($mailbox->getName(), $query);
		} catch (Horde_Imap_Client_Exception|Horde_Imap_Client_Data_Format_Exception $e) {
			throw new ServiceException('Could not narrow candidates: ' . $e->getMessage(), 0, $e);
		} finally {
			$client->logout();
		}
		$ids = $result['match']->ids;
		$this->cache->set($cacheKey, json_encode($ids), self::CACHE_TTL_SECONDS);
		return $ids;
	}

	/**
	 * Deliberately keyed WITHOUT the date range.
	 *
	 * The IMAP SEARCH is now issued unbounded (see
	 * convertMailQueryToHordeQuery()), so one round trip answers every
	 * window a progressive search will ask about. Keeping the dates in the
	 * key would have given each window its own entry and its own round trip
	 * -- exactly the N-round-trip behaviour the measurement rejected.
	 *
	 * The mailbox cache buster takes their place. It is a hash of the sync
	 * tokens, so a new, changed or vanished message changes the key and the
	 * previous answer is never served again.
	 */
	private function buildCacheKey(Account $account, Mailbox $mailbox, SearchQuery $searchQuery): string {
		$bodies = $searchQuery->getBodies();
		sort($bodies);
		return 'imap-body-search-' . md5(implode("\x00", [
			(string)$account->getId(),
			(string)$mailbox->getId(),
			$mailbox->getCacheBuster(),
			...$bodies,
		]));
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

		$query = array_reduce(
			$searchQuery->getBodies(),
			static function (Horde_Imap_Client_Search_Query $query, string $textToken) {
				$query->text($textToken, true);
				return $query;
			},
			$query
		);

		// The date range is deliberately NOT sent to IMAP.
		//
		// It looked like an obvious optimisation and it is not one. Measured
		// against Gmail on 2026-08-14, mailbox 149 (27,547 messages), the
		// same body term:
		//
		//   one 180-day window   3,967 ms    48 uids
		//   two windows (360d)   2,946 ms   100 uids
		//   five windows (900d)  2,680 ms   160 uids
		//   unbounded, all time  2,704 ms   160 uids
		//
		// The cost is a fixed round trip -- roughly 2.7-4 s, and once 16 s --
		// and the scope makes no difference to it. A progressive search that
		// walks N windows therefore paid N times that price to learn what one
		// unbounded SEARCH tells it, which for a five-window walk was ~13 s of
		// Gmail time instead of ~2.7 s.
		//
		// Correctness does not depend on IMAP applying the range: the dates
		// are applied by the database, with `andWhere` OUTSIDE the OR group
		// that the UID candidates join (MessageMapper::findIdsByQuery), so a
		// UID from outside the window cannot survive into a result. Dropping
		// them here only widens the candidate set.
		//
		// It does widen it, and that is not free for a very common term:
		// "the" returned 17,694 uids (64% of the mailbox) against 160 for a
		// real search term, and the database half went from ~20 ms to ~590 ms.
		// Still far cheaper than a second round trip, and only for terms whose
		// body search is not discriminating anyway.

		return $query;
	}
}
