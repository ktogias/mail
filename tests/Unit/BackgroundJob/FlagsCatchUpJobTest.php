<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\BackgroundJob;

use ChristophWurst\Nextcloud\Testing\TestCase;
use Horde_Imap_Client;
use Horde_Imap_Client_Socket;
use OC\BackgroundJob\JobList;
use OCA\Mail\Account;
use OCA\Mail\BackgroundJob\FlagsCatchUpJob;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\Sync\ImapToDbSynchronizer;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IConfig;
use OCP\IUser;
use OCP\IUserManager;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class FlagsCatchUpJobTest extends TestCase {
	private ImapToDbSynchronizer&MockObject $synchronizer;
	private IMAPClientFactory&MockObject $clientFactory;
	private AccountService&MockObject $accountService;
	private MailboxMapper&MockObject $mailboxMapper;
	private IUserManager&MockObject $userManager;
	private IConfig&MockObject $config;
	private LoggerInterface&MockObject $logger;
	private Horde_Imap_Client_Socket&MockObject $client;
	private FlagsCatchUpJob&MockObject $job;
	private Mailbox $mailbox;
	private Account $account;

	protected function setUp(): void {
		parent::setUp();
		$this->synchronizer = $this->createMock(ImapToDbSynchronizer::class);
		$this->clientFactory = $this->createMock(IMAPClientFactory::class);
		$this->accountService = $this->createMock(AccountService::class);
		$this->mailboxMapper = $this->createMock(MailboxMapper::class);
		$this->userManager = $this->createMock(IUserManager::class);
		$this->config = $this->createMock(IConfig::class);
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->client = $this->createMock(Horde_Imap_Client_Socket::class);

		$this->mailbox = new Mailbox();
		$this->mailbox->setId(149);
		$this->mailbox->setName('INBOX');
		$this->mailbox->setAccountId(13);
		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setUserId('user');
		$mailAccount->setInboundPassword('secret');
		$this->account = new Account($mailAccount);

		$this->mailboxMapper->method('findById')->with(149)->willReturn($this->mailbox);
		$this->accountService->method('findById')->with(13)->willReturn($this->account);
		$this->userManager->method('get')->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->clientFactory->method('getClient')->willReturn($this->client);
		$this->config->method('getSystemValue')->willReturnCallback(
			static fn (string $key, $default) => $default,
		);

		$timeFactory = $this->createStub(ITimeFactory::class);
		$timeFactory->method('getTime')->willReturn(700000);
		$this->job = $this->getMockBuilder(FlagsCatchUpJob::class)
			->setConstructorArgs([
				$timeFactory,
				$this->synchronizer,
				$this->clientFactory,
				$this->accountService,
				$this->mailboxMapper,
				$this->userManager,
				$this->config,
				$this->logger,
			])
			->onlyMethods(['pause'])
			->getMock();
	}

	public function testRunsOnlyTheFlagsPhaseWithAnExtendedDeadline(): void {
		// 36 s of Gmail SEARCH against a 20 s background deadline is the whole
		// failure; the catch-up must be allowed more than that.
		$params = [];
		$this->client->method('setParam')->willReturnCallback(static function (string $key, $value) use (&$params): void {
			$params[$key] = $value;
		});
		$this->synchronizer->expects($this->once())
			->method('sync')
			->with($this->account, $this->client, $this->mailbox, $this->anything(), Horde_Imap_Client::SYNC_FLAGSUIDS);
		$this->client->expects($this->once())->method('logout');

		$this->start();

		self::assertSame(FlagsCatchUpJob::DEFAULT_CATCH_UP_READ_TIMEOUT_SECONDS, $params['read_timeout']);
		self::assertSame(FlagsCatchUpJob::DEFAULT_CATCH_UP_READ_TIMEOUT_SECONDS, $params['timeout']);
		self::assertGreaterThan(36, FlagsCatchUpJob::DEFAULT_CATCH_UP_READ_TIMEOUT_SECONDS);
	}

	public function testWaitsForTheAccountsConnectionSlot(): void {
		$this->clientFactory = $this->createMock(IMAPClientFactory::class);
		$this->clientFactory->expects($this->once())
			->method('getClient')
			->with($this->account, true, false, true)
			->willReturn($this->client);
		$this->rebuildJob();

		$this->start();
	}

	public function testRetriesALockedMailboxThenGivesUpWithoutSpinning(): void {
		$this->synchronizer->expects($this->exactly(FlagsCatchUpJob::MAX_LOCK_ATTEMPTS))
			->method('sync')
			->willThrowException(new MailboxLockedException('locked'));
		$this->job->expects($this->exactly(FlagsCatchUpJob::MAX_LOCK_ATTEMPTS - 1))->method('pause');
		$this->logger->expects($this->once())->method('warning');

		$this->start();
	}

	public function testAServerThatStillCannotAnswerIsLoggedNotThrown(): void {
		$this->synchronizer->method('sync')
			->willThrowException(new \Horde_Imap_Client_Exception('Error when communicating with the mail server.'));
		$this->job->expects($this->never())->method('pause');
		$this->logger->expects($this->once())
			->method('warning')
			->with('Flag catch-up of mailbox 149 failed');
		$this->client->expects($this->once())->method('logout');

		// Straight into run(): Job::start() swallows whatever escapes run(),
		// so going through it this test passed even with a rethrow in place
		// -- found by the mutation proof, not by reading.
		$run = new \ReflectionMethod(FlagsCatchUpJob::class, 'run');
		$run->invoke($this->job, ['mailboxId' => 149]);
	}

	private function rebuildJob(): void {
		$timeFactory = $this->createStub(ITimeFactory::class);
		$this->job = $this->getMockBuilder(FlagsCatchUpJob::class)
			->setConstructorArgs([
				$timeFactory,
				$this->synchronizer,
				$this->clientFactory,
				$this->accountService,
				$this->mailboxMapper,
				$this->userManager,
				$this->config,
				$this->logger,
			])
			->onlyMethods(['pause'])
			->getMock();
	}

	private function start(): void {
		$this->job->setArgument(['mailboxId' => 149]);
		$this->job->start($this->createMock(JobList::class));
	}
}
