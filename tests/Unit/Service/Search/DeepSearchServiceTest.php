<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\Search;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Service\Search\DeepSearchService;

class DeepSearchServiceTest extends TestCase {
	private MessageMapper $messageMapper;
	private IMailSearch $mailSearch;
	private DeepSearchService $service;

	protected function setUp(): void {
		parent::setUp();
		$this->messageMapper = $this->createMock(MessageMapper::class);
		$this->mailSearch = $this->createMock(IMailSearch::class);
		$this->service = new DeepSearchService($this->messageMapper, $this->mailSearch);
	}

	/**
	 * The window containing the oldest message is still searched; the walk
	 * only refuses to go below it. Without a floor this walked towards the
	 * Unix epoch -- measured live at 102 windows and the year 1975 on a
	 * mailbox whose oldest message is 2024-04-21.
	 */
	public function testTheWalkStopsAtTheOldestMessageInsteadOfTheEpoch(): void {
		$this->messageMapper->method('findOldestSentAt')->willReturn(1_890_000_000);
		$this->mailSearch->expects(self::once())
			->method('findMessages')
			->with(
				self::anything(),
				self::anything(),
				IMailSearch::ORDER_NEWEST_FIRST,
				'subject:needle start:1884448001 end:1900000000',
				1_900_000_000,
				20,
				'alice',
				IMailSearch::VIEW_THREADED,
				false,
				888,
			)
			->willReturn([]);

		$result = $this->search(cursorAt: 1_900_000_000, cursorId: 888);

		self::assertTrue($result['exhausted']);
		self::assertNull($result['nextEnd']);
		self::assertSame(1, $result['windows']);
	}

	/**
	 * The other half of the guard: with mail below the window the walk must
	 * continue, or flooring would silently truncate a search.
	 */
	public function testTheWalkContinuesWhileOlderMailExists(): void {
		// A floor far below the first window: the walk must keep going past it
		// rather than stop after one. It does run all the way to the floor
		// here, because a mocked search returns instantly and the time budget
		// never bites -- what is being guarded is that flooring does not
		// TRUNCATE, not that it stops early.
		$this->messageMapper->method('findOldestSentAt')->willReturn(1_000_000_000);
		$this->mailSearch->method('findMessages')->willReturn([]);

		$result = $this->search(cursorAt: 1_900_000_000);

		self::assertGreaterThan(1, $result['windows']);
		self::assertLessThanOrEqual(1_000_000_000, $result['searchedThrough']);
		self::assertTrue($result['exhausted']);
	}

	public function testAnEmptyMailboxIsExhaustedOnTheFirstWindow(): void {
		$this->messageMapper->method('findOldestSentAt')->willReturn(null);
		$this->mailSearch->method('findMessages')->willReturn([]);

		$result = $this->search(cursorAt: 1_900_000_000);

		self::assertTrue($result['exhausted']);
		self::assertSame(1, $result['windows']);
	}

	/**
	 * The continuation token resumes where the last response stopped. It is
	 * the only state in the design, and it lives in the client's hands.
	 */
	public function testAContinuationResumesFromTheTokenAndDropsTheCursor(): void {
		$this->messageMapper->method('findOldestSentAt')->willReturn(1_000_000_000);
		$captured = [];
		$this->mailSearch->method('findMessages')
			->willReturnCallback(function (...$args) use (&$captured) {
				$captured[] = ['filter' => $args[3], 'cursor' => $args[4], 'cursorId' => $args[9]];
				return [];
			});

		$this->service->search(
			$this->account(), $this->mailbox(), 'alice', 'subject:needle',
			IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED,
			1_900_000_000, 888, 20, false, 1_884_448_000, DeepSearchService::MODE_HEADERS,
		);

		self::assertStringContainsString('end:1884448000', $captured[0]['filter']);
		// The cursor already excluded everything above the token; applying it
		// again to a window entirely below it would exclude rows twice.
		self::assertNull($captured[0]['cursor']);
		self::assertNull($captured[0]['cursorId']);
	}

	/**
	 * The headers stream must never reach IMAP -- that is the whole reason it
	 * can cover the entire history in ~100 ms while the body stream spends
	 * ~2.7 s on one round trip.
	 */
	public function testHeadersModeStripsBodyTermsSoItNeverReachesImap(): void {
		$this->messageMapper->method('findOldestSentAt')->willReturn(1_890_000_000);
		$captured = null;
		$this->mailSearch->method('findMessages')
			->willReturnCallback(function (...$args) use (&$captured) {
				$captured = $args[3];
				return [];
			});

		$this->service->search(
			$this->account(), $this->mailbox(), 'alice', 'subject:needle body:secret',
			IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED,
			1_900_000_000, null, 20, false, null, DeepSearchService::MODE_HEADERS,
		);

		self::assertStringNotContainsString('body:', $captured);
		self::assertStringContainsString('subject:needle', $captured);
	}

	/** Body mode keeps the filter as typed, so the two streams overlap by design. */
	public function testBodyModeKeepsTheFilterAsTyped(): void {
		$this->messageMapper->method('findOldestSentAt')->willReturn(1_890_000_000);
		$captured = null;
		$this->mailSearch->method('findMessages')
			->willReturnCallback(function (...$args) use (&$captured) {
				$captured = $args[3];
				return [];
			});

		$this->service->search(
			$this->account(), $this->mailbox(), 'alice', 'subject:needle body:secret',
			IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED,
			1_900_000_000, null, 20, false, null, DeepSearchService::MODE_BODY,
		);

		self::assertStringContainsString('body:secret', $captured);
		self::assertStringContainsString('subject:needle', $captured);
	}

	public function testAFullPageStopsTheWalkWithoutExhaustingHistory(): void {
		$this->messageMapper->method('findOldestSentAt')->willReturn(1_000_000_000);
		$this->mailSearch->expects(self::once())
			->method('findMessages')
			->willReturn([$this->message(991), $this->message(992)]);

		$result = $this->search(cursorAt: 1_900_000_000, limit: 2);

		self::assertCount(2, $result['results']);
		self::assertFalse($result['exhausted']);
		self::assertNotNull($result['nextEnd']);
	}

	public function testResultsAreDeduplicatedAcrossWindows(): void {
		$this->messageMapper->method('findOldestSentAt')->willReturn(1_820_000_000);
		$this->mailSearch->method('findMessages')->willReturn([$this->message(991)]);

		$result = $this->search(cursorAt: 1_900_000_000);

		self::assertGreaterThan(1, $result['windows']);
		self::assertCount(1, $result['results']);
	}

	public function testStripBodyTermsLeavesAnOtherwiseEmptyFilterEmpty(): void {
		self::assertSame('', DeepSearchService::stripBodyTerms('body:one body:two'));
		self::assertSame('subject:x', DeepSearchService::stripBodyTerms('body:one subject:x'));
		self::assertTrue(DeepSearchService::hasBodyTerms('subject:x body:y'));
		self::assertFalse(DeepSearchService::hasBodyTerms('subject:body'));
	}

	/** @return array<string, mixed> */
	private function search(int $cursorAt, ?int $cursorId = null, int $limit = 20): array {
		return $this->service->search(
			$this->account(), $this->mailbox(), 'alice', 'subject:needle',
			IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED,
			$cursorAt, $cursorId, $limit, false, null, DeepSearchService::MODE_HEADERS,
		);
	}

	private function account(): Account {
		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(7);
		$account->method('getUserId')->willReturn('alice');
		return $account;
	}

	private function mailbox(): Mailbox {
		$mailbox = new Mailbox();
		$mailbox->setId(23);
		$mailbox->setAccountId(7);
		return $mailbox;
	}

	private function message(int $databaseId): Message {
		$message = $this->createMock(Message::class);
		$message->method('jsonSerialize')->willReturn([
			'databaseId' => $databaseId,
			'dateInt' => 1_899_000_000,
		]);
		return $message;
	}
}
