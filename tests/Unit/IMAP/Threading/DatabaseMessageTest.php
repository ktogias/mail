<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\IMAP\Threading;

use OCA\Mail\IMAP\Threading\DatabaseMessage;
use PHPUnit\Framework\TestCase;

class DatabaseMessageTest extends TestCase {
	/**
	 * Confirmed live: a message with `references` stored as an empty
	 * string (not NULL -- no References header at all) and no
	 * in_reply_to crashed the whole account sync with an unhandled
	 * TypeError the moment thread rebuilding touched it.
	 * json_decode('', true) returns null, not [], and that null flowed
	 * straight into a constructor parameter typed `array`.
	 */
	public function testEmptyStringReferencesWithNoInReplyToDoesNotCrash(): void {
		$message = DatabaseMessage::fromRowData(
			148462,
			'Προσοχή - Παραστατικό',
			'<msg@example.com>',
			'',
			'',
			null,
		);

		self::assertSame([], $message->getReferences());
	}

	public function testNullReferencesStillWorks(): void {
		$message = DatabaseMessage::fromRowData(
			1,
			'subject',
			'<msg@example.com>',
			null,
			null,
			null,
		);

		self::assertSame([], $message->getReferences());
	}

	public function testEmptyStringReferencesWithAnInReplyToStillIncludesIt(): void {
		$message = DatabaseMessage::fromRowData(
			2,
			'subject',
			'<msg@example.com>',
			'',
			'<parent@example.com>',
			null,
		);

		self::assertSame(['<parent@example.com>'], $message->getReferences());
	}

	public function testValidJsonReferencesAreDecodedAndInReplyToAppended(): void {
		$message = DatabaseMessage::fromRowData(
			3,
			'subject',
			'<msg@example.com>',
			'["<a@example.com>","<b@example.com>"]',
			'<b@example.com>',
			null,
		);

		self::assertSame(['<a@example.com>', '<b@example.com>', '<b@example.com>'], $message->getReferences());
	}

	public function testMalformedJsonReferencesFallsBackToEmptyArrayInsteadOfCrashing(): void {
		$message = DatabaseMessage::fromRowData(
			4,
			'subject',
			'<msg@example.com>',
			'not valid json',
			null,
			null,
		);

		self::assertSame([], $message->getReferences());
	}
}
