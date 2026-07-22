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
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class SearchTelemetryTest extends TestCase {
	private LoggerInterface&MockObject $logger;
	private ITimeFactory&MockObject $time;
	private SearchTelemetry $telemetry;

	protected function setUp(): void {
		parent::setUp();
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->time = $this->createMock(ITimeFactory::class);
		$this->time->method('getTime')->willReturn(2_000_000_000);
		$this->telemetry = new SearchTelemetry($this->logger, $this->time);
	}

	public function testRecordsRecentSearchWithoutQueryTextOrUserIdentity(): void {
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

		$this->logger->expects($this->once())
			->method('info')
			->with($this->callback(function (string $message): bool {
				$this->assertStringStartsWith('mail_search_metric ', $message);
				$this->assertStringNotContainsString('private customer name', $message);
				$this->assertStringNotContainsString('secret@example.test', $message);
				$metric = json_decode(substr($message, strlen('mail_search_metric ')), true, 512, JSON_THROW_ON_ERROR);
				$this->assertSame('from+subject', $metric['queryShape']);
				$this->assertSame(2, $metric['termCount']);
				$this->assertSame('recent_0_30d', $metric['windowClass']);
				$this->assertSame('database', $metric['backend']);
				$this->assertSame(125, $metric['durationMs']);
				$this->assertSame(4, $metric['resultCount']);
				$this->assertTrue($metric['hasCompositeCursor']);
				$this->assertArrayNotHasKey('userId', $metric);
				return true;
			}));
		$this->logger->expects($this->never())->method('warning');

		$this->telemetry->record($query, $mailbox, 'DESC', false, 20, 125_000_000, 4, 'ok');
	}

	public function testSlowDeepBodySearchIsAWarning(): void {
		$query = new SearchQuery();
		$query->addBody('private body text');
		$query->setStart((string)(2_000_000_000 - 360 * 86400 + 1));
		$query->setEnd((string)(2_000_000_000 - 180 * 86400));
		$mailbox = new Mailbox();

		$this->logger->expects($this->once())
			->method('warning')
			->with($this->callback(function (string $message): bool {
				$metric = json_decode(substr($message, strlen('mail_search_metric ')), true, 512, JSON_THROW_ON_ERROR);
				$this->assertSame('deep_180d', $metric['windowClass']);
				$this->assertSame('imap_body_and_database', $metric['backend']);
				$this->assertSame(5000, $metric['durationMs']);
				return true;
			}));

		$this->telemetry->record($query, $mailbox, 'DESC', true, 20, 5_000_000_000, 0, 'ok');
	}

	public function testStructuralListingIsNotRecorded(): void {
		$this->logger->expects($this->never())->method('info');
		$this->logger->expects($this->never())->method('warning');

		$this->telemetry->record(new SearchQuery(), new Mailbox(), 'DESC', false, 20, 1, 0, 'ok');
	}
}
