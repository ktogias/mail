<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\Search;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Service\Search\FilterStringParser;
use OCA\Mail\Service\Search\Flag;

class FilterStringParserTest extends TestCase {
	private FilterStringParser $parser;

	protected function setUp(): void {
		parent::setUp();

		$this->parser = new FilterStringParser();
	}

	/**
	 * Partition ("remainder-category") tokens: is:pi-other must mean
	 * "no message in this thread is important" in threaded view, so it
	 * parses to a thread-EXCLUDED positive flag, not a plain negated
	 * flag (which the thread-wide EXISTS match would read as "some
	 * member is not important" -- listing every mixed thread in both
	 * priority sections at once, confirmed live).
	 */
	public function testPiOtherParsesToThreadExcludedImportant(): void {
		$query = $this->parser->parse('is:pi-other');

		self::assertEmpty($query->getFlags());
		self::assertEmpty($query->getFlagExpressions());
		self::assertCount(1, $query->getThreadExcludedFlags());
		$flag = $query->getThreadExcludedFlags()[0];
		self::assertEquals(Flag::IMPORTANT, $flag->getFlag());
		self::assertTrue($flag->isSet());
	}

	/**
	 * not:starred exists to make sections the complement of Favorites
	 * (the "sort favorites separately" compound keys) -- same partition
	 * semantics as pi-other, over the FLAGGED flag.
	 */
	public function testNotStarredParsesToThreadExcludedFlagged(): void {
		$query = $this->parser->parse('not:starred');

		self::assertEmpty($query->getFlags());
		self::assertCount(1, $query->getThreadExcludedFlags());
		$flag = $query->getThreadExcludedFlags()[0];
		self::assertEquals(Flag::FLAGGED, $flag->getFlag());
		self::assertTrue($flag->isSet());
	}

	/**
	 * Regression guard: "unread" arrives as a negative flag too
	 * (SEEN=false) but must KEEP existential thread semantics -- a
	 * thread with any unseen member must keep matching the unread
	 * filter, the exact behavior the thread-wide EXISTS match was
	 * introduced for. Only the two partition tokens above are
	 * thread-excluded.
	 */
	public function testUnreadStaysAPlainNegativeFlag(): void {
		$query = $this->parser->parse('is:unread');

		self::assertEmpty($query->getThreadExcludedFlags());
		self::assertCount(1, $query->getFlags());
		$flag = $query->getFlags()[0];
		self::assertEquals(Flag::SEEN, $flag->getFlag());
		self::assertFalse($flag->isSet());
	}

	public function testIsStarredStaysAPlainPositiveFlag(): void {
		$query = $this->parser->parse('is:starred');

		self::assertEmpty($query->getThreadExcludedFlags());
		self::assertCount(1, $query->getFlags());
		$flag = $query->getFlags()[0];
		self::assertEquals(Flag::FLAGGED, $flag->getFlag());
		self::assertTrue($flag->isSet());
	}

	/**
	 * The compound key the priority inbox actually loads when favorites
	 * sort separately: important-EXISTS plus starred-EXCLUDED together.
	 */
	public function testCompoundNotStarredPiImportant(): void {
		$query = $this->parser->parse('not:starred is:pi-important');

		self::assertCount(1, $query->getFlagExpressions());
		self::assertCount(1, $query->getThreadExcludedFlags());
		self::assertEquals(Flag::FLAGGED, $query->getThreadExcludedFlags()[0]->getFlag());
		self::assertEmpty($query->getFlags());
	}
}
