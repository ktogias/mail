<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\Search;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Service\Search\SearchQuery;
use OCA\Mail\Service\Search\SearchTelemetry;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\ICacheFactory;
use OCP\IMemcache;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class SearchTelemetryTest extends TestCase {
	private LoggerInterface&MockObject $logger;
	private ITimeFactory&MockObject $time;
	private ICacheFactory&MockObject $cacheFactory;
	private IMemcache&MockObject $cache;
	private SearchTelemetry $telemetry;

	protected function setUp(): void {
		parent::setUp();
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->time = $this->createMock(ITimeFactory::class);
		$this->time->method('getTime')->willReturn(2_000_000_000);
		$this->cacheFactory = $this->createMock(ICacheFactory::class);
		$this->cache = $this->createMock(IMemcache::class);
		$this->telemetry = new SearchTelemetry($this->logger, $this->time, $this->cacheFactory);
	}

	public function testRecordsRecentSearchWithoutQueryTextOrUserIdentity(): void {
		$this->enableCache();
		$query = new SearchQuery();
		$query->addSubject('private customer name');
		$query->addFrom('secret@example.test');
		$query->setStart((string)(2_000_000_000 - 30 * 86400 + 1));
		$query->setEnd('2000000000');
		$query->setCursor(1_999_999_900);
		$query->setCursorId(42);
		$mailbox = new Mailbox();
		$mailbox->setId(7);
		$mailbox->setAccountId(13);

		$this->logger->expects($this->never())->method('info');
		$this->logger->expects($this->never())->method('warning');
		$this->cache->expects($this->exactly(5))->method('add');
		$increments = [];
		$this->cache->expects($this->exactly(5))
			->method('inc')
			->willReturnCallback(function (string $key, int $step) use (&$increments): int {
				$this->assertStringNotContainsString('private customer name', $key);
				$this->assertStringNotContainsString('secret@example.test', $key);
				$this->assertStringContainsString(':recent_0_30d:18:0:', $key);
				$increments[$key] = $step;
				return $step;
			});

		$this->telemetry->record($query, $mailbox, 'DESC', false, 20, 125_000_000, 4, 'ok');

		$this->assertContains(1, $increments);
		$this->assertContains(125, $increments);
		$this->assertContains(4, $increments);
		$this->assertContains(2, $increments);
	}

	public function testSlowDeepBodySearchIsAWarning(): void {
		$this->enableCache();
		$query = new SearchQuery();
		$query->addBody('private body text');
		$query->setStart((string)(2_000_000_000 - 360 * 86400 + 1));
		$query->setEnd((string)(2_000_000_000 - 180 * 86400));
		$mailbox = new Mailbox();

		$this->logger->expects($this->once())
			->method('warning')
			->with($this->callback(function (string $message): bool {
				$this->assertStringStartsWith('mail_search_slow_or_failed ', $message);
				$this->assertStringNotContainsString('private body text', $message);
				$metric = json_decode(substr($message, strlen('mail_search_slow_or_failed ')), true, 512, JSON_THROW_ON_ERROR);
				$this->assertSame('deep_180d', $metric['windowClass']);
				$this->assertSame('imap_body_and_database', $metric['backend']);
				$this->assertSame(5000, $metric['durationMs']);
				$this->assertArrayNotHasKey('userId', $metric);
				return true;
			}));

		$this->telemetry->record($query, $mailbox, 'DESC', true, 20, 5_000_000_000, 0, 'ok');
	}

	public function testSummarizesAtomicHistogramCounters(): void {
		$this->enableCache();
		$day = gmdate('Ymd', 2_000_000_000);
		$prefix = "$day:recent_0_30d:18:0:";
		$values = [
			$prefix . 'count' => 2,
			$prefix . 'durationMs' => 110,
			$prefix . 'resultCount' => 2,
			$prefix . 'termCount' => 4,
			$prefix . 'bucket0' => 1,
			$prefix . 'bucket3' => 1,
		];
		$this->cache->method('get')->willReturnCallback(static fn (string $key): ?int => $values[$key] ?? null);

		$rows = $this->telemetry->summarize(1);

		$this->assertCount(1, $rows);
		$this->assertSame('recent_0_30d', $rows[0]['windowClass']);
		$this->assertSame('from+subject', $rows[0]['queryShape']);
		$this->assertSame('database', $rows[0]['backend']);
		$this->assertFalse($rows[0]['prioritySplit']);
		$this->assertSame(2, $rows[0]['count']);
		$this->assertSame(10, $rows[0]['p50UpperMs']);
		$this->assertSame(100, $rows[0]['p95UpperMs']);
		$this->assertSame(100, $rows[0]['p99UpperMs']);
		$this->assertSame(55.0, $rows[0]['avgMs']);
		$this->assertSame(1.0, $rows[0]['avgResults']);
		$this->assertSame(2.0, $rows[0]['avgTerms']);
	}

	public function testStructuralListingIsNotRecorded(): void {
		$this->cacheFactory->expects($this->never())->method('createDistributed');
		$this->logger->expects($this->never())->method('info');
		$this->logger->expects($this->never())->method('warning');

		$this->telemetry->record(new SearchQuery(), new Mailbox(), 'DESC', false, 20, 1, 0, 'ok');
	}

	private function enableCache(): void {
		$this->cacheFactory->method('createDistributed')->with('mail_search_metrics')->willReturn($this->cache);
	}
}
