<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP;

use Closure;
use OCP\IMemcache;
use OCP\IMemcacheTTL;
use function bin2hex;
use function max;
use function min;
use function random_bytes;
use function usleep;

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
	/** @var Closure(int): void */
	private Closure $sleep;

	public function __construct(
		private IMemcache $cache,
		private string $identity,
		private int $limit,
		private int $reservedSlots = 0,
		?Closure $sleep = null,
	) {
		$this->owner = bin2hex(random_bytes(16));
		$this->reservedSlots = max(0, min($this->reservedSlots, max($this->limit - 1, 0)));
		$this->sleep = $sleep ?? static function (int $microseconds): void {
			usleep($microseconds);
		};
	}

	/**
	 * Acquire one connection slot.
	 *
	 * Ordinary/background callers cannot consume the highest-numbered
	 * reserved slots. Interactive mutations may opt into them, while still
	 * sharing the same key-space and therefore the same hard total limit.
	 */
	public function acquire(bool $allowReservedSlots = false, int $waitMilliseconds = 0): bool {
		if ($this->slotKey !== null) {
			if (!($this->cache instanceof IMemcacheTTL)
				|| $this->cache->compareSetTTL($this->slotKey, $this->owner, self::SLOT_TTL_SECONDS)) {
				return true;
			}
			// The TTL elapsed and another request acquired this slot. Forget
			// the stale ownership and try to acquire any currently free slot.
			$this->slotKey = null;
		}

		$remainingWaitMilliseconds = max(0, $waitMilliseconds);
		do {
			$availableLimit = $this->getAvailableLimit($allowReservedSlots);
			for ($offset = 0; $offset < $availableLimit; $offset++) {
				// Interactive callers consume the reserved, highest-numbered slots
				// first. This leaves ordinary capacity available when the interactive
				// request arrives before the background work.
				$slot = $allowReservedSlots ? $availableLimit - $offset - 1 : $offset;
				$key = $this->identity . '_slot_' . $slot;
				if ($this->cache->add($key, $this->owner, self::SLOT_TTL_SECONDS)) {
					$this->slotKey = $key;
					return true;
				}
			}

			if ($remainingWaitMilliseconds === 0) {
				return false;
			}

			$sleepMilliseconds = min(50, $remainingWaitMilliseconds);
			($this->sleep)($sleepMilliseconds * 1_000);
			$remainingWaitMilliseconds -= $sleepMilliseconds;
		} while (true);
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

	public function getAvailableLimit(bool $allowReservedSlots): int {
		return $allowReservedSlots
			? $this->limit
			: max($this->limit - $this->reservedSlots, 1);
	}

	public function __destruct() {
		$this->release();
	}
}
