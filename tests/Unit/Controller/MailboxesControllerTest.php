<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Tests\Unit\Controller;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Controller\MailboxesController;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Exception\NotImplemented;
use OCA\Mail\Folder;
use OCA\Mail\IMAP\MailboxStats;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\DelegationService;
use OCA\Mail\Service\Sync\SyncService;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUser;
use OCP\IUserManager;
use OCP\Security\RateLimiting\ILimiter;
use PHPUnit\Framework\MockObject\MockObject;

class MailboxesControllerTest extends TestCase {
	/** @var string */
	private $appName = 'mail';

	/** @var IRequest|MockObject */
	private $request;

	/** @var AccountService|MockObject */
	private $accountService;

	/** @var string */
	private $userId = 'john';

	/** @var IMailManager|MockObject */
	private $mailManager;

	/** @var MailboxesController */
	private $controller;

	/** @var SyncService|MockObject */
	private $syncService;

	private IConfig|MockObject $config;
	private ITimeFactory|MockObject $timeFactory;
	private DelegationService|MockObject $delegationService;
	private ILimiter|MockObject $limiter;
	private IUserManager|MockObject $userManager;

	public function setUp(): void {
		parent::setUp();

		$this->request = $this->createMock(IRequest::class);
		$this->accountService = $this->createMock(AccountService::class);
		$this->mailManager = $this->createMock(IMailManager::class);
		$this->syncService = $this->createMock(SyncService::class);
		$this->config = $this->createMock(IConfig::class);
		$this->timeFactory = $this->createMock(ITimeFactory::class);
		$this->delegationService = $this->createMock(DelegationService::class);
		$this->delegationService->method('resolveAccountUserId')->willReturn($this->userId);
		$this->delegationService->method('resolveMailboxUserId')->willReturn($this->userId);
		$this->limiter = $this->createMock(ILimiter::class);
		$this->userManager = $this->createMock(IUserManager::class);
		$user = $this->createMock(IUser::class);
		$this->userManager->method('get')->with($this->userId)->willReturn($user);

		$this->controller = new MailboxesController(
			$this->appName,
			$this->request,
			$this->accountService,
			$this->userId,
			$this->mailManager,
			$this->syncService,
			$this->config,
			$this->timeFactory,
			$this->delegationService,
			$this->limiter,
			$this->userManager,
		);
	}

	public function testIndex() {
		$account = $this->createMock(Account::class);
		$folder = $this->createMock(Folder::class);
		$accountId = 28;
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->willReturn($account);
		$this->mailManager->expects($this->once())
			->method('getMailboxes')
			->with($this->equalTo($account))
			->willReturn([
				$folder
			]);
		$account->expects($this->once())
			->method('getEmail')
			->willReturn('user@example.com');
		$folder->expects($this->once())
			->method('getDelimiter')
			->willReturn('.');

		$result = $this->controller->index($accountId);

		$expected = new JSONResponse([
			'id' => 28,
			'email' => 'user@example.com',
			'mailboxes' => [
				$folder,
			],
			'delimiter' => '.',
		]);
		$this->assertEquals($expected, $result);
	}

	public function testShow() {
		$this->expectException(NotImplemented::class);

		$this->controller->show();
	}

	public function testCreate() {
		$account = $this->createStub(Account::class);
		$mailbox = new Mailbox();
		$mailbox->setId(99);
		$accountId = 28;
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->willReturn($account);
		$this->mailManager->expects($this->once())
			->method('createMailbox')
			->with($this->equalTo($account), $this->equalTo('new'))
			->willReturn($mailbox);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId created mailbox: {$mailbox->getId()} on behalf of $this->userId");

		$response = $this->controller->create($accountId, 'new');

		$expected = new JSONResponse($mailbox);
		$this->assertEquals($expected, $response);
	}

	public function testPatchRenameLogsDelegatedAction(): void {
		$mailboxId = 13;
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->userId, 28)
			->willReturn($account);
		$this->mailManager->expects($this->once())
			->method('renameMailbox')
			->with($account, $mailbox, 'renamed')
			->willReturn($mailbox);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId changed mailbox: {$mailboxId}'s name to renamed on behalf of $this->userId");

		$response = $this->controller->patch($mailboxId, 'renamed');

		$this->assertEquals(new JSONResponse($mailbox), $response);
	}

	public function testPatchSubscribeLogsDelegatedAction(): void {
		$mailboxId = 13;
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->willReturn($account);
		$this->mailManager->expects($this->once())
			->method('updateSubscription')
			->with($account, $mailbox, true)
			->willReturn($mailbox);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId subscribed to mailbox: $mailboxId on behalf of $this->userId");

		$this->controller->patch($mailboxId, null, true);
	}

	public function testPatchUnsubscribeLogsDelegatedAction(): void {
		$mailboxId = 13;
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->willReturn($account);
		$this->mailManager->expects($this->once())
			->method('updateSubscription')
			->with($account, $mailbox, false)
			->willReturn($mailbox);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId unsubscribed to mailbox: $mailboxId on behalf of $this->userId");

		$this->controller->patch($mailboxId, null, false);
	}

	public function testPatchEnableSyncLogsDelegatedAction(): void {
		$mailboxId = 13;
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->willReturn($account);
		$this->mailManager->expects($this->once())
			->method('enableMailboxBackgroundSync')
			->with($mailbox, true)
			->willReturn($mailbox);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId enabled background sync for mailbox: $mailboxId on behalf of $this->userId");

		$this->controller->patch($mailboxId, null, null, true);
	}

	public function testMarkAllAsReadLogsDelegatedAction(): void {
		$mailboxId = 13;
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->willReturn($account);
		$this->mailManager->expects($this->once())
			->method('markFolderAsRead')
			->with($account, $mailbox);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId marked all messages as read in mailbox: $mailboxId on behalf of $this->userId");

		$this->controller->markAllAsRead($mailboxId);
	}

	public function testDestroyLogsDelegatedAction(): void {
		$mailboxId = 13;
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->willReturn($account);
		$this->mailManager->expects($this->once())
			->method('deleteMailbox')
			->with($account, $mailbox);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId deleted mailbox: $mailboxId on behalf of $this->userId");

		$this->controller->destroy($mailboxId);
	}

	public function testClearMailboxLogsDelegatedAction(): void {
		$mailboxId = 13;
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->willReturn($account);
		$this->mailManager->expects($this->once())
			->method('clearMailbox')
			->with($account, $mailbox);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId cleared mailbox: $mailboxId on behalf of $this->userId");

		$this->controller->clearMailbox($mailboxId);
	}

	public function testRepairLogsDelegatedAction(): void {
		$mailboxId = 13;
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->willReturn($account);
		$this->syncService->expects($this->once())
			->method('repairSync')
			->with($account, $mailbox);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId repaired mailbox: $mailboxId on behalf of $this->userId");

		$this->controller->repair($mailboxId);
	}

	public function testStats(): void {
		$mailbox = new Mailbox();
		$mailbox->setUnseen(10);
		$mailbox->setMessages(42);
		$mailbox->setMyAcls(null);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with('john', 13)
			->willReturn($mailbox);

		$response = $this->controller->stats(13);

		$stats = new MailboxStats(42, 10, null);
		$expected = new JSONResponse($stats);
		$this->assertEquals($expected, $response);
	}

	public function testUpdate() {
		$this->expectException(NotImplemented::class);

		$this->controller->update();
	}

	public function testSyncRejectsWithRetryAfterWhenRateLimited(): void {
		// A mailbox sync lock is shared, mailbox-wide infrastructure, not a
		// per-session resource -- several independent clients (a forgotten
		// tab at the office, one at home, a phone, other users) can all hit
		// the very same lock without any of them knowing about the others.
		// The per-mailbox rate limit protects against that pile-on
		// regardless of how many uncoordinated clients are involved.
		$mailboxId = 13;
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);
		$this->mailManager->method('getMailbox')->willReturn($mailbox);
		$this->accountService->method('find')->willReturn($account);

		$this->limiter->expects($this->once())
			->method('registerUserRequest')
			->with('mail-sync-mailbox-' . $mailboxId, 100, Mailbox::LOCK_TIMEOUT, $this->anything())
			->willThrowException(new class extends \Exception implements \OCP\Security\RateLimiting\IRateLimitExceededException {
			});

		$this->syncService->expects($this->never())->method('syncMailbox');

		$response = $this->controller->sync($mailboxId);

		$this->assertEquals(429, $response->getStatus());
		// Deliberately much shorter than the rate limit's own period
		// (Mailbox::LOCK_TIMEOUT) -- confirmed live that advising the full
		// period here made a client that hit the limit once wait a felt
		// ~5 minutes for new mail, even after the mailbox itself had long
		// since freed up.
		$this->assertEquals('30', $response->getHeaders()['Retry-After']);
	}

	public function testSyncReturnsRetryAfterBasedOnRemainingLockTime(): void {
		$mailboxId = 13;
		$now = 1000000;
		// Locked 100s ago; 200s of its 300s LOCK_TIMEOUT remain.
		$lockedAt = $now - 100;

		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);

		$freshMailbox = new Mailbox();
		$freshMailbox->setId($mailboxId);
		$freshMailbox->setSyncNewLock($lockedAt);

		$this->mailManager->expects($this->exactly(2))
			->method('getMailbox')
			->willReturnOnConsecutiveCalls($mailbox, $freshMailbox);
		$this->accountService->method('find')->willReturn($account);
		$this->timeFactory->method('getTime')->willReturn($now);
		$this->syncService->method('syncMailbox')
			->willThrowException(\OCA\Mail\Exception\MailboxLockedException::from($mailbox));

		$response = $this->controller->sync($mailboxId);

		$this->assertEquals(409, $response->getStatus());
		$this->assertEquals('200', $response->getHeaders()['Retry-After']);
	}

	public function testSyncCapsRetryAfterAtLockTimeoutEvenIfLockLooksOlder(): void {
		// A defensive floor/ceiling: an unexpected clock skew or stale lock
		// value shouldn't produce a nonsensical Retry-After (negative, or
		// far beyond how long a lock could ever legitimately last).
		$mailboxId = 13;
		$now = 1000000;

		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId(28);
		$account = $this->createStub(Account::class);

		$freshMailbox = new Mailbox();
		$freshMailbox->setId($mailboxId);
		// A lock timestamp from far in the future relative to $now.
		$freshMailbox->setSyncNewLock($now + 10000);

		$this->mailManager->expects($this->exactly(2))
			->method('getMailbox')
			->willReturnOnConsecutiveCalls($mailbox, $freshMailbox);
		$this->accountService->method('find')->willReturn($account);
		$this->timeFactory->method('getTime')->willReturn($now);
		$this->syncService->method('syncMailbox')
			->willThrowException(\OCA\Mail\Exception\MailboxLockedException::from($mailbox));

		$response = $this->controller->sync($mailboxId);

		$this->assertEquals(409, $response->getStatus());
		$this->assertEquals((string)Mailbox::LOCK_TIMEOUT, $response->getHeaders()['Retry-After']);
	}
}
