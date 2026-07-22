<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\IMAP;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\IMAP\ImapConnectionSemaphore;
use OCP\IMemcache;
use OCP\IMemcacheTTL;

class SemaphoreCache implements IMemcache {
	/** @var array<string, mixed> */
	protected array $values = [];
	/** @var array<string, int> */
	protected array $ttls = [];

	public function get($key) {
		return $this->values[$key] ?? null;
	}

	public function set($key, $value, $ttl = 0) {
		$this->values[$key] = $value;
		$this->ttls[$key] = $ttl;
		return true;
	}

	public function remove($key) {
		unset($this->values[$key], $this->ttls[$key]);
		return true;
	}

	public function hasKey($key) {
		return array_key_exists($key, $this->values);
	}

	public function clear($prefix = '') {
		$this->values = [];
		$this->ttls = [];
		return true;
	}

	public static function isAvailable(): bool {
		return true;
	}

	public function add($key, $value, $ttl = 0) {
		if ($this->hasKey($key)) {
			return false;
		}
		return $this->set($key, $value, $ttl);
	}

	public function inc($key, $step = 1) {
		$value = ($this->values[$key] ?? 0) + $step;
		$this->values[$key] = $value;
		return $value;
	}

	public function dec($key, $step = 1) {
		return $this->inc($key, -$step);
	}

	public function cas($key, $old, $new) {
		if ($this->get($key) !== $old) {
			return false;
		}
		$this->values[$key] = $new;
		return true;
	}

	public function cad($key, $old) {
		if ($this->get($key) !== $old) {
			return false;
		}
		return $this->remove($key);
	}

	public function ncad(string $key, mixed $old): bool {
		if (!$this->hasKey($key) || $this->get($key) === $old) {
			return false;
		}
		return $this->remove($key);
	}

	public function ttlFor(string $key): ?int {
		return $this->ttls[$key] ?? null;
	}
}

class SemaphoreTtlCache extends SemaphoreCache implements IMemcacheTTL {
	public function setTTL(string $key, int $ttl) {
		if (!$this->hasKey($key)) {
			return false;
		}
		$this->ttls[$key] = $ttl;
		return true;
	}

	public function getTTL(string $key): int|false {
		return $this->ttls[$key] ?? false;
	}

	public function compareSetTTL(string $key, $value, int $ttl): bool {
		if ($this->get($key) !== $value) {
			return false;
		}
		$this->ttls[$key] = $ttl;
		return true;
	}
}

class ImapConnectionSemaphoreTest extends TestCase {
	public function testAllowsOnlyTheConfiguredNumberOfConnections(): void {
		$cache = new SemaphoreCache();
		$first = new ImapConnectionSemaphore($cache, 'account', 2);
		$second = new ImapConnectionSemaphore($cache, 'account', 2);
		$third = new ImapConnectionSemaphore($cache, 'account', 2);

		self::assertTrue($first->acquire());
		self::assertTrue($second->acquire());
		self::assertFalse($third->acquire());
		self::assertSame(300, $cache->ttlFor('account_slot_0'));
		self::assertSame(300, $cache->ttlFor('account_slot_1'));
	}

	public function testReleasedSlotCanBeAcquiredByAnotherConnection(): void {
		$cache = new SemaphoreCache();
		$first = new ImapConnectionSemaphore($cache, 'account', 1);
		$second = new ImapConnectionSemaphore($cache, 'account', 1);
		$first->acquire();

		$first->release();

		self::assertTrue($second->acquire());
	}

	public function testStaleReleaseCannotDeleteAReownedSlot(): void {
		$cache = new SemaphoreCache();
		$stale = new ImapConnectionSemaphore($cache, 'account', 1);
		$stale->acquire();
		$cache->set('account_slot_0', 'new-owner', 300);

		$stale->release();

		self::assertSame('new-owner', $cache->get('account_slot_0'));
	}

	public function testAcquireIsIdempotentForTheSameConnection(): void {
		$cache = new SemaphoreCache();
		$first = new ImapConnectionSemaphore($cache, 'account', 2);
		$second = new ImapConnectionSemaphore($cache, 'account', 2);

		self::assertTrue($first->acquire());
		self::assertTrue($first->acquire());

		self::assertTrue($second->acquire());
	}

	public function testReacquireRefreshesTheOwnedSlotTtl(): void {
		$cache = new SemaphoreTtlCache();
		$semaphore = new ImapConnectionSemaphore($cache, 'account', 1);
		$semaphore->acquire();
		$cache->setTTL('account_slot_0', 1);

		self::assertTrue($semaphore->acquire());

		self::assertSame(300, $cache->getTTL('account_slot_0'));
	}
}
