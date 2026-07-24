<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\IMAP;

use ChristophWurst\Nextcloud\Testing\TestCase;
use Horde_Mime_Part;
use OCA\Mail\IMAP\AttachmentClassifier;

class AttachmentClassifierTest extends TestCase {
	public function testNamedInlineImagesAreVisibleAttachmentsInPlainMessage(): void {
		$structure = Horde_Mime_Part::parseMessage(
			file_get_contents(__DIR__ . '/../../data/plain-message-with-inline-file-images.txt'),
		);

		self::assertSame(['2', '4'], AttachmentClassifier::getVisibleAttachmentIds($structure));
		self::assertTrue(AttachmentClassifier::hasVisibleAttachments($structure));
	}

	public function testEmbeddedHtmlImageIsNotExposedAsDownloadableAttachment(): void {
		$structure = Horde_Mime_Part::parseMessage(<<<'MAIL'
MIME-Version: 1.0
Content-Type: multipart/related; boundary="related"

--related
Content-Type: text/html; charset=UTF-8

<img src="cid:logo">
--related
Content-Type: image/png; name="logo.png"
Content-Disposition: inline; filename="logo.png"
Content-ID: <logo>
Content-Transfer-Encoding: base64

bG9nbw==
--related--
MAIL);

		self::assertSame([], AttachmentClassifier::getVisibleAttachmentIds($structure));
		self::assertFalse(AttachmentClassifier::hasVisibleAttachments($structure));
	}

	public function testRegularAttachmentRemainsVisibleInHtmlMessage(): void {
		$structure = Horde_Mime_Part::parseMessage(<<<'MAIL'
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mixed"

--mixed
Content-Type: text/html; charset=UTF-8

<p>Hello</p>
--mixed
Content-Type: application/pdf; name="report.pdf"
Content-Disposition: attachment; filename="report.pdf"
Content-Transfer-Encoding: base64

cmVwb3J0
--mixed--
MAIL);

		self::assertSame(['2'], AttachmentClassifier::getVisibleAttachmentIds($structure));
	}
}
