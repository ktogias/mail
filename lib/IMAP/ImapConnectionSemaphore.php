<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP;

use OCP\IMemcache;
use OCP\IMemcacheTTL;
use function bin2hex;
use function random_bytes;

/**
 * A distributed, per-account IMAP connection semaphore.
 *
 * Each slot has a bounded TTL so a killed PHP worker cannot leak capacity.
 * Release uses compare-and-delete with a random owner token, preventing a
 * stale worker from deleting a slot that expired and was acquired by another
 * request in the meantime.
 */
final class ImapConnectionSemaphore {
	private const SLOT_TTL_SECONDS = 5 * 60;

	private string $owner;
	private ?string $slotKey = null;

	public function __construct(
		private IMemcache $cache,
		private string $identity,
		private int $limit,
	) {
		$this->owner = bin2hex(random_bytes(16));
	}

	public function acquire(): bool {
		if ($this->slotKey !== null) {
			if (!($this->cache instanceof IMemcacheTTL)
				|| $this->cache->compareSetTTL($this->slotKey, $this->owner, self::SLOT_TTL_SECONDS)) {
				return true;
			}
			// The TTL elapsed and another request acquired this slot. Forget
			// the stale ownership and try to acquire any currently free slot.
			$this->slotKey = null;
		}

		for ($slot = 0; $slot < $this->limit; $slot++) {
			$key = $this->identity . '_slot_' . $slot;
			if ($this->cache->add($key, $this->owner, self::SLOT_TTL_SECONDS)) {
				$this->slotKey = $key;
				return true;
			}
		}

		return false;
	}

	public function release(): void {
		if ($this->slotKey === null) {
			return;
		}

		$this->cache->cad($this->slotKey, $this->owner);
		$this->slotKey = null;
	}

	public function getLimit(): int {
		return $this->limit;
	}

	public function __destruct() {
		$this->release();
	}
}
