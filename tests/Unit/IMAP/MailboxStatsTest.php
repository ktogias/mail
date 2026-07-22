<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\IMAP;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\IMAP\MailboxStats;

class MailboxStatsTest extends TestCase {
	public function testPlainStatsStayBackwardCompatible(): void {
		$stats = new MailboxStats(42, 10);

		self::assertSame(42, $stats->getTotal());
		self::assertSame(10, $stats->getUnread());
		self::assertNull($stats->getCached());
		self::assertTrue($stats->isComplete());
		// A fully-synced/plain mailbox emits complete:true and NO cached key.
		self::assertSame([
			'total' => 42,
			'unread' => 10,
			'complete' => true,
		], $stats->jsonSerialize());
	}

	public function testBackfillProgressIsSerialisedWhenIncomplete(): void {
		$stats = new MailboxStats(98000, 3, 5000, false);

		self::assertSame(5000, $stats->getCached());
		self::assertFalse($stats->isComplete());
		self::assertSame([
			'total' => 98000,
			'unread' => 3,
			'complete' => false,
			'cached' => 5000,
		], $stats->jsonSerialize());
	}

	public function testCachedKeyOmittedWhenNull(): void {
		// complete:false but no count supplied -- still no `cached` key
		// (the client falls back to the count-less "still importing" text).
		$stats = new MailboxStats(98000, 3, null, false);

		self::assertArrayNotHasKey('cached', $stats->jsonSerialize());
		self::assertFalse($stats->jsonSerialize()['complete']);
	}
}
