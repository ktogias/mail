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
	private RepairSyncJob $job;

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
		$this->job = new RepairSyncJob(
			$timeFactory,
			$this->syncService,
			$this->accountService,
			$this->userManager,
			$this->mailboxMapper,
			$this->createStub(IJobList::class),
			$this->logger,
			$this->dispatcher,
		);
	}

	public function testContinuesAfterALockedMailboxAndRebuildsThreadsForALaterRepair(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setUserId('user');
		$mailAccount->setInboundPassword('test-password');
		$account = new Account($mailAccount);
		$lockedMailbox = $this->mailbox(149, 'INBOX');
		$repairableMailbox = $this->mailbox(150, 'Forum');
		$user = $this->createConfiguredMock(IUser::class, [
			'isEnabled' => true,
		]);

		$this->accountService->expects(self::once())->method('findById')->with(13)->willReturn($account);
		$this->userManager->expects(self::once())->method('get')->with('user')->willReturn($user);
		$this->mailboxMapper->expects(self::once())->method('findAll')->with($account)->willReturn([$lockedMailbox, $repairableMailbox]);
		$this->syncService->expects(self::exactly(2))
			->method('repairSync')
			->willReturnCallback(static function (Account $actualAccount, Mailbox $mailbox) use ($account, $lockedMailbox): int {
				self::assertSame($account, $actualAccount);
				if ($mailbox === $lockedMailbox) {
					throw MailboxLockedException::from($mailbox);
				}
				return 1;
			});
		$this->logger->expects(self::once())->method('warning');
		$this->dispatcher->expects(self::once())
			->method('dispatchTyped')
			->with(self::callback(static fn (SynchronizationEvent $event) => $event->isRebuildThreads()));

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
