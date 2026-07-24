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
	private const FOREGROUND_WAITER_TTL_SECONDS = 2;

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
		$workClass = $allowReservedSlots
			? ImapWorkClass::QUICK_MUTATION
			: ($waitMilliseconds > 0 ? ImapWorkClass::ACTIVE_CONTENT : ImapWorkClass::MAINTENANCE);
		return $this->acquireFor($workClass, $waitMilliseconds);
	}

	/**
	 * Acquire capacity according to a work class.
	 *
	 * With the production default of three connections and one reserved slot:
	 * - quick mutations may use 2, 1 or 0 and prefer slot 2;
	 * - foreground reads/explicit refreshes may use 1 or 0;
	 * - background work normally borrows 1 but falls back to slot 0 while a
	 *   foreground waiter is present.
	 *
	 * The short distributed waiter marker is deliberately a lease, not a
	 * counter. A killed request therefore cannot permanently suppress
	 * background work, while all PHP workers and browser tabs still see the
	 * same priority signal.
	 */
	public function acquireFor(string $workClass, int $waitMilliseconds = 0): bool {
		if ($this->slotKey !== null) {
			if (!($this->cache instanceof IMemcacheTTL)
				|| $this->cache->compareSetTTL($this->slotKey, $this->owner, self::SLOT_TTL_SECONDS)) {
				return true;
			}
			// The TTL elapsed and another request acquired this slot. Forget
			// the stale ownership and try to acquire any currently free slot.
			$this->slotKey = null;
		}

		$workClass = ImapWorkClass::normalize($workClass);
		$remainingWaitMilliseconds = max(0, $waitMilliseconds);
		do {
			if (ImapWorkClass::isForeground($workClass)) {
				$this->cache->set(
					$this->foregroundWaiterKey(),
					$this->owner,
					self::FOREGROUND_WAITER_TTL_SECONDS,
				);
			}

			foreach ($this->getCandidateSlots($workClass) as $slot) {
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

	/** @return int[] */
	private function getCandidateSlots(string $workClass): array {
		if ($workClass === ImapWorkClass::QUICK_MUTATION) {
			return array_reverse(range(0, max($this->limit - 1, 0)));
		}

		$ordinaryLimit = $this->getAvailableLimit(false);
		if (ImapWorkClass::isForeground($workClass)) {
			return array_reverse(range(0, max($ordinaryLimit - 1, 0)));
		}

		if (ImapWorkClass::isBackground($workClass)
			&& $ordinaryLimit > 1
			&& $this->cache->get($this->foregroundWaiterKey()) !== null) {
			return [0];
		}

		return range(0, max($ordinaryLimit - 1, 0));
	}

	private function foregroundWaiterKey(): string {
		return $this->identity . '_foreground_waiter';
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
