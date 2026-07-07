<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2017 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Tests\Unit\IMAP\Sync;

use ChristophWurst\Nextcloud\Testing\TestCase;
use Horde_Imap_Client;
use Horde_Imap_Client_Base;
use Horde_Imap_Client_Data_Capability_Imap;
use Horde_Imap_Client_Data_Sync;
use Horde_Imap_Client_Ids;
use Horde_Imap_Client_Mailbox;
use OCA\Mail\Cache\HordeSyncTokenParser;
use OCA\Mail\IMAP\MessageMapper;
use OCA\Mail\IMAP\Sync\Request;
use OCA\Mail\IMAP\Sync\Response;
use OCA\Mail\IMAP\Sync\Synchronizer;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;
use function base64_encode;
use function range;

class SynchronizerTest extends TestCase {
	/** @var MessageMapper|MockObject */
	private $mapper;

	/** @var LoggerInterface|MockObject */
	private $logger;

	/** @var Synchronizer */
	private $synchronizer;

	protected function setUp(): void {
		parent::setUp();

		$this->mapper = $this->createMock(MessageMapper::class);
		$this->logger = $this->createMock(LoggerInterface::class);

		$this->synchronizer = new Synchronizer($this->mapper, new HordeSyncTokenParser());
	}

	public function testSyncWithQresync(): void {
		$imapClient = $this->createMock(Horde_Imap_Client_Base::class);
		$request = new Request('abcdef', 'inbox', '123456', []);
		$hordeSync = $this->createMock(Horde_Imap_Client_Data_Sync::class);
		$imapClient->expects($this->once())
			->method('sync')
			->with($this->equalTo(new Horde_Imap_Client_Mailbox('inbox')), $this->equalTo('123456'))
			->willReturn($hordeSync);
		$newMessages = [];
		$changedMessages = [];
		$vanishedMessageUids = [4, 5];
		$hordeSync->expects($this->exactly(3))
			->method('__get')
			->willReturnMap([
				['newmsgsuids', new Horde_Imap_Client_Ids($newMessages)],
				['flagsuids', new Horde_Imap_Client_Ids($changedMessages)],
				['vanisheduids', new Horde_Imap_Client_Ids($vanishedMessageUids)],
			]);
		$expected = new Response($newMessages, $changedMessages, $vanishedMessageUids);

		$newResponse = $this->synchronizer->sync(
			$imapClient,
			$request,
			'user',
			true,
			$this->logger,
			Horde_Imap_Client::SYNC_NEWMSGSUIDS,
		);
		$changedResponse = $this->synchronizer->sync(
			$imapClient,
			$request,
			'user',
			true,
			$this->logger,
			Horde_Imap_Client::SYNC_FLAGSUIDS,
		);
		$vanishedResponse = $this->synchronizer->sync(
			$imapClient,
			$request,
			'user',
			true,
			$this->logger,
			Horde_Imap_Client::SYNC_VANISHEDUIDS
		);

		$this->assertEquals($expected, $newResponse);
		$this->assertEquals($expected, $changedResponse);
		$this->assertEquals($expected, $vanishedResponse);
	}

	public function testSyncChunked(): void {
		$imapClient = $this->createMock(Horde_Imap_Client_Base::class);
		$request = new Request(
			'abcdef',
			'inbox',
			'123456',
			range(1, 8000, 2), // 19444 bytes
		);
		$hordeSync = $this->createMock(Horde_Imap_Client_Data_Sync::class);
		$imapClient->expects($this->exactly(3))
			->method('sync')
			->with($this->equalTo(new Horde_Imap_Client_Mailbox('inbox')), $this->equalTo('123456'))
			->willReturn($hordeSync);
		$newMessages = $changedMessages = $vanishedMessageUids = [];
		$hordeSync->expects($this->any())
			->method('__get')
			->willReturn(new Horde_Imap_Client_Ids([]));
		$expected = new Response($newMessages, $changedMessages, $vanishedMessageUids);

		$response = $this->synchronizer->sync(
			$imapClient,
			$request,
			'user',
			false,
			$this->logger,
			Horde_Imap_Client::SYNC_VANISHEDUIDS
		);

		$this->assertEquals($expected, $response);
	}

	public function testSyncFlagsViaCondstoreSmallSetIsOneRestrictedRoundTrip(): void {
		// base64('U100,V200,H300'): the token carries a HIGHESTMODSEQ and the
		// server has CONDSTORE. A known-UID set that fits one command is
		// passed as the ids restriction of a single MODSEQ sync -- vital for
		// the web path, whose token only advances on background syncs.
		$token = base64_encode('U100,V200,H300');
		$request = new Request('abcdef', 'inbox', $token, [8, 9, 10]);

		$capability = $this->createMock(Horde_Imap_Client_Data_Capability_Imap::class);
		$capability->method('isEnabled')->with('CONDSTORE')->willReturn(true);
		$imapClient = $this->createMock(Horde_Imap_Client_Base::class);
		$imapClient->method('__get')->with('capability')->willReturn($capability);

		$hordeSync = $this->createMock(Horde_Imap_Client_Data_Sync::class);
		$hordeSync->method('__get')
			->with('flagsuids')
			->willReturn(new Horde_Imap_Client_Ids([8]));
		$imapClient->expects($this->once())
			->method('sync')
			->with(
				$this->equalTo(new Horde_Imap_Client_Mailbox('inbox')),
				$this->equalTo($token),
				$this->callback(fn (array $opts) => $opts['criteria'] === Horde_Imap_Client::SYNC_FLAGSUIDS
					&& isset($opts['ids'])),
			)
			->willReturn($hordeSync);

		$this->synchronizer->sync(
			$imapClient,
			$request,
			'user',
			false,
			$this->logger,
			Horde_Imap_Client::SYNC_FLAGSUIDS,
		);
	}

	public function testSyncFlagsViaCondstoreLargeSetIsOneUnrestrictedRoundTripIntersectedLocally(): void {
		$token = base64_encode('U100,V200,H300');
		// Too many UIDs for a single command: one UNRESTRICTED search, then
		// a local intersect (unknown changed UIDs are new messages, the new
		// phase's job).
		$known = range(1, 8000, 2);
		$request = new Request('abcdef', 'inbox', $token, $known);

		$capability = $this->createMock(Horde_Imap_Client_Data_Capability_Imap::class);
		$capability->method('isEnabled')->with('CONDSTORE')->willReturn(true);
		$imapClient = $this->createMock(Horde_Imap_Client_Base::class);
		$imapClient->method('__get')->with('capability')->willReturn($capability);

		$hordeSync = $this->createMock(Horde_Imap_Client_Data_Sync::class);
		$hordeSync->method('__get')
			->with('flagsuids')
			->willReturn(new Horde_Imap_Client_Ids([7, 9, 10002]));
		$imapClient->expects($this->once())
			->method('sync')
			->with(
				$this->equalTo(new Horde_Imap_Client_Mailbox('inbox')),
				$this->equalTo($token),
				$this->equalTo(['criteria' => Horde_Imap_Client::SYNC_FLAGSUIDS]),
			)
			->willReturn($hordeSync);

		$this->mapper->expects($this->exactly(2))
			->method('findByIds')
			->willReturnCallback(function ($client, $mailbox, $ids) {
				// First call: new messages (empty). Second: the changed set,
				// intersected down to known UIDs (10002 dropped: unknown;
				// 7 and 9 kept: odd numbers are in range(1, 8000, 2)).
				static $call = 0;
				$call++;
				if ($call === 2) {
					$this->assertEquals(new Horde_Imap_Client_Ids([7, 9]), $ids);
				}
				return [];
			});

		$this->synchronizer->sync(
			$imapClient,
			$request,
			'user',
			false,
			$this->logger,
			Horde_Imap_Client::SYNC_FLAGSUIDS,
		);
	}

	public function testSyncFlagsWithoutCondstoreStaysChunkedAndRestricted(): void {
		$token = base64_encode('U100,V200,H300');
		$request = new Request('abcdef', 'inbox', $token, [8, 9, 10]);

		$capability = $this->createMock(Horde_Imap_Client_Data_Capability_Imap::class);
		$capability->method('isEnabled')->with('CONDSTORE')->willReturn(false);
		$imapClient = $this->createMock(Horde_Imap_Client_Base::class);
		$imapClient->method('__get')->with('capability')->willReturn($capability);

		$hordeSync = $this->createMock(Horde_Imap_Client_Data_Sync::class);
		$hordeSync->method('__get')
			->with('flagsuids')
			->willReturn(new Horde_Imap_Client_Ids([]));
		$imapClient->expects($this->once())
			->method('sync')
			->with(
				$this->equalTo(new Horde_Imap_Client_Mailbox('inbox')),
				$this->equalTo($token),
				$this->callback(fn (array $opts) => isset($opts['ids'])),
			)
			->willReturn($hordeSync);

		$this->synchronizer->sync(
			$imapClient,
			$request,
			'user',
			false,
			$this->logger,
			Horde_Imap_Client::SYNC_FLAGSUIDS,
		);
	}
}
