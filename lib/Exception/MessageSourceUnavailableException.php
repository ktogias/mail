<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Exception;

/**
 * The message's raw source could not be read from IMAP because the message is
 * no longer there.
 *
 * Deliberately distinct from a plain ServiceException. A message that has been
 * moved or deleted since the cached copy was written is an ORDINARY outcome --
 * the user opened something the server no longer has -- while a connection
 * failure or a broken mailbox is not. Callers that treat "we cannot answer"
 * as a normal, quiet result must be able to tell the two apart, or they end up
 * silencing real breakage as well.
 */
class MessageSourceUnavailableException extends ServiceException {
	public static function forUid(int $uid): self {
		return new self("Could not fetch message source for uid $uid");
	}
}
