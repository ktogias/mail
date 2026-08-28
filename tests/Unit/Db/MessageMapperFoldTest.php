<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Db;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Support\PerformanceLogger;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\ICacheFactory;
use OCP\IDBConnection;

/**
 * The PHP half of the search's text fold.
 *
 * Its whole job is to agree, character for character, with what
 * `translate(lower(column), FOLD_FROM, FOLD_TO)` produces in PostgreSQL --
 * the expected values below were taken from the live database, not written
 * from the specification. If the two halves ever drift, searches silently
 * return nothing for the affected words, which is exactly the bug this
 * replaced.
 */
class MessageMapperFoldTest extends TestCase {
	private MessageMapper $mapper;

	protected function setUp(): void {
		parent::setUp();

		$this->mapper = new MessageMapper(
			$this->createMock(IDBConnection::class),
			$this->createMock(ITimeFactory::class),
			$this->createMock(TagMapper::class),
			$this->createMock(PerformanceLogger::class),
			$this->createMock(ICacheFactory::class),
		);
	}

	/**
	 * @dataProvider foldingProvider
	 */
	public function testFoldSearchText(string $input, string $expected): void {
		$this->assertSame($expected, $this->mapper->foldSearchText($input));
	}

	/**
	 * The fold is not free: translate(lower(subject)) is computed for every
	 * candidate row, and no index removes that in the plan this predicate
	 * lands in. Measured on mailbox 194 (193,847 messages): 1,549 ms
	 * unfolded against 17,287 ms folded. A term with no Greek in it cannot
	 * match differently either way, so folding one is pure loss -- and a
	 * silent one, because the results stay correct.
	 *
	 * @dataProvider needsFoldingProvider
	 */
	public function testTermNeedsFolding(string $term, bool $expected): void {
		$this->assertSame($expected, MessageMapper::termNeedsFolding($term));
	}

	public function needsFoldingProvider(): array {
		return [
			'greek word' => ['εκθέματος', true],
			'greek capitals' => ['ΕΚΘΕΜΑΤΟΣ', true],
			'one greek letter in a mixed term' => ['ΔΕΘ2026', true],
			// Everything below is the common case, and every one of them
			// must keep the plan and the timing it has today.
			'plain latin' => ['ifiroumelioti', false],
			'an address' => ['ifiroumelioti@isi.gr', false],
			'accented latin is not greek' => ['Café', false],
			'digits' => ['2026', false],
			'empty' => ['', false],
			// Cyrillic shares letterforms with Greek but not the block --
			// folding it would do nothing except cost.
			'cyrillic' => ['Москва', false],
		];
	}

	public function foldingProvider(): array {
		return [
			// The reported case: the body reads ΕΚΘΈΜΑΤΟΣ, the user types
			// εκθέματος, and before the fold those never met -- lowercasing
			// Σ yields σ, never the final ς the user typed.
			'capitals meet the term' => ['ΕΚΘΈΜΑΤΟΣ', 'εκθεματοσ'],
			'the term itself' => ['εκθέματος', 'εκθεματοσ'],
			'and the untoned spelling' => ['εκθεματος', 'εκθεματοσ'],
			// Verified against PostgreSQL: SELECT translate(lower('ΤΊΤΛΟΣ
			// ΕΚΘΈΜΑΤΟΣ'), 'άέήίόύώϊϋΐΰς', 'αεηιουωιυιυσ')
			'the whole phrase' => ['ΤΊΤΛΟΣ ΕΚΘΈΜΑΤΟΣ', 'τιτλοσ εκθεματοσ'],
			'diaereses fold too' => ['Ϊσραήλ', 'ισραηλ'],
			'both marks at once' => ['ΐ', 'ι'],
			// A pure character map must not disturb anything outside Greek:
			// addresses and Latin subjects go through the same helper.
			'addresses are untouched' => ['Ifiroumelioti@ISI.gr', 'ifiroumelioti@isi.gr'],
			'latin keeps its own accents' => ['Café', 'café'],
			'digits and wildcards survive' => ['2026 % _', '2026 % _'],
			'empty stays empty' => ['', ''],
			// Idempotent: folding an already-folded term must not move it,
			// or a re-search would ask something different than the first.
			'idempotent' => ['εκθεματοσ', 'εκθεματοσ'],
		];
	}
}
