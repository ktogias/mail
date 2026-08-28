<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\IMAP\Search;

use Horde_Imap_Client_Socket;
use OCA\Mail\Account;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\Search\Provider;
use OCA\Mail\Service\Search\SearchQuery;
use OCP\ICache;
use OCP\ICacheFactory;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class ProviderTest extends TestCase {
	private IMAPClientFactory&MockObject $clientFactory;
	private ICache&MockObject $cache;
	private Provider $provider;

	protected function setUp(): void {
		parent::setUp();

		$this->clientFactory = $this->createMock(IMAPClientFactory::class);
		$this->cache = $this->createMock(ICache::class);
		$cacheFactory = $this->createMock(ICacheFactory::class);
		$cacheFactory->method('createDistributed')->willReturn($this->cache);

		$this->provider = new Provider(
			$this->clientFactory,
			$cacheFactory,
		);
	}

	private function account(int $id): Account {
		$mailAccount = new MailAccount();
		$mailAccount->setId($id);
		return new Account($mailAccount);
	}

	private function mailbox(int $id, string $name): Mailbox {
		$mailbox = new Mailbox();
		$mailbox->setId($id);
		$mailbox->setName($name);
		return $mailbox;
	}

	private function searchQuery(string ...$bodies): SearchQuery {
		$query = new SearchQuery();
		foreach ($bodies as $body) {
			$query->addBody($body);
		}
		return $query;
	}

	/**
	 * Body search is the only search mode that isn't a local database
	 * query -- it opens a fresh IMAP connection and makes a live SEARCH
	 * BODY round-trip to the mail server (see findMatches()). The
	 * priority inbox fans a single typed term out to two requests per
	 * mailbox (is:pi-important and is:pi-other are separate HTTP calls),
	 * both searching for the exact same account+mailbox+term -- doubling
	 * an already-slow operation for no reason (confirmed live via nginx
	 * logs: both requests land within milliseconds of each other). A
	 * short-lived cache collapses that pair into one IMAP round-trip.
	 */
	public function testFindMatchesOnlyHitsImapOnceForTheSameAccountMailboxAndTerms(): void {
		$account = $this->account(13);
		$mailbox = $this->mailbox(149, 'INBOX');
		$imapClient = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($imapClient);
		$imapClient->expects(self::once())
			->method('search')
			->willReturn(['match' => (object)['ids' => [10, 20, 30]]]);

		// A tiny fake backing store instead of juggling mock call order:
		// the first findMatches() misses (nothing cached yet) and stores
		// its result; the second must be served from that same entry
		// without calling search() again. Both callbacks must close over
		// the SAME mutable array by reference -- an arrow function's
		// implicit capture is by value at creation time, which would
		// leave `get` always seeing the empty array from before any
		// `set` ever ran.
		$store = [];
		$this->cache->method('get')->willReturnCallback(function ($key) use (&$store) {
			return $store[$key] ?? null;
		});
		$this->cache->method('set')->willReturnCallback(function ($key, $value) use (&$store) {
			$store[$key] = $value;
			return true;
		});

		$first = $this->provider->findMatches($account, $mailbox, $this->searchQuery('euseful'));
		$second = $this->provider->findMatches($account, $mailbox, $this->searchQuery('euseful'));

		self::assertSame([10, 20, 30], $first);
		self::assertSame([10, 20, 30], $second);
	}

	public function testFindMatchesServesFromCacheWithoutTouchingImapAtAll(): void {
		$account = $this->account(13);
		$mailbox = $this->mailbox(149, 'INBOX');
		$this->clientFactory->expects(self::never())->method('getClient');

		$this->cache->method('get')->willReturn(json_encode([1, 2, 3]));

		$result = $this->provider->findMatches($account, $mailbox, $this->searchQuery('euseful'));

		self::assertSame([1, 2, 3], $result);
	}

	public function testCacheKeyIsIndependentOfBodyTermOrder(): void {
		// "euseful weekly" and "weekly euseful" must hit the same cache
		// entry -- the search itself is order-independent (each term is
		// its own IMAP TEXT criterion), so the cache key should be too.
		$account = $this->account(13);
		$mailbox = $this->mailbox(149, 'INBOX');
		$imapClient = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($imapClient);
		$imapClient->expects(self::once())
			->method('search')
			->willReturn(['match' => (object)['ids' => [5]]]);

		$capturedKeys = [];
		$store = [];
		$this->cache->method('get')->willReturnCallback(function ($key) use (&$capturedKeys, &$store) {
			$capturedKeys[] = $key;
			return $store[$key] ?? null;
		});
		$this->cache->method('set')->willReturnCallback(function ($key, $value) use (&$store) {
			$store[$key] = $value;
			return true;
		});

		$this->provider->findMatches($account, $mailbox, $this->searchQuery('euseful', 'weekly'));
		$this->provider->findMatches($account, $mailbox, $this->searchQuery('weekly', 'euseful'));

		self::assertCount(2, $capturedKeys);
		self::assertSame($capturedKeys[0], $capturedKeys[1]);
	}

	/**
	 * The inverse of what this file used to assert, and deliberately so.
	 *
	 * A progressive search walks the same mailbox and the same term over N
	 * date windows. Keying the cache on the window gave each of them its own
	 * IMAP round trip. Measured against Gmail on 2026-08-14, the round trip
	 * costs the same (~2.7 s) whether it spans 180 days or all of history, so
	 * those extra trips bought nothing at all.
	 */
	public function testEveryDateWindowSharesOneImapRoundTrip(): void {
		$account = $this->account(13);
		$mailbox = $this->mailbox(149, 'INBOX');
		$imapClient = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($imapClient);
		$imapClient->expects(self::once())
			->method('search')
			->willReturn(['match' => (object)['ids' => [7, 9]]]);

		$store = [];
		$this->cache->method('get')->willReturnCallback(function ($key) use (&$store) {
			return $store[$key] ?? null;
		});
		$this->cache->method('set')->willReturnCallback(function ($key, $value) use (&$store) {
			$store[$key] = $value;
			return true;
		});
		$recent = $this->searchQuery('needle');
		$recent->setStart('1700000000');
		$recent->setEnd('1702592000');
		$older = $this->searchQuery('needle');
		$older->setStart('1690000000');
		$older->setEnd('1699999999');

		self::assertSame([7, 9], $this->provider->findMatches($account, $mailbox, $recent));
		self::assertSame([7, 9], $this->provider->findMatches($account, $mailbox, $older));
		self::assertCount(1, $store);
	}

	/**
	 * Freshness moved from the expiry to the key. The cache buster is a hash
	 * of the mailbox sync tokens, so a mailbox that has received mail cannot
	 * be served a UID set computed before it arrived -- which is what makes
	 * a five-minute TTL safe where fifteen seconds used to be necessary.
	 */
	public function testASyncedMailboxDoesNotReuseTheOldUidSet(): void {
		$account = $this->account(13);
		$imapClient = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($imapClient);
		$imapClient->expects(self::exactly(2))
			->method('search')
			->willReturn(['match' => (object)['ids' => []]]);

		$store = [];
		$this->cache->method('get')->willReturnCallback(function ($key) use (&$store) {
			return $store[$key] ?? null;
		});
		$this->cache->method('set')->willReturnCallback(function ($key, $value) use (&$store) {
			$store[$key] = $value;
			return true;
		});

		$before = $this->mailbox(149, 'INBOX');
		$before->setSyncNewToken('token-1');
		$after = $this->mailbox(149, 'INBOX');
		$after->setSyncNewToken('token-2');

		$this->provider->findMatches($account, $before, $this->searchQuery('needle'));
		$this->provider->findMatches($account, $after, $this->searchQuery('needle'));

		self::assertCount(2, $store);
	}

	/**
	 * The database applies the date range with `andWhere`, outside the OR
	 * group the UID candidates join, so IMAP never needed to apply it too --
	 * and applying it there is what forced one round trip per window.
	 */
	public function testBodySearchDoesNotSendTheDateWindowToImap(): void {
		$account = $this->account(13);
		$mailbox = $this->mailbox(149, 'INBOX');
		$imapClient = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($imapClient);
		$built = null;
		$imapClient->method('search')->willReturnCallback(function ($mailboxName, $query) use (&$built) {
			$built = (string)$query;
			return ['match' => (object)['ids' => []]];
		});
		$query = $this->searchQuery('needle');
		$query->setStart('1700000000');
		$query->setEnd('1700086400');

		$this->provider->findMatches($account, $mailbox, $query);

		self::assertStringNotContainsString('SENTSINCE', $built);
		self::assertStringNotContainsString('SENTBEFORE', $built);
		self::assertStringContainsString('needle', $built);
	}

	/**
	 * Confirmed live: a Greek search term ("Ισηοπ") failed instantly
	 * (well under a second, no network I/O at all) with
	 * "String contains non-ASCII characters." IMAP SEARCH defaults to
	 * US-ASCII (RFC 3501) unless the query explicitly declares a
	 * different charset; without that declaration,
	 * Horde_Imap_Client_Search_Query::build() constructs every TEXT
	 * criterion as a Horde_Imap_Client_Data_Format_Astring, which
	 * rejects any non-ASCII byte outright. build() -- called here
	 * exactly as Horde's own Horde_Imap_Client_Base::search() calls it
	 * -- must not throw for a non-ASCII term, and must report having
	 * actually used UTF-8.
	 */
	public function testFindMatchesDeclaresUtf8CharsetSoNonAsciiSearchTermsDontThrow(): void {
		$account = $this->account(13);
		$mailbox = $this->mailbox(149, 'INBOX');
		$imapClient = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($imapClient);

		$builtQuery = null;
		$imapClient->method('search')->willReturnCallback(function ($mailboxName, $query) use (&$builtQuery) {
			$builtQuery = $query->build();
			return ['match' => (object)['ids' => []]];
		});

		$this->provider->findMatches($account, $mailbox, $this->searchQuery('Ισηοπ'));

		self::assertSame('UTF-8', $builtQuery['charset']);
	}

	/**
	 * The same rule, for the OR search that opens the two-step body search.
	 *
	 * That path was added after the charset fix above and did not carry it:
	 * it declares UTF-8 on the parent query and then puts each term in a
	 * SUB-query, and Horde only walks a charset into sub-queries when it is
	 * asked to convert them -- which it is not, and which could not work
	 * anyway, since the sub-queries are built afterwards.
	 *
	 * The gap stayed invisible for as long as no unified/priority search
	 * asked for bodies. The moment one did (2026-08-28, .126) every Greek
	 * body search on the one account with body search enabled answered
	 * HTTP 500 with "String contains non-ASCII characters." -- thrown
	 * client-side by build(), before any network I/O.
	 */
	public function testFindAnyMatchDeclaresUtf8OnEverySubQuerySoNonAsciiTermsDontThrow(): void {
		$account = $this->account(4);
		$mailbox = $this->mailbox(39, 'INBOX');
		$imapClient = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($imapClient);
		$this->cache->method('get')->willReturn(null);

		$builtQuery = null;
		$imapClient->method('search')->willReturnCallback(function ($mailboxName, $query) use (&$builtQuery) {
			// build() is what Horde_Imap_Client_Base::search() calls, and it
			// is where the rejection happens.
			$builtQuery = $query->build();
			return ['match' => (object)['ids' => []]];
		});

		// Mixed on purpose: the ASCII term alone would have passed either way,
		// which is how a half-broken OR would look like a working one.
		$this->provider->findAnyMatch($account, $mailbox, ['ifiroumelioti', 'εκθέματος']);

		self::assertSame('UTF-8', $builtQuery['charset']);
		// The Greek term does not appear in the string form: a non-ASCII
		// criterion is sent as an IMAP literal, which prints as "()". Read it
		// out of the command list instead, or this assertion would pass on a
		// query that dropped the term entirely -- Horde SKIPS an empty
		// sub-query in an OR rather than failing.
		self::assertStringContainsString('εκθέματος', $this->literals($builtQuery['query']));
	}

	/**
	 * Every literal/quoted string in a built command list, flattened.
	 *
	 * @param mixed $list a Horde_Imap_Client_Data_Format_List, or one entry
	 */
	private function literals($list): string {
		$out = '';
		foreach ($list as $entry) {
			if ($entry instanceof \Traversable || is_array($entry)) {
				$out .= $this->literals($entry);
			} elseif ($entry instanceof \Horde_Imap_Client_Data_Format) {
				// Not escape(): it refuses a value that has to go out as a
				// literal, which is exactly what a non-ASCII term is. The raw
				// cast is what carries the bytes.
				$out .= (string)$entry . ' ';
			} else {
				$out .= (string)$entry . ' ';
			}
		}
		return $out;
	}

	/**
	 * And for step two, which restricts one term to the candidates. It sets
	 * its charset on the query that carries the text, so it was never broken
	 * -- asserted so that a future refactor into sub-queries cannot silently
	 * reintroduce what findAnyMatch() just had.
	 */
	public function testFindMatchesWithinCandidatesDeclaresUtf8ForANonAsciiTerm(): void {
		$account = $this->account(4);
		$mailbox = $this->mailbox(39, 'INBOX');
		$imapClient = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($imapClient);
		$this->cache->method('get')->willReturn(null);

		$builtQuery = null;
		$imapClient->method('search')->willReturnCallback(function ($mailboxName, $query) use (&$builtQuery) {
			$builtQuery = $query->build();
			return ['match' => (object)['ids' => []]];
		});

		$this->provider->findMatchesWithinCandidates($account, $mailbox, 'εκθέματος', [1, 2, 3]);

		self::assertSame('UTF-8', $builtQuery['charset']);
	}
}
