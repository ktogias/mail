<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\Sync;

use ChristophWurst\Nextcloud\Testing\TestCase;
use Horde_Imap_Client;
use Horde_Imap_Client_Data_Capability_Imap;
use Horde_Imap_Client_Ids;
use Horde_Imap_Client_Socket;
use OCA\Mail\Account;
use OCA\Mail\BackgroundJob\FlagsCatchUpJob;
use OCA\Mail\BackgroundJob\RepairMailboxJob;
use OCA\Mail\Cache\HordeSyncTokenParser;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper as DatabaseMessageMapper;
use OCA\Mail\Db\Tag;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Events\NewMessagesSynchronized;
use OCA\Mail\Events\SynchronizationEvent;
use OCA\Mail\Exception\IncompleteSyncException;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\MessageMapper as ImapMessageMapper;
use OCA\Mail\IMAP\Sync\Synchronizer;
use OCA\Mail\Model\IMAPMessage;
use OCA\Mail\Service\Classification\NewMessagesClassifier;
use OCA\Mail\Service\Sync\ImapToDbSynchronizer;
use OCA\Mail\Service\Sync\SyncFastPathStats;
use OCA\Mail\Support\PerformanceLogger;
use OCA\Mail\Support\PerformanceLoggerTask;
use OCP\BackgroundJob\IJobList;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\ICache;
use OCP\ICacheFactory;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class ImapToDbSynchronizerTest extends TestCase {
	private DatabaseMessageMapper&MockObject $dbMapper;
	private IMAPClientFactory&MockObject $clientFactory;
	private ImapMessageMapper&MockObject $imapMapper;
	private MailboxMapper&MockObject $mailboxMapper;
	private IEventDispatcher&MockObject $dispatcher;
	private PerformanceLogger&MockObject $performanceLogger;
	private SyncFastPathStats&MockObject $fastPathStats;
	private IJobList&MockObject $jobList;
	private ICache&MockObject $repairCooldownCache;
	private ICacheFactory&MockObject $cacheFactory;
	private ImapToDbSynchronizer $synchronizer;

	protected function setUp(): void {
		parent::setUp();
		$this->dbMapper = $this->createMock(DatabaseMessageMapper::class);
		$this->clientFactory = $this->createMock(IMAPClientFactory::class);
		$this->imapMapper = $this->createMock(ImapMessageMapper::class);
		$this->mailboxMapper = $this->createMock(MailboxMapper::class);
		$this->dispatcher = $this->createMock(IEventDispatcher::class);
		$this->performanceLogger = $this->createMock(PerformanceLogger::class);
		$this->performanceLogger->method('startWithLogger')
			->willReturn($this->createStub(PerformanceLoggerTask::class));
		$this->fastPathStats = $this->createMock(SyncFastPathStats::class);
		$this->jobList = $this->createMock(IJobList::class);
		$this->repairCooldownCache = $this->createMock(ICache::class);
		$this->cacheFactory = $this->createMock(ICacheFactory::class);
		$this->cacheFactory->method('createDistributed')
			->willReturn($this->repairCooldownCache);
		$this->synchronizer = new ImapToDbSynchronizer(
			$this->dbMapper,
			$this->clientFactory,
			$this->imapMapper,
			$this->mailboxMapper,
			$this->createStub(DatabaseMessageMapper::class),
			$this->createStub(Synchronizer::class),
			$this->dispatcher,
			$this->performanceLogger,
			$this->createStub(LoggerInterface::class),
			$this->createStub(IMailManager::class),
			$this->createStub(TagMapper::class),
			$this->createStub(NewMessagesClassifier::class),
			new HordeSyncTokenParser(),
			$this->fastPathStats,
			$this->jobList,
			$this->cacheFactory,
		);
	}

	public function testInitialSyncGetsSyncTokenFromCacheClient(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$account = new Account($mailAccount);
		$mailbox = new Mailbox();
		$mailbox->setId(100);
		$mailbox->setName('INBOX');
		$mailbox->setAccountId(1);
		$mailbox->setSelectable(true);
		$capability = $this->createMock(Horde_Imap_Client_Data_Capability_Imap::class);
		$capability->method('isEnabled')->with('QRESYNC')->willReturn(false);
		$initialClient = $this->createMock(Horde_Imap_Client_Socket::class);
		$initialClient->method('__get')->with('capability')->willReturn($capability);
		$noCacheClient = $this->createStub(Horde_Imap_Client_Socket::class);
		$initialClient->expects($this->once())
			->method('getSyncToken')
			->with('INBOX')
			->willReturn('dG9rZW5XaXRoSA==');
		$this->clientFactory->expects($this->once())
			->method('getClient')
			->with($account, false)
			->willReturn($noCacheClient);
		$this->dbMapper->method('findHighestUid')->willReturn(null);
		$this->imapMapper->method('findAll')->willReturn([
			'messages' => [],
			'all' => true,
			'total' => 0,
		]);
		$this->mailboxMapper->expects($this->once())
			->method('update')
			->with($this->callback(fn (Mailbox $mb) => $mb->getSyncNewToken() === 'dG9rZW5XaXRoSA=='
					&& $mb->getSyncChangedToken() === 'dG9rZW5XaXRoSA=='
					&& $mb->getSyncVanishedToken() === 'dG9rZW5XaXRoSA=='));
		// backgroundSync must be false here: this is the per-mailbox path a
		// browser takes, and it is what decides whether the full thread
		// reconciliation -- 274MB and ~6s on a large account -- is allowed to
		// run inside the request. See
		// AccountSynchronizedThreadUpdaterListener.
		$this->dispatcher->expects($this->once())
			->method('dispatchTyped')
			->with($this->callback(static fn (SynchronizationEvent $event): bool => !$event->isBackgroundSync()));
		$this->synchronizer->sync(
			$account,
			$initialClient,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
	}

	public function testAnIncompleteInitialSyncDoesNotPayForATotalNobodyReads(): void {
		// The IncompleteSyncException message is diagnostic and no caller reads
		// it -- every catcher logs it under ['exception' => $e] at DEBUG, or
		// turns it into an HTTP status. At this deployment's loglevel it is
		// built and discarded.
		//
		// It used to report the mailbox's whole cached count. Measured live on
		// 2026-07-29 against the 757k-row swco/Site Philosophy, countByMailbox()
		// was an index-only scan taking 4.4s warm and 18s cold -- once per
		// backfill batch, for a string nobody reads. What this pass persisted
		// is already in hand and answers the more useful question anyway.
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$account = new Account($mailAccount);
		$mailbox = new Mailbox();
		$mailbox->setId(190);
		$mailbox->setName('Huge');
		$mailbox->setAccountId(1);
		$mailbox->setSelectable(true);

		$capability = $this->createMock(Horde_Imap_Client_Data_Capability_Imap::class);
		$capability->method('isEnabled')->with('QRESYNC')->willReturn(false);
		$initialClient = $this->createMock(Horde_Imap_Client_Socket::class);
		$initialClient->method('__get')->with('capability')->willReturn($capability);
		$this->clientFactory->method('getClient')->willReturn($this->createStub(Horde_Imap_Client_Socket::class));
		$this->dbMapper->method('findHighestUid')->willReturn(null);
		$this->dbMapper->method('findLowestUid')->willReturn(null);

		$dbMessage = new Message();
		$imapMessage = $this->createMock(IMAPMessage::class);
		$imapMessage->method('toDbMessage')->willReturn($dbMessage);
		$this->imapMapper->method('findAll')->willReturn([
			'messages' => [$imapMessage, $imapMessage, $imapMessage],
			'all' => false,
			'total' => 773157,
		]);

		// The whole point: no aggregate over the mailbox on this path.
		$this->dbMapper->expects(self::never())->method('countByMailbox');

		try {
			$this->synchronizer->sync(
				$account,
				$initialClient,
				$mailbox,
				$this->createStub(LoggerInterface::class),
			);
			self::fail('an incomplete initial sync must throw IncompleteSyncException');
		} catch (IncompleteSyncException $e) {
			// Still says something useful: whether this pass advanced, and how
			// far there is to go.
			self::assertStringContainsString('3 messages cached this pass', $e->getMessage());
			self::assertStringContainsString('773157 on the server', $e->getMessage());
		}
	}

	public function testRepairSyncBackfillsAMissingNewestUidWithoutWaitingForAnotherMessage(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$account = new Account($mailAccount);
		$mailbox = $this->buildPartialSyncMailbox();
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$dbMessage = new Message();
		$imapMessage = $this->createMock(IMAPMessage::class);
		$imapMessage->method('toDbMessage')->with(149, $mailAccount)->willReturn($dbMessage);

		$this->mailboxMapper->expects(self::once())->method('lockForNewSync')->with($mailbox);
		$this->mailboxMapper->expects(self::once())->method('lockForVanishedSync')->with($mailbox);
		$this->mailboxMapper->expects(self::once())->method('unlockFromVanishedSync')->with($mailbox);
		$this->mailboxMapper->expects(self::once())->method('unlockFromNewSync')->with($mailbox);
		$this->clientFactory->expects(self::once())->method('getClient')->with($account, false)->willReturn($client);
		$this->dbMapper->expects(self::once())->method('findAllUids')->with($mailbox)->willReturn([1, 2]);
		$client->expects(self::once())->method('vanished')->willReturn(new Horde_Imap_Client_Ids());
		$client->expects(self::once())->method('search')->willReturn([
			'match' => new Horde_Imap_Client_Ids([1, 2, 3]),
		]);
		$client->expects(self::once())->method('logout');
		$this->imapMapper->expects(self::once())
			->method('findByIds')
			->with($client, 'INBOX', self::callback(static fn (Horde_Imap_Client_Ids $ids) => $ids->ids === [3]), 'user')
			->willReturn([$imapMessage]);
		$this->dbMapper->expects(self::once())->method('insertBulk')->with($account, $dbMessage);

		$tag = new Tag();
		$tagMapper = $this->createStub(TagMapper::class);
		$tagMapper->method('getTagByImapLabel')->with(Tag::LABEL_IMPORTANT, 'user')->willReturn($tag);
		$classifier = $this->createMock(NewMessagesClassifier::class);
		$classifier->expects(self::once())->method('classifyNewMessages')->with([$dbMessage], $mailbox, $account, $tag);
		$this->dispatcher->expects(self::once())
			->method('dispatch')
			->with(NewMessagesSynchronized::class, self::isInstanceOf(NewMessagesSynchronized::class));

		self::assertSame(1, $this->buildSynchronizerWithSyncMock(
			$this->createStub(Synchronizer::class),
			$tagMapper,
			$classifier,
		)->repairSync($account, $mailbox, $this->createStub(LoggerInterface::class)));
	}

	/**
	 * A mailbox already being synced by another process (a frequently
	 * contended INBOX, say) used to abort syncAccount()'s whole loop --
	 * every mailbox after it in iteration order never got a chance to sync
	 * at all, on any run, for as long as that one mailbox kept getting
	 * locked by something else. Confirmed live: three mailboxes on one
	 * account never finished their initial cache sync for this exact
	 * reason.
	 */
	public function testSyncAccountSkipsALockedMailboxAndContinuesWithTheRest(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$account = new Account($mailAccount);

		$lockedMailbox = new Mailbox();
		$lockedMailbox->setId(100);
		$lockedMailbox->setName('Locked');
		$lockedMailbox->setAccountId(1);
		$lockedMailbox->setSyncInBackground(true);

		$okMailbox = new Mailbox();
		$okMailbox->setId(200);
		$okMailbox->setName('OK');
		$okMailbox->setAccountId(1);
		$okMailbox->setSyncInBackground(true);

		$this->mailboxMapper->method('findAll')
			->with($account)
			->willReturn([$lockedMailbox, $okMailbox]);
		$this->clientFactory->method('getClient')
			->with($account)
			->willReturn($this->createStub(Horde_Imap_Client_Socket::class));

		/** @var ImapToDbSynchronizer&MockObject $synchronizer */
		$synchronizer = $this->getMockBuilder(ImapToDbSynchronizer::class)
			->setConstructorArgs([
				$this->dbMapper,
				$this->clientFactory,
				$this->imapMapper,
				$this->mailboxMapper,
				$this->createStub(DatabaseMessageMapper::class),
				$this->createStub(Synchronizer::class),
				$this->dispatcher,
				$this->performanceLogger,
				$this->createStub(LoggerInterface::class),
				$this->createStub(IMailManager::class),
				$this->createStub(TagMapper::class),
				$this->createStub(NewMessagesClassifier::class),
				new HordeSyncTokenParser(),
				$this->fastPathStats,
				$this->jobList,
				$this->cacheFactory,
			])
			->onlyMethods(['sync'])
			->getMock();

		$synchronizer->expects($this->exactly(2))
			->method('sync')
			->willReturnCallback(function ($_account, $_client, Mailbox $mailbox) use ($lockedMailbox) {
				if ($mailbox->getId() === $lockedMailbox->getId()) {
					throw MailboxLockedException::from($mailbox);
				}
				return true;
			});

		// The other mailbox's own sync still ran (proven by $rebuildThreads
		// making it true, from that call's own return value) and
		// syncAccount() itself didn't throw or abort early.
		// backgroundSync must be true: syncAccount() is only reached from
		// SyncJob on cron and from occ, and it is the ONLY path allowed to run
		// the full thread reconciliation. Drop the flag here and the
		// subject-only merges of ThreadBuilder step 5 stop being reconciled
		// anywhere, silently.
		$this->dispatcher->expects($this->once())
			->method('dispatchTyped')
			->with($this->callback(static fn (SynchronizationEvent $event): bool => $event->isRebuildThreads()
				&& $event->isBackgroundSync()));

		$synchronizer->syncAccount($account, $this->createStub(LoggerInterface::class));
	}

	/**
	 * Same starvation shape as the locked-mailbox case above, for a
	 * different exception: a mailbox large enough to need several batches
	 * to finish its initial sync throws IncompleteSyncException on every
	 * single tick until it's fully cached (one batch per sync() call --
	 * see runInitialSync()). Left uncaught here, that mailbox would abort
	 * the WHOLE account's sync pass on every single SyncJob run, so every
	 * mailbox after it in iteration order never got its own background
	 * sync at all, for as long as the big one stayed incomplete.
	 */
	public function testSyncAccountSkipsAnIncompleteMailboxAndContinuesWithTheRest(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$account = new Account($mailAccount);

		$hugeMailbox = new Mailbox();
		$hugeMailbox->setId(190);
		$hugeMailbox->setName('Huge');
		$hugeMailbox->setAccountId(1);
		$hugeMailbox->setSyncInBackground(true);

		$okMailbox = new Mailbox();
		$okMailbox->setId(200);
		$okMailbox->setName('OK');
		$okMailbox->setAccountId(1);
		$okMailbox->setSyncInBackground(true);

		$this->mailboxMapper->method('findAll')
			->with($account)
			->willReturn([$hugeMailbox, $okMailbox]);
		$this->clientFactory->method('getClient')
			->with($account)
			->willReturn($this->createStub(Horde_Imap_Client_Socket::class));

		/** @var ImapToDbSynchronizer&MockObject $synchronizer */
		$synchronizer = $this->getMockBuilder(ImapToDbSynchronizer::class)
			->setConstructorArgs([
				$this->dbMapper,
				$this->clientFactory,
				$this->imapMapper,
				$this->mailboxMapper,
				$this->createStub(DatabaseMessageMapper::class),
				$this->createStub(Synchronizer::class),
				$this->dispatcher,
				$this->performanceLogger,
				$this->createStub(LoggerInterface::class),
				$this->createStub(IMailManager::class),
				$this->createStub(TagMapper::class),
				$this->createStub(NewMessagesClassifier::class),
				new HordeSyncTokenParser(),
				$this->fastPathStats,
				$this->jobList,
				$this->cacheFactory,
			])
			->onlyMethods(['sync'])
			->getMock();

		$synchronizer->expects($this->exactly(2))
			->method('sync')
			->willReturnCallback(function ($_account, $_client, Mailbox $mailbox) use ($hugeMailbox) {
				if ($mailbox->getId() === $hugeMailbox->getId()) {
					throw new IncompleteSyncException('Initial sync is not complete for 1:Huge (5000 of 773157 messages cached).');
				}
				return true;
			});

		// The other mailbox's own sync still ran (proven by $rebuildThreads
		// making it true, from that call's own return value) and
		// syncAccount() itself didn't throw or abort early.
		$this->dispatcher->expects($this->once())
			->method('dispatchTyped')
			->with($this->callback(fn (SynchronizationEvent $event) => $event->isRebuildThreads()));

		$synchronizer->syncAccount($account, $this->createStub(LoggerInterface::class));
	}

	private function buildSynchronizerWithSyncMock(
		Synchronizer&MockObject $imapSync,
		?TagMapper $tagMapper = null,
		?NewMessagesClassifier $classifier = null,
	): ImapToDbSynchronizer {
		return new ImapToDbSynchronizer(
			$this->dbMapper,
			$this->clientFactory,
			$this->imapMapper,
			$this->mailboxMapper,
			$this->createStub(DatabaseMessageMapper::class),
			$imapSync,
			$this->dispatcher,
			$this->performanceLogger,
			$this->createStub(LoggerInterface::class),
			$this->createStub(IMailManager::class),
			$tagMapper ?? $this->createStub(TagMapper::class),
			$classifier ?? $this->createStub(NewMessagesClassifier::class),
			new HordeSyncTokenParser(),
			$this->fastPathStats,
			$this->jobList,
			$this->cacheFactory,
		);
	}

	private function buildPartialSyncMailbox(): Mailbox {
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setName('INBOX');
		$mailbox->setAccountId(1);
		$mailbox->setSelectable(true);
		// base64('U100,V200,H300'): UIDNEXT 100, UIDVALIDITY 200, HIGHESTMODSEQ 300
		$token = base64_encode('U100,V200,H300');
		$mailbox->setSyncNewToken($token);
		$mailbox->setSyncChangedToken($token);
		$mailbox->setSyncVanishedToken($token);
		return $mailbox;
	}

	private function buildStatusClient(array $status): Horde_Imap_Client_Socket&MockObject {
		$capability = $this->createMock(Horde_Imap_Client_Data_Capability_Imap::class);
		$capability->method('isEnabled')->with('QRESYNC')->willReturn(false);
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$client->method('__get')->with('capability')->willReturn($capability);
		$client->method('status')->willReturn($status);
		$client->method('getSyncToken')->willReturn(base64_encode('U101,V200,H301'));
		return $client;
	}

	public function testPartialSyncSkipsAllPhasesWhenStatusMatchesEveryToken(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$account = new Account($mailAccount);
		$mailbox = $this->buildPartialSyncMailbox();

		$client = $this->buildStatusClient([
			'uidvalidity' => 200,
			'uidnext' => 100,
			'highestmodseq' => 300,
			'messages' => 42,
		]);
		$this->dbMapper->method('countByMailbox')->with($mailbox)->willReturn(42);

		$imapSync = $this->createMock(Synchronizer::class);
		$imapSync->expects($this->never())->method('sync');
		// Nothing moved, so no token to persist either.
		$this->mailboxMapper->expects($this->never())->method('update');
		$this->dispatcher->expects($this->once())
			->method('dispatchTyped')
			->with($this->callback(fn (SynchronizationEvent $event) => !$event->isRebuildThreads()));
		$allPhases = Horde_Imap_Client::SYNC_NEWMSGSUIDS | Horde_Imap_Client::SYNC_FLAGSUIDS | Horde_Imap_Client::SYNC_VANISHEDUIDS;
		$this->fastPathStats->expects($this->once())
			->method('recordOutcome')
			->with($allPhases, 0);
		$this->fastPathStats->expects($this->never())->method('recordStatusUnusable');

		$this->buildSynchronizerWithSyncMock($imapSync)->sync(
			$account,
			$client,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
	}

	public function testPartialSyncPrunesOnlyTheProvablyIdlePhases(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$account = new Account($mailAccount);
		$mailbox = $this->buildPartialSyncMailbox();

		// UIDNEXT moved from 100 to 101: something is new, so the new
		// phase must run, and the vanished phase (whose count check can't
		// exclude a simultaneous expunge) must run too -- but the flags
		// phase, whose HIGHESTMODSEQ still matches, is pruned.
		$client = $this->buildStatusClient([
			'uidvalidity' => 200,
			'uidnext' => 101,
			'highestmodseq' => 300,
			'messages' => 42,
		]);
		$this->dbMapper->method('countByMailbox')->willReturn(42);
		$this->dbMapper->method('findAllUids')->willReturn([]);
		$this->dbMapper->method('findHighestUid')->willReturn(null);

		$response = new \OCA\Mail\IMAP\Sync\Response([], [], []);
		$imapSync = $this->createMock(Synchronizer::class);
		$imapSync->expects($this->exactly(2))
			->method('sync')
			->willReturn($response);
		$this->mailboxMapper->expects($this->once())->method('update');
		$allPhases = Horde_Imap_Client::SYNC_NEWMSGSUIDS | Horde_Imap_Client::SYNC_FLAGSUIDS | Horde_Imap_Client::SYNC_VANISHEDUIDS;
		$keptNewAndVanished = Horde_Imap_Client::SYNC_NEWMSGSUIDS | Horde_Imap_Client::SYNC_VANISHEDUIDS;
		$this->fastPathStats->expects($this->once())
			->method('recordOutcome')
			->with($allPhases, $keptNewAndVanished);

		$this->buildSynchronizerWithSyncMock($imapSync)->sync(
			$account,
			$client,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
	}

	/**
	 * A client whose getSyncToken() reports the server's state AT THE MOMENT
	 * IT IS CALLED, plus a Synchronizer whose sync() advances that state.
	 *
	 * Modelling time rather than call order is what makes these tests able to
	 * fail. A mock keyed on call index would hand the pre-sync value to
	 * whichever call came first, so the pre-.132 code -- one getSyncToken()
	 * after the pass -- would receive the early token and appear correct.
	 * Here it receives what the server would really have said by then.
	 *
	 * @param callable(): void $advanceOnSync mutates the server state
	 */
	private function buildRaceClient(
		array $status,
		callable $tokenNow,
		callable $advanceOnSync,
	): array {
		$capability = $this->createMock(Horde_Imap_Client_Data_Capability_Imap::class);
		$capability->method('isEnabled')->with('QRESYNC')->willReturn(false);
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$client->method('__get')->with('capability')->willReturn($capability);
		$client->method('status')->willReturn($status);
		$client->method('getSyncToken')->willReturnCallback($tokenNow);

		$imapSync = $this->createMock(Synchronizer::class);
		$imapSync->method('sync')->willReturnCallback(
			function () use ($advanceOnSync): \OCA\Mail\IMAP\Sync\Response {
				$advanceOnSync();
				return new \OCA\Mail\IMAP\Sync\Response([], [], []);
			}
		);

		return [$client, $imapSync];
	}

	private function runPass(
		Horde_Imap_Client_Socket&MockObject $client,
		Synchronizer&MockObject $imapSync,
		Mailbox $mailbox,
	): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$account = new Account($mailAccount);

		$this->dbMapper->method('findAllUids')->willReturn([]);
		$this->dbMapper->method('findHighestUid')->willReturn(null);

		$this->buildSynchronizerWithSyncMock($imapSync)->sync(
			$account,
			$client,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
	}

	private function runPartialSyncPass(Horde_Imap_Client_Socket&MockObject $client, Mailbox $mailbox): void {
		$imapSync = $this->createMock(Synchronizer::class);
		$imapSync->method('sync')->willReturn(new \OCA\Mail\IMAP\Sync\Response([], [], []));
		$this->runPass($client, $imapSync, $mailbox);
	}

	public function testNewPhaseKeepsThePreSyncTokenWhenAMessageArrivesMidPass(): void {
		$mailbox = $this->buildPartialSyncMailbox();
		$this->dbMapper->method('countByMailbox')->willReturn(42);

		// The server is at UIDNEXT 101 when the pass starts and at 103 by the
		// time it ends: two messages landed while this very pass was
		// enumerating, fetching and persisting. The enumeration never saw
		// them, so a token that says 103 would declare them synced forever --
		// exactly how UID 7404 was lost on 2026-09-29.
		$uidNext = 101;
		[$client, $imapSync] = $this->buildRaceClient(
			[
				'uidvalidity' => 200,
				'uidnext' => 101,
				'highestmodseq' => 300,
				'messages' => 42,
			],
			static function () use (&$uidNext): string {
				return base64_encode("U$uidNext,V200,H301");
			},
			static function () use (&$uidNext): void {
				$uidNext = 103;
			},
		);

		$this->runPass($client, $imapSync, $mailbox);

		self::assertSame(
			base64_encode('U101,V200,H301'),
			$mailbox->getSyncNewToken(),
			'a pass that was overtaken must persist the token it started with',
		);
	}

	public function testNewPhaseTakesTheLaterTokenWhenNoMessageArrivedMidPass(): void {
		$mailbox = $this->buildPartialSyncMailbox();
		$this->dbMapper->method('countByMailbox')->willReturn(42);

		// Only HIGHESTMODSEQ moves: a flag changed, no message arrived. The
		// later token is therefore safe, and taking it is what lets the STATUS
		// fast path prune this phase on the next poll. Guards against
		// "simplifying" the choice to always keep the conservative token,
		// which would re-enumerate this mailbox forever.
		$modSeq = 301;
		[$client, $imapSync] = $this->buildRaceClient(
			[
				'uidvalidity' => 200,
				'uidnext' => 101,
				'highestmodseq' => 300,
				'messages' => 42,
			],
			static function () use (&$modSeq): string {
				return base64_encode("U101,V200,H$modSeq");
			},
			static function () use (&$modSeq): void {
				$modSeq = 305;
			},
		);

		$this->runPass($client, $imapSync, $mailbox);

		self::assertSame(
			base64_encode('U101,V200,H305'),
			$mailbox->getSyncNewToken(),
			'an undisturbed pass must persist the later token so the fast path keeps working',
		);
	}

	public function testAStatusSurplusOverTheCacheQueuesARepair(): void {
		$mailbox = $this->buildPartialSyncMailbox();

		// UIDNEXT still 100, matching the token: nothing has arrived, so
		// nothing is pending insertion. The server nevertheless reports one
		// message more than the cache holds, which can only be a message that
		// was never cached.
		$client = $this->buildStatusClient([
			'uidvalidity' => 200,
			'uidnext' => 100,
			'highestmodseq' => 300,
			'messages' => 43,
		]);
		$this->dbMapper->method('countByMailbox')->willReturn(42);
		$this->repairCooldownCache->method('get')->willReturn(null);
		$this->jobList->method('has')->willReturn(false);

		$this->jobList->expects($this->once())
			->method('add')
			->with(RepairMailboxJob::class, ['mailboxId' => 149]);
		$this->repairCooldownCache->expects($this->once())
			->method('set')
			->with('149', 1, ImapToDbSynchronizer::REPAIR_REQUEST_COOLDOWN_SECONDS);

		$this->runPartialSyncPass($client, $mailbox);
	}

	public function testAStatusSurplusIsNotRequeuedWhileTheCooldownHolds(): void {
		$mailbox = $this->buildPartialSyncMailbox();

		$client = $this->buildStatusClient([
			'uidvalidity' => 200,
			'uidnext' => 100,
			'highestmodseq' => 300,
			'messages' => 43,
		]);
		$this->dbMapper->method('countByMailbox')->willReturn(42);
		// A repair was already asked for within the cooldown window. A gap the
		// repair cannot close must not queue one every single cron cycle.
		$this->repairCooldownCache->method('get')->willReturn(1);

		$this->jobList->expects($this->never())->method('add');

		$this->runPartialSyncPass($client, $mailbox);
	}

	public function testAMatchingCountQueuesNoRepair(): void {
		$mailbox = $this->buildPartialSyncMailbox();

		$client = $this->buildStatusClient([
			'uidvalidity' => 200,
			'uidnext' => 100,
			'highestmodseq' => 300,
			'messages' => 42,
		]);
		$this->dbMapper->method('countByMailbox')->willReturn(42);
		$this->repairCooldownCache->method('get')->willReturn(null);

		$this->jobList->expects($this->never())->method('add');

		$this->runPartialSyncPass($client, $mailbox);
	}

	/**
	 * .136: the flags phase must not fail forever. A token that cannot advance
	 * makes the next attempt costlier still (Gmail INBOX: 7,440 changes behind,
	 * 36 s of SEARCH against a 20 s deadline), so a failure queues one pass
	 * that is given the time -- and still reports the failure as before.
	 */
	public function testAFailingFlagsPhaseQueuesACatchUpAndStillFails(): void {
		$mailbox = $this->buildPartialSyncMailbox();
		// HIGHESTMODSEQ moved (301 vs the token's 300): only the flags phase runs.
		$client = $this->buildStatusClient([
			'uidvalidity' => 200,
			'uidnext' => 100,
			'highestmodseq' => 301,
			'messages' => 42,
		]);
		$this->dbMapper->method('countByMailbox')->willReturn(42);
		$this->repairCooldownCache->method('get')->willReturn(null);
		$this->jobList->method('has')->willReturn(false);
		$imapSync = $this->createMock(Synchronizer::class);
		$imapSync->method('sync')->willThrowException(new \Horde_Imap_Client_Exception('Error when communicating with the mail server.'));

		$this->jobList->expects($this->once())
			->method('add')
			->with(FlagsCatchUpJob::class, ['mailboxId' => 149]);

		// Reported exactly as before: sync() wraps it, as the live log shows.
		$this->expectException(ServiceException::class);
		$this->runPass($client, $imapSync, $mailbox);
	}

	public function testAFailingFlagsPhaseIsNotRequeuedWithinTheCooldown(): void {
		$mailbox = $this->buildPartialSyncMailbox();
		$client = $this->buildStatusClient([
			'uidvalidity' => 200,
			'uidnext' => 100,
			'highestmodseq' => 301,
			'messages' => 42,
		]);
		$this->dbMapper->method('countByMailbox')->willReturn(42);
		// A catch-up was already asked for: a mailbox the catch-up cannot cure
		// must not queue one every cron cycle.
		$this->repairCooldownCache->method('get')->willReturn(1);
		$imapSync = $this->createMock(Synchronizer::class);
		$imapSync->method('sync')->willThrowException(new \Horde_Imap_Client_Exception('timeout'));

		$this->jobList->expects($this->never())->method('add');

		// Reported exactly as before: sync() wraps it, as the live log shows.
		$this->expectException(ServiceException::class);
		$this->runPass($client, $imapSync, $mailbox);
	}

	public function testPartialSyncKeepsTheFlagsPhaseWithoutAModseqCapableToken(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$account = new Account($mailAccount);
		$mailbox = $this->buildPartialSyncMailbox();
		// Token without an H part: the flags phase can't be proven idle and
		// must run; new (UIDNEXT match) and vanished (count + UIDNEXT match)
		// are still safely pruned.
		$token = base64_encode('U100,V200');
		$mailbox->setSyncNewToken($token);
		$mailbox->setSyncChangedToken($token);
		$mailbox->setSyncVanishedToken($token);

		$client = $this->buildStatusClient([
			'uidvalidity' => 200,
			'uidnext' => 100,
			'highestmodseq' => 300,
			'messages' => 42,
		]);
		$this->dbMapper->method('countByMailbox')->willReturn(42);
		$this->dbMapper->method('findAllUids')->willReturn([]);
		$this->dbMapper->method('findHighestUid')->willReturn(null);

		$response = new \OCA\Mail\IMAP\Sync\Response([], [], []);
		$imapSync = $this->createMock(Synchronizer::class);
		$imapSync->expects($this->exactly(1))
			->method('sync')
			->willReturn($response);
		$allPhases = Horde_Imap_Client::SYNC_NEWMSGSUIDS | Horde_Imap_Client::SYNC_FLAGSUIDS | Horde_Imap_Client::SYNC_VANISHEDUIDS;
		$this->fastPathStats->expects($this->once())
			->method('recordOutcome')
			->with($allPhases, Horde_Imap_Client::SYNC_FLAGSUIDS);

		$this->buildSynchronizerWithSyncMock($imapSync)->sync(
			$account,
			$client,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
	}

	/**
	 * A STATUS round trip that throws (or comes back without enough usable
	 * data) can't prove anything idle -- every phase is kept, same as
	 * before this fast path existed. Recorded as "status_unusable" rather
	 * than folded into the per-phase attempted/pruned counts, since no
	 * phase was actually evaluated against a server value here.
	 */
	public function testPartialSyncRecordsStatusUnusableWhenTheStatusCallFails(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$account = new Account($mailAccount);
		$mailbox = $this->buildPartialSyncMailbox();

		$capability = $this->createMock(Horde_Imap_Client_Data_Capability_Imap::class);
		$capability->method('isEnabled')->with('QRESYNC')->willReturn(false);
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$client->method('__get')->with('capability')->willReturn($capability);
		$client->method('status')->willThrowException(new \Horde_Imap_Client_Exception('boom'));
		$client->method('getSyncToken')->willReturn(base64_encode('U101,V200,H301'));

		$this->dbMapper->method('findAllUids')->willReturn([]);
		$this->dbMapper->method('findHighestUid')->willReturn(null);

		$response = new \OCA\Mail\IMAP\Sync\Response([], [], []);
		$imapSync = $this->createMock(Synchronizer::class);
		$imapSync->expects($this->exactly(3))
			->method('sync')
			->willReturn($response);
		$this->fastPathStats->expects($this->once())->method('recordStatusUnusable');
		$this->fastPathStats->expects($this->never())->method('recordOutcome');

		$this->buildSynchronizerWithSyncMock($imapSync)->sync(
			$account,
			$client,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
	}
}
