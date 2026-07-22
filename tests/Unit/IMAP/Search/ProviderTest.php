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

	public function testDateWindowsHaveDistinctCacheKeys(): void {
		$account = $this->account(13);
		$mailbox = $this->mailbox(149, 'INBOX');
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
		$recent = $this->searchQuery('needle');
		$recent->setStart('1700000000');
		$recent->setEnd('1702592000');
		$older = $this->searchQuery('needle');
		$older->setStart('1690000000');
		$older->setEnd('1699999999');

		$this->provider->findMatches($account, $mailbox, $recent);
		$this->provider->findMatches($account, $mailbox, $older);
	}

	public function testBodySearchCarriesDateWindowToImap(): void {
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
		// 14-Nov-2023 22:13 UTC through 15-Nov-2023 22:13 UTC.
		$query->setStart('1700000000');
		$query->setEnd('1700086400');

		$this->provider->findMatches($account, $mailbox, $query);

		self::assertStringContainsString('SENTSINCE 14-Nov-2023', $built);
		self::assertStringContainsString('SENTBEFORE 16-Nov-2023', $built);
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
}
