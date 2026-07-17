<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\BackgroundJob;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OC\BackgroundJob\JobList;
use OCA\Mail\Account;
use OCA\Mail\BackgroundJob\RepairSyncJob;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Events\SynchronizationEvent;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\Sync\SyncService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJobList;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\IUser;
use OCP\IUserManager;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class RepairSyncJobTest extends TestCase {
	private AccountService&MockObject $accountService;
	private SyncService&MockObject $syncService;
	private IUserManager&MockObject $userManager;
	private MailboxMapper&MockObject $mailboxMapper;
	private LoggerInterface&MockObject $logger;
	private IEventDispatcher&MockObject $dispatcher;
	private RepairSyncJob&MockObject $job;

	protected function setUp(): void {
		parent::setUp();

		$this->accountService = $this->createMock(AccountService::class);
		$this->syncService = $this->createMock(SyncService::class);
		$this->userManager = $this->createMock(IUserManager::class);
		$this->mailboxMapper = $this->createMock(MailboxMapper::class);
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->dispatcher = $this->createMock(IEventDispatcher::class);

		$timeFactory = $this->createStub(ITimeFactory::class);
		$timeFactory->method('getTime')->willReturn(700000);
		// Partial mock: only pause() is replaced, so the retry loop runs
		// for real without the test suite sleeping for real.
		$this->job = $this->getMockBuilder(RepairSyncJob::class)
			->setConstructorArgs([
				$timeFactory,
				$this->syncService,
				$this->accountService,
				$this->userManager,
				$this->mailboxMapper,
				$this->createStub(IJobList::class),
				$this->logger,
				$this->dispatcher,
			])
			->onlyMethods(['pause'])
			->getMock();
	}

	public function testContinuesAfterAPersistentlyLockedMailboxAndRebuildsThreadsForALaterRepair(): void {
		$account = $this->account();
		$lockedMailbox = $this->mailbox(149, 'INBOX');
		$repairableMailbox = $this->mailbox(150, 'Forum');
		$this->seedAccountLookups($account, [$lockedMailbox, $repairableMailbox]);

		// The locked mailbox burns all attempts, the healthy one succeeds
		$this->syncService->expects(self::exactly(RepairSyncJob::MAX_LOCK_ATTEMPTS + 1))
			->method('repairSync')
			->willReturnCallback(static function (Account $actualAccount, Mailbox $mailbox) use ($account, $lockedMailbox): int {
				self::assertSame($account, $actualAccount);
				if ($mailbox === $lockedMailbox) {
					throw MailboxLockedException::from($mailbox);
				}
				return 1;
			});
		$this->job->expects(self::exactly(RepairSyncJob::MAX_LOCK_ATTEMPTS - 1))
			->method('pause')
			->with(RepairSyncJob::LOCK_RETRY_DELAY_SECONDS);
		$this->logger->expects(self::once())->method('warning');
		$this->dispatcher->expects(self::once())
			->method('dispatchTyped')
			->with(self::callback(static fn (SynchronizationEvent $event) => $event->isRebuildThreads()));

		$this->startJob();
	}

	public function testRetriesATransientlyLockedMailboxWithoutSkippingItsRepair(): void {
		$account = $this->account();
		$mailbox = $this->mailbox(149, 'INBOX');
		$this->seedAccountLookups($account, [$mailbox]);

		// First attempt collides with an in-flight sync pass, second succeeds
		$attempt = 0;
		$this->syncService->expects(self::exactly(2))
			->method('repairSync')
			->willReturnCallback(static function () use (&$attempt, $mailbox): int {
				if (++$attempt === 1) {
					throw MailboxLockedException::from($mailbox);
				}
				return 1;
			});
		$this->job->expects(self::once())
			->method('pause')
			->with(RepairSyncJob::LOCK_RETRY_DELAY_SECONDS);
		$this->logger->expects(self::never())->method('warning');
		$this->dispatcher->expects(self::once())
			->method('dispatchTyped')
			->with(self::callback(static fn (SynchronizationEvent $event) => $event->isRebuildThreads()));

		$this->startJob();
	}

	public function testDoesNotRetryARealFailureAndContinuesWithTheRemainingMailboxes(): void {
		$account = $this->account();
		$brokenMailbox = $this->mailbox(149, 'INBOX');
		$repairableMailbox = $this->mailbox(150, 'Forum');
		$this->seedAccountLookups($account, [$brokenMailbox, $repairableMailbox]);

		$this->syncService->expects(self::exactly(2))
			->method('repairSync')
			->willReturnCallback(static function (Account $actualAccount, Mailbox $mailbox) use ($brokenMailbox): int {
				if ($mailbox === $brokenMailbox) {
					throw new ServiceException('IMAP exploded');
				}
				return 1;
			});
		$this->job->expects(self::never())->method('pause');
		$this->logger->expects(self::once())->method('warning');
		$this->dispatcher->expects(self::once())
			->method('dispatchTyped')
			->with(self::callback(static fn (SynchronizationEvent $event) => $event->isRebuildThreads()));

		$this->startJob();
	}

	private function account(): Account {
		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setUserId('user');
		$mailAccount->setInboundPassword('test-password');
		return new Account($mailAccount);
	}

	private function seedAccountLookups(Account $account, array $mailboxes): void {
		$user = $this->createConfiguredMock(IUser::class, [
			'isEnabled' => true,
		]);
		$this->accountService->expects(self::once())->method('findById')->with(13)->willReturn($account);
		$this->userManager->expects(self::once())->method('get')->with('user')->willReturn($user);
		$this->mailboxMapper->expects(self::once())->method('findAll')->with($account)->willReturn($mailboxes);
	}

	private function startJob(): void {
		$this->job->setArgument(['accountId' => 13]);
		$this->job->setLastRun(0);
		$this->job->start($this->createMock(JobList::class));
	}

	private function mailbox(int $id, string $name): Mailbox {
		$mailbox = new Mailbox();
		$mailbox->setId($id);
		$mailbox->setName($name);
		return $mailbox;
	}
}
