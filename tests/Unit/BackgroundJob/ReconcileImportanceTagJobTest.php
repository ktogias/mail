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
use OCA\Mail\BackgroundJob\ReconcileImportanceTagJob;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Db\Tag;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Service\AccountService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJobList;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class ReconcileImportanceTagJobTest extends TestCase {
	/** @var AccountService|MockObject */
	private $accountService;

	/** @var MessageMapper|MockObject */
	private $messageMapper;

	/** @var TagMapper|MockObject */
	private $tagMapper;

	/** @var IJobList|MockObject */
	private $jobList;

	private ReconcileImportanceTagJob $job;

	protected function setUp(): void {
		parent::setUp();

		$this->accountService = $this->createMock(AccountService::class);
		$this->messageMapper = $this->createMock(MessageMapper::class);
		$this->tagMapper = $this->createMock(TagMapper::class);
		$this->jobList = $this->createMock(IJobList::class);

		$timeFactory = $this->createMock(ITimeFactory::class);
		$timeFactory->method('getTime')->willReturn(time());
		$this->job = new ReconcileImportanceTagJob(
			$timeFactory,
			$this->accountService,
			$this->messageMapper,
			$this->tagMapper,
			$this->jobList,
			$this->createMock(LoggerInterface::class),
		);
	}

	private function account(): Account {
		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setUserId('user');
		return new Account($mailAccount);
	}

	private function importantTag(): Tag {
		$tag = new Tag();
		$tag->setId(909);
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);
		return $tag;
	}

	public function testBackfillsMissingTagMappings(): void {
		$this->accountService->method('findById')->willReturn($this->account());
		$this->tagMapper->method('getTagByImapLabel')
			->with(Tag::LABEL_IMPORTANT, 'user')
			->willReturn($this->importantTag());
		$this->messageMapper->expects($this->once())
			->method('findImportantMessageIdsWithoutTag')
			->with(13, 909, ReconcileImportanceTagJob::MAX_MAPPINGS_PER_RUN)
			->willReturn(['<a@test>', '<b@test>']);
		$tagged = [];
		$this->tagMapper->expects($this->exactly(2))
			->method('tagMessage')
			->willReturnCallback(static function ($tag, $messageId, $userId) use (&$tagged): void {
				$tagged[] = [$messageId, $userId];
			});

		$this->runJob();

		self::assertEquals([['<a@test>', 'user'], ['<b@test>', 'user']], $tagged);
	}

	public function testDoesNothingWhenNoDivergenceExists(): void {
		$this->accountService->method('findById')->willReturn($this->account());
		$this->tagMapper->method('getTagByImapLabel')->willReturn($this->importantTag());
		$this->messageMapper->method('findImportantMessageIdsWithoutTag')->willReturn([]);

		$this->tagMapper->expects($this->never())->method('tagMessage');

		$this->runJob();
	}

	public function testDoesNothingWhenTheUserHasNoImportantTagYet(): void {
		$this->accountService->method('findById')->willReturn($this->account());
		$this->tagMapper->method('getTagByImapLabel')->willThrowException(new DoesNotExistException(''));

		$this->messageMapper->expects($this->never())->method('findImportantMessageIdsWithoutTag');

		$this->runJob();
	}

	public function testRemovesItselfForADeletedAccount(): void {
		$this->accountService->method('findById')->willThrowException(new DoesNotExistException(''));
		$this->jobList->expects($this->once())
			->method('remove')
			->with(ReconcileImportanceTagJob::class, ['accountId' => 13]);

		$this->runJob();
	}

	private function runJob(): void {
		$this->job->setArgument(['accountId' => 13]);
		$this->job->setLastRun(0);
		$this->job->start($this->createMock(JobList::class));
	}
}
