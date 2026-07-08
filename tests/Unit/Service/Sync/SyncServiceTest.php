<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2021 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\Sync;

use OCA\Mail\Account;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Exception\MailboxNotCachedException;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\MailboxStats;
use OCA\Mail\IMAP\MailboxSync;
use OCA\Mail\IMAP\PreviewEnhancer;
use OCA\Mail\IMAP\Sync\Response;
use OCA\Mail\Service\Search\FilterStringParser;
use OCA\Mail\Service\Sync\ImapToDbSynchronizer;
use OCA\Mail\Service\Sync\SyncService;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

final class SyncServiceTest extends TestCase {

	private IMAPClientFactory&MockObject $clientFactory;

	/** @var ImapToDbSynchronizer */
	private $synchronizer;

	/** @var MessageMapper */
	private $messageMapper;

	/** @var MailboxSync */
	private $mailboxSync;

	/** @var SyncService */
	private $syncService;

	private \OCP\IMemcache&MockObject $freshnessCache;
	private \OCP\AppFramework\Utility\ITimeFactory&MockObject $timeFactory;

	protected function setUp(): void {
		parent::setUp();

		$this->clientFactory = $this->createMock(IMAPClientFactory::class);
		$this->synchronizer = $this->createMock(ImapToDbSynchronizer::class);
		$this->messageMapper = $this->createMock(MessageMapper::class);
		$this->mailboxSync = $this->createMock(MailboxSync::class);
		$this->freshnessCache = $this->createMock(\OCP\IMemcache::class);
		$cacheFactory = $this->createMock(\OCP\ICacheFactory::class);
		$cacheFactory->method('createDistributed')->willReturn($this->freshnessCache);
		$this->timeFactory = $this->createMock(\OCP\AppFramework\Utility\ITimeFactory::class);
		$this->timeFactory->method('getTime')->willReturn(10_000);

		$this->syncService = new SyncService(
			$this->clientFactory,
			$this->synchronizer,
			$this->createStub(FilterStringParser::class),
			$this->messageMapper,
			$this->createStub(PreviewEnhancer::class),
			$this->createStub(\Psr\Log\LoggerInterface::class),
			$this->mailboxSync,
			$cacheFactory,
			$this->timeFactory
		);
	}

	public function testPartialSyncOnUncachedMailbox(): void {
		$account = $this->createStub(Account::class);
		$mailbox = $this->createMock(Mailbox::class);
		$mailbox->expects($this->once())
			->method('isCached')
			->willReturn(false);

		$this->expectException(MailboxNotCachedException::class);
		$this->syncService->syncMailbox(
			$account,
			$mailbox,
			42,
			true,
			null,
			[],
			'DESC'
		);
	}

	public function testSyncMailboxReturnsFolderStats(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setMessages(42);
		$mailbox->setUnseen(10);
		$expectedResponse = new Response(
			[],
			[],
			[],
			new MailboxStats(42, 10, null)
		);
		$this->clientFactory
			->method('getClient')
			->with($account)
			->willReturn($this->createStub(\Horde_Imap_Client_Socket::class));
		$this->messageMapper
			->method('findUidsForIds')
			->with($mailbox, [])
			->willReturn([]);
		$this->synchronizer->expects($this->once())
			->method('sync')
			->with(
				$account,
				$this->createStub(\Horde_Imap_Client_Socket::class),
				$mailbox,
				$this->createStub(\Psr\Log\LoggerInterface::class),
				0,
				[],
				true
			);
		$this->mailboxSync->expects($this->once())
			->method('syncStats')
			->with($this->createStub(\Horde_Imap_Client_Socket::class), $mailbox);

		$response = $this->syncService->syncMailbox(
			$account,
			$mailbox,
			0,
			false,
			null,
			[]
		);

		$this->assertEquals($expectedResponse, $response);
	}

	public function testFreshnessGateServesTheDatabaseWithoutTouchingImap(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setMessages(42);
		$mailbox->setUnseen(10);
		// Mark the mailbox as cached so a partial sync is allowed.
		$mailbox->setSyncNewToken('a');
		$mailbox->setSyncChangedToken('b');
		$mailbox->setSyncVanishedToken('c');

		// Another caller finished a real sync moments ago.
		$this->freshnessCache->method('get')->with('149')->willReturn(10_003);
		$this->freshnessCache->method('add')->willReturn(true);

		$this->clientFactory->expects($this->never())->method('getClient');
		$this->synchronizer->expects($this->never())->method('sync');
		$this->mailboxSync->expects($this->never())->method('syncStats');
		// A gated response must not re-arm the marker either.
		$this->freshnessCache->expects($this->never())->method('set');

		$response = $this->syncService->syncMailbox(
			$account,
			$mailbox,
			0,
			true,
			null,
			[]
		);

		$this->assertEquals(new Response([], [], [], new MailboxStats(42, 10, null)), $response);
	}

	public function testEmptyKnownIdsBoundsTheColdStartDumpInsteadOfReturningTheWholeMailbox(): void {
		// A client with truly empty knownIds (a fresh browser session) has
		// nothing to diff against -- confirmed live: an unbounded dump of a
		// 592-message Sent folder alone was enough to visibly stall the
		// browser's main thread. findAllIds() must be called with the sort
		// order and a bounded limit, not just the mailbox.
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setMessages(42);
		$mailbox->setUnseen(10);
		$mailbox->setSyncNewToken('a');
		$mailbox->setSyncChangedToken('b');
		$mailbox->setSyncVanishedToken('c');

		$this->freshnessCache->method('get')->with('149')->willReturn(10_003);
		$this->freshnessCache->method('add')->willReturn(true);

		$this->messageMapper->expects($this->once())
			->method('findAllIds')
			->with($mailbox, 'DESC', 50)
			->willReturn([]);

		$this->syncService->syncMailbox(
			$account,
			$mailbox,
			0,
			true,
			null,
			[],
			'DESC'
		);
	}

	public function testStaleFreshnessMarkerRunsARealSyncAndArmsTheGate(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setMessages(42);
		$mailbox->setUnseen(10);
		$mailbox->setSyncNewToken('a');
		$mailbox->setSyncChangedToken('b');
		$mailbox->setSyncVanishedToken('c');

		$this->freshnessCache->method('get')->willReturn(null);
		$this->freshnessCache->method('add')->willReturn(true);
		$this->clientFactory
			->method('getClient')
			->willReturn($this->createStub(\Horde_Imap_Client_Socket::class));
		$this->messageMapper->method('findUidsForIds')->willReturn([]);
		$this->synchronizer->expects($this->once())->method('sync');
		$this->mailboxSync->expects($this->once())->method('syncStats');
		// now (10_000) + SYNC_FRESHNESS_WINDOW (18)
		$this->freshnessCache->expects($this->once())
			->method('set')
			->with('149', 10_018, $this->greaterThan(18));

		$this->syncService->syncMailbox(
			$account,
			$mailbox,
			0,
			true,
			null,
			[]
		);
	}

	public function testLockedMailboxServesTheDatabaseDiffOnPartialSync(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setMessages(42);
		$mailbox->setUnseen(10);
		$mailbox->setSyncNewToken('a');
		$mailbox->setSyncChangedToken('b');
		$mailbox->setSyncVanishedToken('c');

		$this->freshnessCache->method('get')->willReturn(null);
		$this->freshnessCache->method('add')->willReturn(true);
		$client = $this->createMock(\Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($client);
		$this->messageMapper->method('findUidsForIds')->willReturn([]);
		$this->synchronizer->expects($this->once())
			->method('sync')
			->willThrowException(\OCA\Mail\Exception\MailboxLockedException::from($mailbox));
		// The lock conflict must not leak out as a 409: the other caller's
		// sync is filling the database right now, so the current diff is
		// served instead.
		$this->mailboxSync->expects($this->never())->method('syncStats');
		$this->freshnessCache->expects($this->never())->method('set');
		$client->expects($this->once())->method('logout');

		$response = $this->syncService->syncMailbox(
			$account,
			$mailbox,
			0,
			true,
			null,
			[]
		);

		$this->assertEquals(new Response([], [], [], new MailboxStats(42, 10, null)), $response);
	}

	public function testLockedMailboxStillPropagatesForInitialSync(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);

		$this->freshnessCache->method('get')->willReturn(null);
		$this->clientFactory->method('getClient')
			->willReturn($this->createStub(\Horde_Imap_Client_Socket::class));
		$this->messageMapper->method('findUidsForIds')->willReturn([]);
		$this->synchronizer->method('sync')
			->willThrowException(\OCA\Mail\Exception\MailboxLockedException::from($mailbox));

		$this->expectException(\OCA\Mail\Exception\MailboxLockedException::class);
		$this->syncService->syncMailbox(
			$account,
			$mailbox,
			0,
			false,
			null,
			[]
		);
	}

	public function testIsMailboxFreshReflectsTheMarker(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(149);

		$this->freshnessCache->method('get')->with('149')
			->willReturnOnConsecutiveCalls(10_003, null);

		$this->assertTrue($this->syncService->isMailboxFresh($mailbox));
		$this->assertFalse($this->syncService->isMailboxFresh($mailbox));
	}

	public function testARealSyncAlreadyInFlightServesTheDatabaseDiff(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setMessages(42);
		$mailbox->setUnseen(10);
		$mailbox->setSyncNewToken('a');
		$mailbox->setSyncChangedToken('b');
		$mailbox->setSyncVanishedToken('c');

		$this->freshnessCache->method('get')->willReturn(null);
		// Another caller holds the real-sync mutex.
		$this->freshnessCache->method('add')->with('syncing_149', 1, 180)->willReturn(false);

		$this->clientFactory->expects($this->never())->method('getClient');
		$this->synchronizer->expects($this->never())->method('sync');

		$response = $this->syncService->syncMailbox(
			$account,
			$mailbox,
			0,
			true,
			null,
			[]
		);

		$this->assertEquals(new Response([], [], [], new MailboxStats(42, 10, null)), $response);
	}

	public function testTheRealSyncWinnerReleasesTheMutex(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setMessages(42);
		$mailbox->setUnseen(10);
		$mailbox->setSyncNewToken('a');
		$mailbox->setSyncChangedToken('b');
		$mailbox->setSyncVanishedToken('c');

		$this->freshnessCache->method('get')->willReturn(null);
		$this->freshnessCache->method('add')->willReturn(true);
		$this->freshnessCache->expects($this->once())
			->method('remove')
			->with('syncing_149');
		$this->clientFactory->method('getClient')
			->willReturn($this->createStub(\Horde_Imap_Client_Socket::class));
		$this->messageMapper->method('findUidsForIds')->willReturn([]);
		$this->synchronizer->expects($this->once())->method('sync');

		$this->syncService->syncMailbox(
			$account,
			$mailbox,
			0,
			true,
			null,
			[]
		);
	}

	public function testIsServerBusyReflectsTheGlobalLoadCounter(): void {
		$this->freshnessCache->method('get')->with('real_syncs_in_flight')
			->willReturnOnConsecutiveCalls(null, 1, 2, 5);

		// No counter at all: never claim busy.
		$this->assertFalse($this->syncService->isServerBusy());
		// Below LOAD_BUSY_THRESHOLD (2): not busy.
		$this->assertFalse($this->syncService->isServerBusy());
		// At the threshold: busy.
		$this->assertTrue($this->syncService->isServerBusy());
		// Above it: still busy.
		$this->assertTrue($this->syncService->isServerBusy());
	}

	public function testIsServerBusyNeverClaimsBusyWithoutADistributedMemcache(): void {
		$cacheFactory = $this->createMock(\OCP\ICacheFactory::class);
		// A plain ICache, not IMemcache -- no inc()/dec()/add() available.
		$cacheFactory->method('createDistributed')->willReturn($this->createStub(\OCP\ICache::class));
		$syncService = new SyncService(
			$this->clientFactory,
			$this->synchronizer,
			$this->createStub(FilterStringParser::class),
			$this->messageMapper,
			$this->createStub(PreviewEnhancer::class),
			$this->createStub(\Psr\Log\LoggerInterface::class),
			$this->mailboxSync,
			$cacheFactory,
			$this->timeFactory
		);

		$this->assertFalse($syncService->isServerBusy());
	}

	public function testARealSyncIncrementsAndDecrementsTheGlobalLoadCounter(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setMessages(42);
		$mailbox->setUnseen(10);
		$mailbox->setSyncNewToken('a');
		$mailbox->setSyncChangedToken('b');
		$mailbox->setSyncVanishedToken('c');

		$this->freshnessCache->method('get')->willReturn(null);
		// add() is called for TWO different keys (the per-mailbox mutex and
		// the global load counter) -- track calls manually rather than a
		// single strict ->with() matcher, which can only pin one call site.
		$addCalls = [];
		$this->freshnessCache->method('add')->willReturnCallback(
			function (string $key, $value, int $ttl) use (&$addCalls) {
				$addCalls[] = [$key, $value, $ttl];
				return true;
			}
		);
		$this->clientFactory->method('getClient')
			->willReturn($this->createStub(\Horde_Imap_Client_Socket::class));
		$this->messageMapper->method('findUidsForIds')->willReturn([]);
		$this->synchronizer->method('sync')->willReturn(true);

		$this->freshnessCache->expects($this->once())->method('inc')
			->with('real_syncs_in_flight');
		$this->freshnessCache->expects($this->once())->method('dec')
			->with('real_syncs_in_flight');

		$this->syncService->syncMailbox($account, $mailbox, 0, true, null, []);

		$this->assertContains(['real_syncs_in_flight', 0, 120], $addCalls);
	}

	public function testTheLoadCounterIsDecrementedEvenWhenTheSyncThrows(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);

		// Initial sync ($partialOnly = false): no mutex involved at all,
		// isolating that the load counter's inc/dec is unconditional on
		// "a real sync is happening", not tied to the mutex outcome.
		$this->freshnessCache->method('get')->willReturn(null);
		$this->clientFactory->method('getClient')
			->willReturn($this->createStub(\Horde_Imap_Client_Socket::class));
		$this->messageMapper->method('findUidsForIds')->willReturn([]);
		$this->synchronizer->method('sync')
			->willThrowException(\OCA\Mail\Exception\MailboxLockedException::from($mailbox));

		$this->freshnessCache->expects($this->once())->method('inc')
			->with('real_syncs_in_flight');
		$this->freshnessCache->expects($this->once())->method('dec')
			->with('real_syncs_in_flight');

		$this->expectException(\OCA\Mail\Exception\MailboxLockedException::class);
		$this->syncService->syncMailbox($account, $mailbox, 0, false, null, []);
	}

	public function testALostMutexRaceNeverIncrementsTheLoadCounter(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setMessages(42);
		$mailbox->setUnseen(10);
		$mailbox->setSyncNewToken('a');
		$mailbox->setSyncChangedToken('b');
		$mailbox->setSyncVanishedToken('c');

		$this->freshnessCache->method('get')->willReturn(null);
		// Another caller holds the real-sync mutex -- this caller never
		// gets anywhere near a real sync, so it must not touch the load
		// counter at all (it isn't the one doing real work).
		$this->freshnessCache->method('add')->with('syncing_149', 1, 180)->willReturn(false);
		$this->freshnessCache->expects($this->never())->method('inc');
		$this->freshnessCache->expects($this->never())->method('dec');

		$this->syncService->syncMailbox($account, $mailbox, 0, true, null, []);
	}

	public function testInitialSyncBypassesTheFreshnessGate(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('user');
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setMessages(42);
		$mailbox->setUnseen(10);

		// Even with a fresh marker, an initial sync must run for real.
		$this->freshnessCache->method('get')->willReturn(10_003);
		$this->clientFactory
			->method('getClient')
			->willReturn($this->createStub(\Horde_Imap_Client_Socket::class));
		$this->messageMapper->method('findUidsForIds')->willReturn([]);
		$this->synchronizer->expects($this->once())->method('sync');

		$this->syncService->syncMailbox(
			$account,
			$mailbox,
			0,
			false,
			null,
			[]
		);
	}
}
