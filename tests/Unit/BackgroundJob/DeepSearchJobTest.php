<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\BackgroundJob;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OC\BackgroundJob\JobList;
use OCA\Mail\BackgroundJob\DeepSearchJob;
use OCA\Mail\Db\SearchJob;
use OCA\Mail\Service\Search\DeepSearchService;
use OCA\Mail\Service\Sync\SyncService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJobList;
use OCP\ICacheFactory;
use OCP\IMemcache;
use Psr\Log\LoggerInterface;

class DeepSearchJobTest extends TestCase {
	public function testRunsOneChunkUnderTheGlobalSlotThenSchedulesTheNext(): void {
		$time = $this->createMock(ITimeFactory::class);
		$time->method('getTime')->willReturn(2_000_000_000);
		$service = $this->createMock(DeepSearchService::class);
		$record = new SearchJob();
		$record->setAccountId(7);
		$service->method('getInternal')->with(41)->willReturn($record);
		$service->expects(self::once())->method('processChunk')->with(41)->willReturn(true);
		$sync = $this->createMock(SyncService::class);
		$sync->method('isServerBusy')->willReturn(false);
		$sync->method('isAccountResponseSlow')->with(7)->willReturn(false);
		$cache = $this->createMock(IMemcache::class);
		$cache->expects(self::once())->method('add')->with('global_slot_0', self::anything(), 300)->willReturn(true);
		$cache->expects(self::once())->method('cad')->with('global_slot_0', self::anything())->willReturn(true);
		$cacheFactory = $this->createMock(ICacheFactory::class);
		$cacheFactory->method('createDistributed')->with('mail_deep_search_worker')->willReturn($cache);
		$jobs = $this->createMock(IJobList::class);
		$jobs->expects(self::once())->method('scheduleAfter')->with(
			DeepSearchJob::class,
			2_000_000_001,
			['jobId' => 41, 'iteration' => 4, 'failures' => 0],
		);
		$job = new DeepSearchJob($time, $service, $sync, $cacheFactory, $jobs, $this->createMock(LoggerInterface::class));
		$job->setArgument(['jobId' => 41, 'iteration' => 3, 'failures' => 2]);

		$job->start($this->createMock(JobList::class));
	}

	public function testBusyServerDefersWithoutTakingTheWorkerSlot(): void {
		$time = $this->createMock(ITimeFactory::class);
		$time->method('getTime')->willReturn(2_000_000_000);
		$service = $this->createMock(DeepSearchService::class);
		$record = new SearchJob();
		$record->setAccountId(7);
		$service->method('getInternal')->with(41)->willReturn($record);
		$service->expects(self::once())->method('defer')->with(41);
		$service->expects(self::never())->method('processChunk');
		$sync = $this->createMock(SyncService::class);
		$sync->method('isServerBusy')->willReturn(true);
		$cacheFactory = $this->createMock(ICacheFactory::class);
		$cacheFactory->expects(self::never())->method('createDistributed');
		$jobs = $this->createMock(IJobList::class);
		$jobs->expects(self::once())->method('scheduleAfter')->with(
			DeepSearchJob::class,
			2_000_000_030,
			['jobId' => 41, 'iteration' => 1, 'failures' => 0],
		);
		$job = new DeepSearchJob($time, $service, $sync, $cacheFactory, $jobs, $this->createMock(LoggerInterface::class));
		$job->setArgument(['jobId' => 41, 'iteration' => 0, 'failures' => 0]);

		$job->start($this->createMock(JobList::class));
	}
}
