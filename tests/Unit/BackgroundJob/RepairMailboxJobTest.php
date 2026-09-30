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
use OCA\Mail\BackgroundJob\RepairMailboxJob;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Events\SynchronizationEvent;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\Sync\SyncService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\IUser;
use OCP\IUserManager;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class RepairMailboxJobTest extends TestCase {
	private AccountService&MockObject $accountService;
	private SyncService&MockObject $syncService;
	private IUserManager&MockObject $userManager;
	private MailboxMapper&MockObject $mailboxMapper;
	private LoggerInterface&MockObject $logger;
	private IEventDispatcher&MockObject $dispatcher;
	private RepairMailboxJob&MockObject $job;

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
		// Partial mock: only pause() is replaced, so the retry loop runs for
		// real without the suite sleeping for real.
		$this->job = $this->getMockBuilder(RepairMailboxJob::class)
			->setConstructorArgs([
				$timeFactory,
				$this->syncService,
				$this->accountService,
				$this->mailboxMapper,
				$this->userManager,
				$this->dispatcher,
				$this->logger,
			])
			->onlyMethods(['pause'])
			->getMock();
	}

	public function testRepairsTheMailboxAndRebuildsThreadsWhenRowsMoved(): void {
		$mailbox = $this->mailbox(39);
		$account = $this->seedLookups($mailbox);

		$this->syncService->expects(self::once())
			->method('repairSync')
			->with($account, $mailbox)
			->willReturn(1);
		$this->dispatcher->expects(self::once())
			->method('dispatchTyped')
			->with(self::callback(static fn (SynchronizationEvent $event) => $event->isRebuildThreads()));

		$this->startJob(39);
	}

	public function testARepairThatFoundNothingDoesNotPayForAThreadRebuild(): void {
		$mailbox = $this->mailbox(39);
		$this->seedLookups($mailbox);

		$this->syncService->expects(self::once())
			->method('repairSync')
			->willReturn(0);
		// The detector fired and the repair found nothing. That is a signal
		// worth logging, but rebuilding the thread forest for it would make a
		// false positive expensive.
		$this->dispatcher->expects(self::never())->method('dispatchTyped');

		$this->startJob(39);
	}

	public function testRetriesATransientlyLockedMailboxInsteadOfDroppingTheRepair(): void {
		$mailbox = $this->mailbox(39);
		$this->seedLookups($mailbox);

		$attempts = 0;
		$this->syncService->expects(self::exactly(2))
			->method('repairSync')
			->willReturnCallback(function () use (&$attempts): int {
				$attempts++;
				if ($attempts === 1) {
					throw new MailboxLockedException('locked');
				}
				return 2;
			});
		$this->job->expects(self::once())->method('pause');

		$this->startJob(39);
	}

	public function testGivesUpOnAPersistentlyLockedMailboxWithoutSpinning(): void {
		$mailbox = $this->mailbox(39);
		$this->seedLookups($mailbox);

		$this->syncService->expects(self::exactly(RepairMailboxJob::MAX_LOCK_ATTEMPTS))
			->method('repairSync')
			->willThrowException(new MailboxLockedException('locked'));
		$this->logger->expects(self::once())->method('warning');

		$this->startJob(39);
	}

	public function testDoesNotRetryARealFailure(): void {
		$mailbox = $this->mailbox(39);
		$this->seedLookups($mailbox);

		// Unlike a lock collision, an IMAP or DB error will not clear in ten
		// seconds. The detector re-fires after its cooldown, so retrying here
		// only multiplies the cost of a broken mailbox.
		$this->syncService->expects(self::once())
			->method('repairSync')
			->willThrowException(new ServiceException('imap is down'));
		$this->job->expects(self::never())->method('pause');

		$this->startJob(39);
	}

	public function testAVanishedMailboxIsNotAnError(): void {
		$this->mailboxMapper->expects(self::once())
			->method('findById')
			->with(39)
			->willThrowException(new DoesNotExistException('gone'));
		$this->syncService->expects(self::never())->method('repairSync');
		$this->logger->expects(self::never())->method('warning');

		$this->startJob(39);
	}

	public function testADisabledUserIsSkipped(): void {
		$mailbox = $this->mailbox(39);
		$mailAccount = new MailAccount();
		$mailAccount->setId(4);
		$mailAccount->setUserId('user');
		$mailAccount->setInboundPassword('test-password');
		$this->mailboxMapper->method('findById')->with(39)->willReturn($mailbox);
		$this->accountService->method('findById')->with(4)->willReturn(new Account($mailAccount));
		$this->userManager->method('get')->with('user')->willReturn(
			$this->createConfiguredMock(IUser::class, ['isEnabled' => false])
		);

		$this->syncService->expects(self::never())->method('repairSync');

		$this->startJob(39);
	}

	private function mailbox(int $id): Mailbox {
		$mailbox = new Mailbox();
		$mailbox->setId($id);
		$mailbox->setName('INBOX');
		$mailbox->setAccountId(4);
		return $mailbox;
	}

	private function seedLookups(Mailbox $mailbox): Account {
		$mailAccount = new MailAccount();
		$mailAccount->setId(4);
		$mailAccount->setUserId('user');
		$mailAccount->setInboundPassword('test-password');
		$account = new Account($mailAccount);

		$this->mailboxMapper->expects(self::once())
			->method('findById')
			->with($mailbox->getId())
			->willReturn($mailbox);
		$this->accountService->expects(self::once())
			->method('findById')
			->with(4)
			->willReturn($account);
		$this->userManager->expects(self::once())
			->method('get')
			->with('user')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));

		return $account;
	}

	private function startJob(int $mailboxId): void {
		$this->job->setArgument(['mailboxId' => $mailboxId]);
		$this->job->start($this->createMock(JobList::class));
	}
}
