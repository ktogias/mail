<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\IMAP\Threading;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\IMAP\Threading\DatabaseMessage;
use OCA\Mail\IMAP\Threading\ThreadBuilder;
use OCA\Mail\IMAP\Threading\ThreadClosure;
use OCA\Mail\IMAP\Threading\ThreadClosureRepository;
use OCA\Mail\IMAP\Threading\ThreadIdAssigner;
use OCA\Mail\Support\PerformanceLogger;
use OCP\AppFramework\Utility\ITimeFactory;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;
use function array_slice;
use function count;
use function getenv;
use function in_array;
use function iterator_to_array;

/**
 * The equivalence invariant, checked against a real mailbox instead of shapes
 * someone thought of.
 *
 * ThreadClosureEquivalenceTest covers five hand-built cases. They are the
 * shapes I could imagine; they are not the shapes fifteen years of real mail
 * produces -- mailing lists that rewrite References, clients that drop
 * In-Reply-To, forwards, auto-responders reusing a Message-ID. The failure mode
 * is silent, so "it passed the cases I invented" is not evidence.
 *
 * Skipped unless MAIL_THREADING_DUMP points at a JSONL export of
 * (id, subject, message_id, references, in_reply_to) for one account. The dump
 * contains real subjects and is never committed.
 *
 *   psql -At -f export.sql > threading-real.jsonl
 *   MAIL_THREADING_DUMP=/path/threading-real.jsonl \
 *     run-php-unit-tests.sh Unit/IMAP/Threading/ThreadClosureRealDataTest.php
 */
class ThreadClosureRealDataTest extends TestCase {
	/** @var array<int, array{id:int,subject:?string,message_id:string,references:?string,in_reply_to:?string}> */
	private array $rows = [];

	protected function setUp(): void {
		parent::setUp();

		$dump = getenv('MAIL_THREADING_DUMP');
		if ($dump === false || !is_readable($dump)) {
			self::markTestSkipped('MAIL_THREADING_DUMP is not set to a readable export');
		}

		$handle = fopen($dump, 'rb');
		while (($line = fgets($handle)) !== false) {
			$line = trim($line);
			if ($line === '') {
				continue;
			}
			$row = json_decode($line, true);
			if ($row === null || ($row['message_id'] ?? null) === null) {
				continue;
			}
			$this->rows[] = $row;
		}
		fclose($handle);
	}

	/**
	 * Fresh objects every time: the builder mutates them, so reusing a corpus
	 * between passes would let the full run seed the incremental one.
	 *
	 * @param array<int, array> $rows
	 *
	 * @return DatabaseMessage[]
	 */
	private function materialise(array $rows): array {
		$messages = [];
		foreach ($rows as $row) {
			$messages[] = DatabaseMessage::fromRowData(
				(int)$row['id'],
				(string)($row['subject'] ?? ''),
				$row['message_id'],
				$row['references'],
				$row['in_reply_to'],
				null,
			);
		}
		return $messages;
	}

	/**
	 * @param array<int, array> $rows
	 *
	 * @return array<string, string> Message-ID => thread_root_id
	 */
	private function threadIds(array $rows): array {
		$messages = $this->materialise($rows);
		$builder = new ThreadBuilder(new PerformanceLogger(
			$this->createMock(ITimeFactory::class),
			$this->createMock(LoggerInterface::class),
		));
		iterator_to_array(ThreadIdAssigner::assign($builder->build($messages, new NullLogger())), false);

		$ids = [];
		foreach ($messages as $message) {
			$ids[$message->getId()] = $message->getThreadRootId();
		}
		unset($messages);
		return $ids;
	}

	/** @param array<string, string> $stored */
	private function repository(array $stored): ThreadClosureRepository {
		return new class($stored) implements ThreadClosureRepository {
			public function __construct(private array $stored) {
			}

			public function threadRootsOfMessages(array $messageIds): array {
				$roots = [];
				foreach ($messageIds as $messageId) {
					if (isset($this->stored[$messageId])) {
						$roots[] = $this->stored[$messageId];
					}
				}
				return $roots;
			}
		};
	}

	public function testTheClosureAgreesWithAFullRebuildOnRealMail(): void {
		$total = count($this->rows);
		self::assertGreaterThan(1000, $total, 'the export looks too small to be a real mailbox');

		// A SPREAD sample, not the tail. Taking the last 500 rows by id looked
		// like a sync batch but was a contiguous run of one folder being
		// backfilled: those messages reference each other, so the closure was
		// satisfied from within the batch and never reached into the existing
		// corpus at all. Both halves of the closure could then be deleted and
		// this test still passed. Seeded so a failure is reproducible.
		mt_srand(20260728);
		$batchIndexes = [];
		while (count($batchIndexes) < 500) {
			$batchIndexes[mt_rand(0, $total - 1)] = true;
		}

		$batchRows = [];
		$existingRows = [];
		foreach ($this->rows as $index => $row) {
			if (isset($batchIndexes[$index])) {
				$batchRows[] = $row;
			} else {
				$existingRows[] = $row;
			}
		}

		$full = $this->threadIds($this->rows);
		$stored = $this->threadIds($existingRows);

		$batchMessageIds = [];
		$batchReferences = [];
		foreach ($this->materialise($batchRows) as $message) {
			$batchMessageIds[] = $message->getId();
			foreach ($message->getReferences() as $reference) {
				$batchReferences[] = $reference;
			}
		}

		$roots = ThreadClosure::resolve($batchMessageIds, $batchReferences, $this->repository($stored));

		$closureRows = $batchRows;
		foreach ($existingRows as $row) {
			$root = $stored[$row['message_id']] ?? null;
			if ($root !== null && in_array($root, $roots, true)) {
				$closureRows[] = $row;
			}
		}
		$incremental = $this->threadIds($closureRows);

		// The state the database would be left in.
		$result = $stored;
		foreach ($incremental as $messageId => $threadRootId) {
			$result[$messageId] = $threadRootId;
		}

		// Refuse to pass on a sample that exercised nothing: if the closure
		// never reached past the batch, an empty divergence set says only that
		// the test did no work.
		self::assertGreaterThan(
			count($batchRows),
			count($closureRows),
			'the closure pulled in no existing messages, so this run proves nothing',
		);

		$divergent = [];
		foreach ($full as $messageId => $threadRootId) {
			if (($result[$messageId] ?? null) !== $threadRootId) {
				$divergent[$messageId] = [$threadRootId, $result[$messageId] ?? null];
			}
		}

		self::assertSame(
			[],
			array_slice($divergent, 0, 20, true),
			sprintf(
				'%d of %d messages get a different thread from the closure than from a full rebuild '
					. '(closure touched %d threads, %d messages)',
				count($divergent),
				$total,
				count($roots),
				count($closureRows),
			),
		);
	}
}
