<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP;

use Horde_Mime_Part;
use function in_array;

/**
 * One MIME classification policy for message rendering, list metadata and
 * bulk attachment downloads.
 */
final class AttachmentClassifier {
	public const DEFAULT_IGNORED_FILENAMES = [
		'signature.asc',
		'smime.p7s',
	];

	private const SIGNATURE_MIME_TYPES = [
		'application/pgp-signature',
		'application/pkcs7-signature',
		'application/x-pkcs7-signature',
	];

	public static function isRegularAttachment(Horde_Mime_Part $part): bool {
		if ($part->getType() === 'text/calendar' && $part->getName() !== null) {
			return true;
		}

		return ($part->isAttachment() || $part->getType() === 'message/rfc822')
			&& !in_array($part->getType(), self::SIGNATURE_MIME_TYPES, true);
	}

	/**
	 * Horde does not consider Content-Disposition:inline parts attachments.
	 * Mail nevertheless exposes a named inline part as a downloadable
	 * attachment when there is no HTML body in which it could be embedded.
	 *
	 * @param string[] $ignoredFilenames
	 */
	public static function isInlineAttachment(Horde_Mime_Part $part, array $ignoredFilenames = self::DEFAULT_IGNORED_FILENAMES): bool {
		$filename = $part->getName();
		if (in_array($filename, $ignoredFilenames, true)) {
			return false;
		}

		$primaryType = $part->getPrimaryType();
		$hasContentId = $part->getContentId() !== null
			&& !in_array($primaryType, ['text', 'multipart'], true);
		$hasFilename = $filename !== null;
		$isEmbeddedMessage = $part->getType() === 'message/rfc822';

		return $hasContentId || $hasFilename || $isEmbeddedMessage;
	}

	/**
	 * Match IMAPMessage::getFullMessage(): inline parts are separate from
	 * visible attachments for HTML mail, but are merged into the attachment
	 * list for plain-text mail.
	 *
	 * @param string[] $ignoredFilenames
	 */
	public static function isVisibleAttachment(Horde_Mime_Part $part, bool $hasHtmlBody, array $ignoredFilenames = self::DEFAULT_IGNORED_FILENAMES): bool {
		return self::isRegularAttachment($part)
			|| (!$hasHtmlBody && self::isInlineAttachment($part, $ignoredFilenames));
	}

	/**
	 * @param string[] $ignoredFilenames
	 * @return string[]
	 */
	public static function getVisibleAttachmentIds(Horde_Mime_Part $structure, array $ignoredFilenames = self::DEFAULT_IGNORED_FILENAMES): array {
		$hasHtmlBody = $structure->findBody('html') !== null;
		$ids = [];

		foreach ($structure->partIterator() as $part) {
			if (!self::isVisibleAttachment($part, $hasHtmlBody, $ignoredFilenames)) {
				continue;
			}
			$ids[] = $part->getMimeId();
		}

		return $ids;
	}

	/**
	 * @param string[] $ignoredFilenames
	 */
	public static function hasVisibleAttachments(Horde_Mime_Part $structure, array $ignoredFilenames = self::DEFAULT_IGNORED_FILENAMES): bool {
		return self::getVisibleAttachmentIds($structure, $ignoredFilenames) !== [];
	}
}
