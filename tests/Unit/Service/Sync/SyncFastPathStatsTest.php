<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\Sync;

use Horde_Imap_Client;
use OCA\Mail\Service\Sync\SyncFastPathStats;
use OCP\ICache;
use OCP\ICacheFactory;
use OCP\IMemcache;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;

class SyncFastPathStatsTest extends TestCase {
	private IMemcache&MockObject $memcache;
	private SyncFastPathStats $stats;

	protected function setUp(): void {
		parent::setUp();

		$this->memcache = $this->createMock(IMemcache::class);
		$cacheFactory = $this->createMock(ICacheFactory::class);
		$cacheFactory->method('createDistributed')->willReturn($this->memcache);

		$this->stats = new SyncFastPathStats($cacheFactory);
	}

	/**
	 * A phase not present in $criteriaBefore at all (e.g. a silent,
	 * knownUids-provided sync only asking for a subset of phases) must not
	 * be counted as an "attempt" -- there was nothing to prune in the first
	 * place.
	 */
	public function testRecordOutcomeOnlyCountsPhasesUnderConsideration(): void {
		$this->memcache->expects(self::once())
			->method('inc')
			->with('new_attempted');

		$this->stats->recordOutcome(Horde_Imap_Client::SYNC_NEWMSGSUIDS, Horde_Imap_Client::SYNC_NEWMSGSUIDS);
	}

	public function testRecordOutcomeCountsAPrunedPhaseAsBothAttemptedAndPruned(): void {
		$calls = [];
		$this->memcache->method('inc')->willReturnCallback(function ($key) use (&$calls) {
			$calls[] = $key;
			return 1;
		});

		// New: attempted, kept (still set after pruning).
		// Flags: attempted, pruned (cleared after pruning).
		// Vanished: not under consideration at all.
		$before = Horde_Imap_Client::SYNC_NEWMSGSUIDS | Horde_Imap_Client::SYNC_FLAGSUIDS;
		$after = Horde_Imap_Client::SYNC_NEWMSGSUIDS;

		$this->stats->recordOutcome($before, $after);

		self::assertContains('new_attempted', $calls);
		self::assertContains('flags_attempted', $calls);
		self::assertContains('flags_pruned', $calls);
		self::assertNotContains('new_pruned', $calls);
		self::assertNotContains('vanished_attempted', $calls);
		self::assertNotContains('vanished_pruned', $calls);
	}

	public function testRecordStatusUnusableIncrementsItsOwnCounterOnly(): void {
		$this->memcache->expects(self::once())
			->method('inc')
			->with('status_unusable');

		$this->stats->recordStatusUnusable();
	}

	public function testGetStatsComputesHitRatePerPhase(): void {
		$store = [
			'new_attempted' => 10,
			'new_pruned' => 8,
			'flags_attempted' => 10,
			'flags_pruned' => 1,
			'vanished_attempted' => 0,
			'vanished_pruned' => 0,
			'status_unusable' => 3,
		];
		$this->memcache->method('get')->willReturnCallback(fn ($key) => $store[$key] ?? null);

		$result = $this->stats->getStats();

		self::assertSame(['attempted' => 10, 'pruned' => 8, 'hit_rate' => 80.0], $result['new']);
		self::assertSame(['attempted' => 10, 'pruned' => 1, 'hit_rate' => 10.0], $result['flags']);
		// Never attempted: hit_rate is null (no data), not a misleading 0%.
		self::assertSame(['attempted' => 0, 'pruned' => 0, 'hit_rate' => null], $result['vanished']);
		self::assertSame(3, $result['status_unusable']);
	}

	public function testResetClearsTheWholeCounterSet(): void {
		$this->memcache->expects(self::once())->method('clear');

		$this->stats->reset();
	}

	/**
	 * If the distributed cache backend somehow isn't an IMemcache,
	 * counting must degrade to a best-effort get/set increment instead of
	 * throwing -- this is a diagnostic counter, not something that should
	 * ever break a sync.
	 */
	public function testFallsBackToGetSetWhenTheDistributedCacheIsNotAMemcache(): void {
		$plainCache = $this->createMock(ICache::class);
		$cacheFactory = $this->createMock(ICacheFactory::class);
		$cacheFactory->method('createDistributed')->willReturn($plainCache);
		$stats = new SyncFastPathStats($cacheFactory);

		$plainCache->method('get')->with('status_unusable')->willReturn(4);
		$plainCache->expects(self::once())
			->method('set')
			->with('status_unusable', 5, 0);

		$stats->recordStatusUnusable();
	}
}
