<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\IMAP;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\IMAP\ImapMessageFetcher;

class ImapMessageFetcherTest extends TestCase {
	/**
	 * @dataProvider encodedWordsProvider
	 */
	public function testDecodeEncodedWords(?string $expected, string $raw): void {
		self::assertSame($expected, ImapMessageFetcher::decodeEncodedWords($raw));
	}

	public function encodedWordsProvider(): array {
		return [
			'windows-1253 via its Java alias Cp1253 (real Eurobank header; Horde mangled it to latin1 mojibake)' => [
				'Ενημέρωση Eurobank: Κινήσεις Λογαριασμών',
				'=?Cp1253?B?xe3n7N3x+fPnIEV1cm9iYW5rOiDK6e3e8+Xp8iDL7+Ph8enh8+z+7Q==?=',
			],
			'windows-1253 via its IANA name' => [
				'Ενημέρωση Eurobank: Κινήσεις Λογαριασμών',
				'=?windows-1253?B?xe3n7N3x+fPnIEV1cm9iYW5rOiDK6e3e8+Xp8iDL7+Ph8enh8+z+7Q==?=',
			],
			'plain utf-8 base64' => [
				'Ενημέρωση',
				'=?utf-8?B?zpXOvc63zrzOrc+Bz4nPg863?=',
			],
			'quoted-printable with underscores as spaces' => [
				'Hello World',
				'=?utf-8?Q?Hello_World?=',
			],
			'adjacent encoded-words: separating whitespace is dropped' => [
				'αβ',
				"=?utf-8?B?zrE=?= =?utf-8?B?zrI=?=",
			],
			'encoded word mixed with plain text keeps the plain text' => [
				'Re: Ενημέρωση (final)',
				'Re: =?utf-8?B?zpXOvc63zrzOrc+Bz4nPg863?= (final)',
			],
			'RFC 2231 language suffix on the charset is ignored' => [
				'Hello',
				'=?utf-8*en?Q?Hello?=',
			],
			'unknown charset returns null so the caller falls back to Horde' => [
				null,
				'=?x-no-such-charset?B?xe3n7A==?=',
			],
			'invalid base64 returns null' => [
				null,
				'=?utf-8?B?!!!not-base64!!!?=',
			],
			'no encoded words at all passes through unchanged' => [
				'Just a plain subject',
				'Just a plain subject',
			],
		];
	}
}
