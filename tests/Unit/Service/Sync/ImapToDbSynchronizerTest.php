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
use Horde_Imap_Client_Exception;
use Horde_Imap_Client_Socket;
use OCA\Mail\Account;
use OCA\Mail\Cache\HordeSyncTokenParser;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\MessageMapper as DatabaseMessageMapper;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Events\SynchronizationEvent;
use OCA\Mail\Exception\IncompleteSyncException;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\MessageMapper as ImapMessageMapper;
use OCA\Mail\IMAP\Sync\Synchronizer;
use OCA\Mail\Integration\GoogleIntegration;
use OCA\Mail\Integration\MicrosoftIntegration;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\Classification\NewMessagesClassifier;
use OCA\Mail\Service\Sync\ImapToDbSynchronizer;
use OCA\Mail\Service\Sync\SyncFastPathStats;
use OCA\Mail\Support\PerformanceLogger;
use OCA\Mail\Support\PerformanceLoggerTask;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\Security\ICrypto;
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
	private GoogleIntegration&MockObject $googleIntegration;
	private MicrosoftIntegration&MockObject $microsoftIntegration;
	private AccountService&MockObject $accountService;
	private ICrypto&MockObject $crypto;
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
		$this->googleIntegration = $this->createMock(GoogleIntegration::class);
		$this->microsoftIntegration = $this->createMock(MicrosoftIntegration::class);
		$this->accountService = $this->createMock(AccountService::class);
		$this->crypto = $this->createMock(ICrypto::class);
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
			$this->googleIntegration,
			$this->microsoftIntegration,
			$this->accountService,
			$this->crypto,
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
		$this->dispatcher->expects($this->once())
			->method('dispatchTyped')
			->with($this->isInstanceOf(SynchronizationEvent::class));
		$this->synchronizer->sync(
			$account,
			$initialClient,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
	}

	private function googleAccount(): Account {
		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setUserId('user');
		$mailAccount->setEmail('ktogias@gmail.com');
		$mailAccount->setInboundHost('imap.gmail.com');
		$mailAccount->setAuthMethod('xoauth2');
		$mailAccount->setOauthAccessToken('encrypted-old-access-token');
		return new Account($mailAccount);
	}

	private function initialClientForRetryTests(): Horde_Imap_Client_Socket&MockObject {
		$capability = $this->createMock(Horde_Imap_Client_Data_Capability_Imap::class);
		$capability->method('isEnabled')->with('QRESYNC')->willReturn(false);
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$client->method('__get')->with('capability')->willReturn($capability);
		$client->method('getSyncToken')->willReturn('dG9rZW5XaXRoSA==');
		return $client;
	}

	/**
	 * Confirmed live for a Google account well within its stored token's
	 * declared validity window (so not simply a case REFRESH_BUFFER_SECONDS
	 * should have caught): "Mail server denied authentication" still
	 * happens occasionally. sync() must force a real token refresh and
	 * retry login() once before giving up.
	 */
	public function testSyncForcesATokenRefreshAndRetriesLoginOnceAfterAnAuthRejection(): void {
		$account = $this->googleAccount();
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setName('INBOX');
		$mailbox->setAccountId(13);
		$mailbox->setSelectable(true);

		$client = $this->initialClientForRetryTests();
		$loginAttempts = 0;
		$client->expects($this->exactly(2))
			->method('login')
			->willReturnCallback(function () use (&$loginAttempts) {
				$loginAttempts++;
				if ($loginAttempts === 1) {
					throw new Horde_Imap_Client_Exception('Mail server denied authentication.', Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED);
				}
				return null;
			});

		$this->googleIntegration->method('isGoogleOauthAccount')->with($account)->willReturn(true);
		$refreshedMailAccount = new MailAccount();
		$refreshedMailAccount->setId(13);
		$refreshedMailAccount->setEmail('ktogias@gmail.com');
		$refreshedMailAccount->setOauthAccessToken('encrypted-new-access-token');
		$this->googleIntegration->expects($this->once())
			->method('refresh')
			->with($account, true)
			->willReturn(new Account($refreshedMailAccount));
		$this->accountService->expects($this->once())
			->method('update')
			->with($refreshedMailAccount);
		$this->crypto->method('decrypt')->with('encrypted-new-access-token')->willReturn('plaintext-new-access-token');
		$client->expects($this->once())
			->method('setParam')
			->with('xoauth2_token', $this->isInstanceOf(\Horde_Imap_Client_Password_Xoauth2::class));

		$this->dbMapper->method('findHighestUid')->willReturn(null);
		$this->imapMapper->method('findAll')->willReturn([
			'messages' => [],
			'all' => true,
			'total' => 0,
		]);

		$this->synchronizer->sync(
			$account,
			$client,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
	}

	public function testSyncGivesUpAfterASecondAuthRejectionEvenAfterARefresh(): void {
		$account = $this->googleAccount();
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setName('INBOX');
		$mailbox->setAccountId(13);
		$mailbox->setSelectable(true);

		$client = $this->initialClientForRetryTests();
		$client->expects($this->exactly(2))
			->method('login')
			->willThrowException(new Horde_Imap_Client_Exception('Mail server denied authentication.', Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED));

		$this->googleIntegration->method('isGoogleOauthAccount')->with($account)->willReturn(true);
		$refreshedMailAccount = new MailAccount();
		$refreshedMailAccount->setId(13);
		$refreshedMailAccount->setEmail('ktogias@gmail.com');
		$refreshedMailAccount->setOauthAccessToken('encrypted-new-access-token');
		$this->googleIntegration->method('refresh')->willReturn(new Account($refreshedMailAccount));
		$this->crypto->method('decrypt')->willReturn('plaintext-new-access-token');

		$this->expectException(Horde_Imap_Client_Exception::class);
		$this->synchronizer->sync(
			$account,
			$client,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
	}

	public function testSyncDoesNotRetryWhenTheForcedRefreshProducesNoNewToken(): void {
		$account = $this->googleAccount();
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$mailbox->setName('INBOX');
		$mailbox->setAccountId(13);
		$mailbox->setSelectable(true);

		$client = $this->initialClientForRetryTests();
		$client->expects($this->once())
			->method('login')
			->willThrowException(new Horde_Imap_Client_Exception('Mail server denied authentication.', Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED));
		$client->expects($this->never())->method('setParam');

		$this->googleIntegration->method('isGoogleOauthAccount')->with($account)->willReturn(true);
		// The forced refresh() call itself failed (e.g. Google's token
		// endpoint was unreachable) -- the account comes back unchanged,
		// still holding the exact same (already known-bad) access token.
		$this->googleIntegration->method('refresh')->willReturn($account);
		$this->accountService->expects($this->never())->method('update');

		$this->expectException(Horde_Imap_Client_Exception::class);
		$this->synchronizer->sync(
			$account,
			$client,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
	}

	public function testSyncDoesNotRetryForANonOauthAccount(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$mailAccount->setInboundHost('imap.example.com');
		$mailAccount->setAuthMethod('password');
		$account = new Account($mailAccount);
		$mailbox = new Mailbox();
		$mailbox->setId(100);
		$mailbox->setName('INBOX');
		$mailbox->setAccountId(1);
		$mailbox->setSelectable(true);

		$client = $this->initialClientForRetryTests();
		$client->expects($this->once())
			->method('login')
			->willThrowException(new Horde_Imap_Client_Exception('Mail server denied authentication.', Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED));

		$this->googleIntegration->method('isGoogleOauthAccount')->willReturn(false);
		$this->microsoftIntegration->method('isMicrosoftOauthAccount')->willReturn(false);
		$this->googleIntegration->expects($this->never())->method('refresh');
		$this->microsoftIntegration->expects($this->never())->method('refresh');

		$this->expectException(Horde_Imap_Client_Exception::class);
		$this->synchronizer->sync(
			$account,
			$client,
			$mailbox,
			$this->createStub(LoggerInterface::class),
		);
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
				$this->googleIntegration,
				$this->microsoftIntegration,
				$this->accountService,
				$this->crypto,
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
		$this->dispatcher->expects($this->once())
			->method('dispatchTyped')
			->with($this->callback(fn (SynchronizationEvent $event) => $event->isRebuildThreads()));

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
				$this->googleIntegration,
				$this->microsoftIntegration,
				$this->accountService,
				$this->crypto,
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

	private function buildSynchronizerWithSyncMock(Synchronizer&MockObject $imapSync): ImapToDbSynchronizer {
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
			$this->createStub(TagMapper::class),
			$this->createStub(NewMessagesClassifier::class),
			new HordeSyncTokenParser(),
			$this->fastPathStats,
			$this->googleIntegration,
			$this->microsoftIntegration,
			$this->accountService,
			$this->crypto,
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
