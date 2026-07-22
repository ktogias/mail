<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\Search;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\BackgroundJob\DeepSearchJob as DeepSearchBackgroundJob;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\SearchJob;
use OCA\Mail\Db\SearchJobMapper;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\Search\DeepSearchService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJobList;

class DeepSearchServiceTest extends TestCase {
	private SearchJobMapper $jobMapper;
	private MailboxMapper $mailboxMapper;
	private AccountService $accountService;
	private IMailSearch $mailSearch;
	private IJobList $jobList;
	private ITimeFactory $time;
	private DeepSearchService $service;

	protected function setUp(): void {
		parent::setUp();
		$this->jobMapper = $this->createMock(SearchJobMapper::class);
		$this->mailboxMapper = $this->createMock(MailboxMapper::class);
		$this->accountService = $this->createMock(AccountService::class);
		$this->mailSearch = $this->createMock(IMailSearch::class);
		$this->jobList = $this->createMock(IJobList::class);
		$this->time = $this->createMock(ITimeFactory::class);
		$this->time->method('getTime')->willReturn(2_000_000_000);
		$this->service = new DeepSearchService(
			$this->jobMapper,
			$this->mailboxMapper,
			$this->accountService,
			$this->mailSearch,
			$this->jobList,
			$this->time,
		);
	}

	public function testStartPersistsAndSchedulesOneCursorKeyedPage(): void {
		$account = $this->account(7, 'alice');
		$mailbox = $this->mailbox(23, 7);
		$this->jobMapper->method('findByJobKey')->willThrowException(new DoesNotExistException('missing'));
		$this->jobMapper->expects(self::once())
			->method('insert')
			->willReturnCallback(static function (SearchJob $job): SearchJob {
				$job->setId(41);
				return $job;
			});
		$this->jobList->expects(self::once())
			->method('add')
			->with(DeepSearchBackgroundJob::class, [
				'jobId' => 41,
				'iteration' => 0,
				'failures' => 0,
			]);

		$job = $this->service->start(
			'alice',
			'alice',
			$account,
			$mailbox,
			'  subject:needle   is:unread ',
			IMailSearch::ORDER_NEWEST_FIRST,
			IMailSearch::VIEW_THREADED,
			1_900_000_000,
			888,
			20,
		);

		self::assertSame(SearchJob::STATUS_QUEUED, $job->getStatus());
		self::assertSame('subject:needle is:unread', $job->getFilter());
		self::assertSame(1_900_000_000, $job->getNextEnd());
		self::assertSame(888, $job->getCursorId());
		self::assertSame('[]', $job->getResultPayload());
		self::assertSame(2_000_003_600, $job->getExpiresAt());
	}

	public function testEquivalentLiveJobIsCoalescedWithoutAnotherQueueEntry(): void {
		$account = $this->account(7, 'alice');
		$mailbox = $this->mailbox(23, 7);
		$existing = $this->baseJob();
		$existing->setExpiresAt(2_000_000_100);
		$this->jobMapper->method('findByJobKey')->willReturn($existing);
		$this->jobMapper->expects(self::never())->method('insert');
		$this->jobMapper->expects(self::never())->method('update');
		$this->jobList->expects(self::never())->method('add');

		$result = $this->service->start(
			'alice', 'alice', $account, $mailbox, 'subject:needle',
			IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED,
			1_900_000_000, null, 20,
		);

		self::assertSame($existing, $result);
	}

	public function testChunkUsesBoundedWindowAndCompletesWhenPageIsFull(): void {
		$job = $this->baseJob();
		$job->setPageLimit(1);
		$job->setCursorAt(1_900_000_000);
		$job->setCursorId(888);
		$this->jobMapper->method('findById')->with(41)->willReturn($job);
		$this->jobMapper->expects(self::exactly(2))->method('storeWorkerState')->willReturn(true);
		$account = $this->account(7, 'alice');
		$mailbox = $this->mailbox(23, 7);
		$this->accountService->method('findById')->with(7)->willReturn($account);
		$this->mailboxMapper->method('findById')->with(23)->willReturn($mailbox);
		$message = $this->createMock(Message::class);
		$message->method('jsonSerialize')->willReturn([
			'databaseId' => 991,
			'dateInt' => 1_899_000_000,
		]);
		$this->mailSearch->expects(self::once())
			->method('findMessages')
			->with(
				$account,
				$mailbox,
				IMailSearch::ORDER_NEWEST_FIRST,
				'subject:needle start:1884448001 end:1900000000',
				1_900_000_000,
				1,
				'alice',
				IMailSearch::VIEW_THREADED,
				false,
				888,
			)
			->willReturn([$message]);

		self::assertFalse($this->service->processChunk(41));
		self::assertSame(SearchJob::STATUS_COMPLETE, $job->getStatus());
		self::assertSame(1, $job->getResultCount());
		self::assertFalse($job->getExhausted());
		self::assertSame(1, $job->getChunksDone());
		self::assertSame([['databaseId' => 991, 'dateInt' => 1_899_000_000]], json_decode($job->getResultPayload(), true));
	}

	public function testCancelledBetweenRunningAndCommitCannotBeResurrected(): void {
		$job = $this->baseJob();
		$this->jobMapper->method('findById')->with(41)->willReturn($job);
		$this->jobMapper->expects(self::once())->method('storeWorkerState')->willReturn(false);
		$this->mailSearch->expects(self::never())->method('findMessages');

		self::assertFalse($this->service->processChunk(41));
	}

	private function baseJob(): SearchJob {
		$job = new SearchJob();
		$job->setId(41);
		$job->setUserId('alice');
		$job->setEffectiveUserId('alice');
		$job->setAccountId(7);
		$job->setMailboxId(23);
		$job->setJobKey(str_repeat('a', 64));
		$job->setMailboxGeneration(str_repeat('b', 32));
		$job->setFilter('subject:needle');
		$job->setSortOrder(IMailSearch::ORDER_NEWEST_FIRST);
		$job->setView(IMailSearch::VIEW_THREADED);
		$job->setStatus(SearchJob::STATUS_QUEUED);
		$job->setCursorAt(null);
		$job->setCursorId(null);
		$job->setNextEnd(1_900_000_000);
		$job->setSearchedThrough(1_900_000_000);
		$job->setPageLimit(20);
		$job->setPrioritySplit(false);
		$job->setResultCount(0);
		$job->setChunksDone(0);
		$job->setResultPayload('[]');
		$job->setCancelRequested(false);
		$job->setExhausted(false);
		$job->setErrorCode(null);
		$job->setCreatedAt(2_000_000_000);
		$job->setUpdatedAt(2_000_000_000);
		$job->setExpiresAt(2_000_003_600);
		return $job;
	}

	private function account(int $id, string $userId): Account {
		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn($id);
		$account->method('getUserId')->willReturn($userId);
		return $account;
	}

	private function mailbox(int $id, int $accountId): Mailbox {
		$mailbox = new Mailbox();
		$mailbox->setId($id);
		$mailbox->setAccountId($accountId);
		$mailbox->setSyncNewToken('new');
		$mailbox->setSyncChangedToken('changed');
		$mailbox->setSyncVanishedToken('vanished');
		return $mailbox;
	}
}
