<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Command;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Command\FastPathStats;
use OCA\Mail\Service\Sync\SyncFastPathStats;
use Symfony\Component\Console\Input\ArrayInput;
use Symfony\Component\Console\Output\BufferedOutput;

class FastPathStatsTest extends TestCase {
	private SyncFastPathStats&\PHPUnit\Framework\MockObject\MockObject $stats;
	private FastPathStats $command;

	protected function setUp(): void {
		parent::setUp();

		$this->stats = $this->createMock(SyncFastPathStats::class);
		$this->command = new FastPathStats($this->stats);
	}

	public function testName(): void {
		self::assertSame('mail:sync:fastpath-stats', $this->command->getName());
	}

	public function testResetOptionClearsCountersAndSkipsPrintingStats(): void {
		$this->stats->expects(self::once())->method('reset');
		$this->stats->expects(self::never())->method('getStats');

		$input = new ArrayInput(['--reset' => true], $this->command->getDefinition());
		$output = new BufferedOutput();
		$exitCode = $this->command->run($input, $output);

		self::assertSame(0, $exitCode);
		self::assertStringContainsString('reset', strtolower($output->fetch()));
	}

	public function testPrintsHitRatePerPhaseAndUnusableCount(): void {
		$this->stats->method('getStats')->willReturn([
			'new' => ['attempted' => 10, 'pruned' => 8, 'hit_rate' => 80.0],
			'flags' => ['attempted' => 10, 'pruned' => 1, 'hit_rate' => 10.0],
			'vanished' => ['attempted' => 0, 'pruned' => 0, 'hit_rate' => null],
			'status_unusable' => 3,
		]);

		$input = new ArrayInput([], $this->command->getDefinition());
		$output = new BufferedOutput();
		$exitCode = $this->command->run($input, $output);

		$printed = $output->fetch();
		self::assertSame(0, $exitCode);
		self::assertStringContainsString('80', $printed);
		self::assertStringContainsString('10', $printed);
		self::assertStringContainsString('n/a', $printed);
		self::assertStringContainsString('3', $printed);
	}
}
