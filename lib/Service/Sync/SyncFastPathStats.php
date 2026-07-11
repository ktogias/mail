<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Sync;

use Horde_Imap_Client;
use OCP\ICache;
use OCP\ICacheFactory;
use OCP\IMemcache;

/**
 * Tracks how often ImapToDbSynchronizer::pruneSyncCriteria()'s STATUS round
 * trip actually proves a phase idle, per phase -- so the real hit rate on a
 * given install can be read directly (`occ mail:sync:fastpath-stats`)
 * instead of estimated from spot-checked debug logs.
 */
class SyncFastPathStats {
	private const CACHE_PREFIX = 'mail_syncfastpath';

	private const PHASES = [
		'new' => Horde_Imap_Client::SYNC_NEWMSGSUIDS,
		'flags' => Horde_Imap_Client::SYNC_FLAGSUIDS,
		'vanished' => Horde_Imap_Client::SYNC_VANISHEDUIDS,
	];

	private ICache $cache;

	public function __construct(ICacheFactory $cacheFactory) {
		$this->cache = $cacheFactory->createLocal(self::CACHE_PREFIX);
	}

	/**
	 * The STATUS round trip itself failed, or came back without enough
	 * usable data (missing UIDVALIDITY/UIDNEXT/message count) -- every
	 * phase under consideration was kept by default, none could actually be
	 * evaluated against a server value.
	 */
	public function recordStatusUnusable(): void {
		$this->increment('status_unusable');
	}

	/**
	 * @param int $criteriaBefore the phases under consideration when
	 *                            pruneSyncCriteria() started
	 * @param int $criteriaAfter the phases actually kept after STATUS-based
	 *                           pruning
	 */
	public function recordOutcome(int $criteriaBefore, int $criteriaAfter): void {
		foreach (self::PHASES as $name => $bit) {
			if (($criteriaBefore & $bit) === 0) {
				// This phase wasn't being considered at all (e.g. a
				// silent/knownUids-provided sync only asking for a subset
				// of phases) -- nothing to record.
				continue;
			}
			$this->increment("{$name}_attempted");
			if (($criteriaAfter & $bit) === 0) {
				$this->increment("{$name}_pruned");
			}
		}
	}

	/**
	 * @return array<string, array{attempted: int, pruned: int, hit_rate: float|null}|int>
	 */
	public function getStats(): array {
		$stats = [];
		foreach (self::PHASES as $name => $bit) {
			$attempted = $this->getCount("{$name}_attempted");
			$pruned = $this->getCount("{$name}_pruned");
			$stats[$name] = [
				'attempted' => $attempted,
				'pruned' => $pruned,
				'hit_rate' => $attempted > 0 ? round(($pruned / $attempted) * 100, 1) : null,
			];
		}
		$stats['status_unusable'] = $this->getCount('status_unusable');
		return $stats;
	}

	public function reset(): void {
		$this->cache->clear();
	}

	private function increment(string $key): void {
		if ($this->cache instanceof IMemcache) {
			$this->cache->inc($key);
			return;
		}
		// Best-effort, non-atomic fallback for cache backends without
		// inc() (e.g. an ArrayCache in tests, or APCu genuinely
		// unavailable) -- this is a diagnostic counter, not billing data.
		$this->cache->set($key, $this->getCount($key) + 1, 0);
	}

	private function getCount(string $key): int {
		return (int)($this->cache->get($key) ?? 0);
	}
}
