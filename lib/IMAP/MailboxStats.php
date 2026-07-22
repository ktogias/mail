<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP;

use JsonSerializable;
use ReturnTypeWillChange;

final class MailboxStats implements JsonSerializable {
	/**
	 * @param int $total messages on the server (IMAP STATUS count)
	 * @param int $unread unread messages on the server
	 * @param int|null $cached messages already imported into the local DB --
	 *     only meaningful, and only supplied, while a mailbox is still
	 *     backfilling its initial sync; null otherwise (e.g. the plain /stats
	 *     endpoint, which has no reason to run the count)
	 * @param bool $complete whether the initial sync has finished (see
	 *     Mailbox::isCached()); when false the client can show a
	 *     "still importing older messages ($cached of $total)" indicator
	 */
	public function __construct(
		private int $total,
		private int $unread,
		private ?int $cached = null,
		private bool $complete = true,
	) {
	}

	public function getTotal(): int {
		return $this->total;
	}

	public function getUnread(): int {
		return $this->unread;
	}

	public function getCached(): ?int {
		return $this->cached;
	}

	public function isComplete(): bool {
		return $this->complete;
	}

	#[\Override]
	#[ReturnTypeWillChange]
	public function jsonSerialize() {
		$data = [
			'total' => $this->total,
			'unread' => $this->unread,
			'complete' => $this->complete,
		];
		if ($this->cached !== null) {
			$data['cached'] = $this->cached;
		}
		return $data;
	}
}
