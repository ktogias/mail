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
use function array_filter;
use function array_map;
use function array_merge;
use function array_values;
use function in_array;
use function iterator_to_array;

/**
 * The correctness oracle for incremental threading.
 *
 * Rebuilding every thread of an account to absorb a handful of new messages
 * costs 169,970 messages and 274MB here, for threads whose median size is one.
 * Narrowing that to the threads a batch can reach is only safe if it produces
 * the SAME thread ids as rebuilding everything -- and the failure mode if it
 * does not is silent: conversations quietly split or quietly merged, noticed
 * weeks later with no way to tell which messages are wrong.
 *
 * So the invariant is stated and checked directly:
 *
 *   for any batch B, threading closure(B) assigns every message in closure(B)
 *   the same thread_root_id as threading the entire corpus does.
 *
 * Both sides run the SAME ThreadBuilder and the SAME ThreadIdAssigner the
 * account sync runs. An oracle that reimplements the thing it checks proves
 * nothing about the thing it checks.
 */
class ThreadClosureEquivalenceTest extends TestCase {
	/** @var DatabaseMessage[] */
	private array $corpus = [];
	private int $nextId = 1;

	/**
	 * @param string[] $references
	 */
	private function message(string $messageId, string $subject, array $references = []): DatabaseMessage {
		$message = DatabaseMessage::fromRowData(
			$this->nextId++,
			$subject,
			$messageId,
			json_encode($references),
			null,
			null,
		);
		$this->corpus[] = $message;
		return $message;
	}

	/**
	 * Thread ids as the account sync would compute them over a given set.
	 *
	 * @param DatabaseMessage[] $messages
	 *
	 * @return array<string, string> Message-ID => thread_root_id
	 */
	private function threadIds(array $messages): array {
		// Fresh objects: the builder mutates them, and the full run must not
		// leave state behind that makes the incremental run look correct.
		$copies = array_map(
			static fn (DatabaseMessage $m): DatabaseMessage => DatabaseMessage::fromRowData(
				$m->getDatabaseId(),
				$m->getSubject(),
				$m->getId(),
				json_encode($m->getReferences()),
				null,
				null,
			),
			$messages,
		);
		$threads = (new ThreadBuilder($this->performanceLogger()))->build($copies, new NullLogger());
		iterator_to_array(ThreadIdAssigner::assign($threads), false);

		$ids = [];
		foreach ($copies as $copy) {
			$ids[$copy->getId()] = $copy->getThreadRootId();
		}
		return $ids;
	}

	private function performanceLogger(): PerformanceLogger {
		return new PerformanceLogger(
			$this->createMock(ITimeFactory::class),
			$this->createMock(LoggerInterface::class),
		);
	}

	/**
	 * The repository over the corpus, using the thread ids a full rebuild
	 * produced -- which is the state the database is actually in before a
	 * batch arrives.
	 *
	 * @param array<string, string> $storedThreadIds
	 */
	private function repository(array $storedThreadIds): ThreadClosureRepository {
		return new class($storedThreadIds) implements ThreadClosureRepository {
			public function __construct(
				private array $stored,
			) {
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

	/**
	 * @param DatabaseMessage[] $batch
	 *
	 * @return DatabaseMessage[]
	 */
	private function closureOf(array $batch, array $storedThreadIds): array {
		$roots = ThreadClosure::resolve(
			array_map(static fn (DatabaseMessage $m): string => $m->getId(), $batch),
			array_merge(...array_map(static fn (DatabaseMessage $m): array => $m->getReferences(), $batch)) ?: [],
			$this->repository($storedThreadIds),
		);

		$closure = $batch;
		foreach ($this->corpus as $message) {
			if (in_array($message, $batch, true)) {
				continue;
			}
			$root = $storedThreadIds[$message->getId()] ?? null;
			if ($root !== null && in_array($root, $roots, true)) {
				$closure[] = $message;
			}
		}
		return $closure;
	}

	/**
	 * @param DatabaseMessage[] $batch
	 */
	private function assertClosureMatchesFullRebuild(array $batch): void {
		$existing = array_values(array_filter(
			$this->corpus,
			static fn (DatabaseMessage $m): bool => !in_array($m, $batch, true),
		));
		$stored = $this->threadIds($existing);

		$full = $this->threadIds($this->corpus);
		$closure = $this->closureOf($batch, $stored);
		$incremental = $this->threadIds($closure);

		// The state the database would be left in: everything the closure
		// touched gets its new id, everything else keeps the id it already
		// had. Comparing only the closure -- which is what this assertion did
		// first -- lets a closure that is too SMALL pass, because the messages
		// it wrongly left behind are exactly the ones not being checked.
		$result = $stored;
		foreach ($incremental as $messageId => $threadRootId) {
			$result[$messageId] = $threadRootId;
		}

		foreach ($full as $messageId => $threadRootId) {
			self::assertSame(
				$threadRootId,
				$result[$messageId] ?? null,
				"thread id for $messageId differs between a full rebuild and the incremental update",
			);
		}
	}

	public function testAReplyJoinsTheThreadItReferences(): void {
		$a1 = $this->message('<a1>', 'Budget');
		$a2 = $this->message('<a2>', 'Re: Budget', ['<a1>']);
		$new = $this->message('<a3>', 'Re: Budget', ['<a1>', '<a2>']);

		$this->assertClosureMatchesFullRebuild([$new]);
		self::assertNotNull($a1);
		self::assertNotNull($a2);
	}

	public function testOneMessageReferencingTwoThreadsMergesBoth(): void {
		$this->message('<c1>', 'Design');
		$this->message('<d1>', 'Deadline');
		// Forwards one conversation into the other: a single new message that
		// names a message from each merges two previously separate threads.
		$new = $this->message('<x1>', 'Design and deadline', ['<c1>', '<d1>']);

		$this->assertClosureMatchesFullRebuild([$new]);
	}

	public function testAMissingAncestorArrivingLaterAdoptsTheOrphans(): void {
		// b2 and b3 both hang off <b1>, which was never received, so their
		// thread_root_id IS the string '<b1>'. When b1 finally arrives the
		// backward lookup has to find them by that equality -- this is the
		// case that would otherwise need a text search through `references`.
		$this->message('<b2>', 'Re: Retro', ['<b1>']);
		$this->message('<b3>', 'Re: Retro', ['<b1>', '<b2>']);
		$new = $this->message('<b1>', 'Retro');

		$this->assertClosureMatchesFullRebuild([$new]);
	}

	public function testAMissingAncestorThatBelongsToAnOlderThreadRepatriatesTheOrphans(): void {
		// The case that separates the two halves of the closure. g2 and g3 hang
		// off <g1>, never received, so their stored root is the string '<g1>'.
		// When g1 finally arrives it turns out to be a reply to an older thread,
		// so the correct answer moves g2 and g3 from '<g1>' to '<f0>' -- and
		// they are only re-threaded if the batch's own Message-ID is treated as
		// a root. Following the batch's references alone reaches f0 but leaves
		// the orphans behind, still carrying an id a full rebuild disagrees
		// with. Without this the closure could drop that half and no test would
		// notice.
		$this->message('<f0>', 'Roadmap');
		$this->message('<g2>', 'Re: Roadmap', ['<g1>']);
		$this->message('<g3>', 'Re: Roadmap', ['<g1>', '<g2>']);
		$new = $this->message('<g1>', 'Re: Roadmap', ['<f0>']);

		$this->assertClosureMatchesFullRebuild([$new]);
	}

	public function testUnrelatedThreadsSharingASubjectAreTheKnownGap(): void {
		// ThreadBuilder's step 5 merges root-level threads by normalised
		// subject with NO reference between them. No closure can reach that:
		// the blast radius is not connected. This is asserted rather than
		// left to be discovered, so that anyone claiming the incremental path
		// is fully equivalent is contradicted by a test.
		$this->message('<e1>', 'Invoice');
		$this->message('<f1>', 'Invoice');
		$new = $this->message('<e2>', 'Re: Invoice', ['<e1>']);

		$stored = $this->threadIds(array_values(array_filter(
			$this->corpus,
			static fn (DatabaseMessage $m): bool => $m->getId() !== '<e2>',
		)));
		$roots = ThreadClosure::resolve(['<e2>'], ['<e1>'], $this->repository($stored));

		self::assertContains($stored['<e1>'], $roots);
		self::assertNotContains(
			$stored['<f1>'],
			$roots,
			'the subject-only relationship is deliberately outside the closure; a periodic full rebuild repairs it',
		);
		self::assertNotNull($new);
	}
}
