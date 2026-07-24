<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Exception;

use Horde_Imap_Client_Exception;

/**
 * Explicit overload signal for the bounded per-account IMAP semaphore.
 *
 * Extending Horde's exception keeps existing catch/finally paths compatible
 * while allowing the HTTP boundary to return 429 + Retry-After.
 */
class ImapCapacityException extends Horde_Imap_Client_Exception {
}
