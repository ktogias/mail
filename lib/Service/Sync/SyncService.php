<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Sync;

use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\Exception\MailboxNotCachedException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\MailboxSync;
use OCA\Mail\IMAP\PreviewEnhancer;
use OCA\Mail\IMAP\Sync\Response;
use OCA\Mail\Service\Search\FilterStringParser;
use OCA\Mail\Service\Search\SearchQuery;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\ICacheFactory;
use OCP\IMemcache;
use Psr\Log\LoggerInterface;
use function array_diff;
use function array_map;

class SyncService {
	/**
	 * How long (seconds) a completed IMAP sync of a mailbox exempts every
	 * other caller from doing their own. Several callers poll the same
	 * mailbox on close cadences -- every open browser window, each of its
	 * loaded query buckets, cron -- and each HTTP request otherwise opens
	 * its own IMAP connection (login + SELECT alone measure ~3s against
	 * Gmail on a 26.9k-message INBOX) to re-ask a question answered moments
	 * ago. Chosen just below the frontend's 20-30s poll tick (raised from
	 * 8/10-15s: a second independently-jittered poller -- e.g. a second
	 * browser window, or a phone alongside a desktop -- only rides this
	 * window when its tick happens to land inside it, so a narrow window
	 * relative to the tick period meant extra simultaneous pollers still
	 * roughly doubled the real, non-gated sync rate; confirmed live on a
	 * resource-constrained host): a single window still gets a real sync on
	 * every one of its own ticks; only the redundant followers inside the
	 * window ride the marker.
	 */
	private const SYNC_FRESHNESS_WINDOW = 18;

	/**
	 * Global (not per-mailbox) count of real syncs currently in flight
	 * across EVERY watched mailbox, from every open window/device. The
	 * per-mailbox mutex above already stops one mailbox's redundant
	 * simultaneous syncers; this catches the different failure mode where
	 * MANY DIFFERENT mailboxes are all syncing for real at once -- e.g. a
	 * second device just started polling the same watched set -- and
	 * together exceed what the mail FPM pool can comfortably serve.
	 * Confirmed live: opening a second device roughly doubled the real
	 * (non-gated) sync rate for the same watched mailboxes and pushed a
	 * resource-constrained host to PostgreSQL at 177% CPU, the app
	 * container at 117%, and sustained swap use. Read by isServerBusy() and
	 * surfaced to the frontend so its background poller (not user-initiated
	 * syncs) can widen its own tick period under load -- see
	 * MailboxesController::sync().
	 */
	private const LOAD_COUNTER_KEY = 'real_syncs_in_flight';

	/**
	 * Must outlive the slowest realistic real sync (the mail pool's own
	 * request_terminate_timeout, 75s) so the counter doesn't expire
	 * mid-sync under normal conditions. If a worker IS killed mid-sync, the
	 * counter simply stays inflated by one until this TTL lapses -- a
	 * bounded, self-healing, safe-direction failure (briefly over-reporting
	 * busy), never a stuck negative count or unbounded growth.
	 */
	private const LOAD_COUNTER_TTL = 120;

	/**
	 * Half of mail-pool.conf's pm.max_children (4), on purpose: other
	 * request types (message list/body/flags) also occupy pool workers
	 * without going through this counter, so treating "half the pool doing
	 * real IMAP syncs at once" as busy leaves headroom instead of waiting
	 * for outright saturation.
	 */
	private const LOAD_BUSY_THRESHOLD = 2;

	/**
	 * A client with truly empty knownIds -- a fresh browser session, or a
	 * mailbox/query bucket never fetched before -- has no known state to
	 * diff against, so there is no "what changed" to compute. Returning
	 * every message the mailbox has ever received (upstream's original
	 * answer to this, unbounded, since commit 9498ebac6 in 2020) is fine
	 * for a small personal mailbox, but on anything with hundreds+ of
	 * messages it turns a lightweight sync into a full-table dump the
	 * client then has to reactively process in one go -- measured live: a
	 * 592-message Sent folder alone produced enough main-thread work to
	 * trigger the browser's own "page is slowing down" warning on a fresh
	 * session, and the same mechanism against a 26.9k-message Gmail INBOX
	 * would be far worse. Capped to a modest multiple of a single list
	 * page so a cold-start sync seeds the client with something to show,
	 * not its entire history -- self-healing on the next tick once the
	 * client has real known ids to diff against instead.
	 */
	private const COLD_START_SYNC_LIMIT = 50;

	public function __construct(
		private IMAPClientFactory $clientFactory,
		private ImapToDbSynchronizer $synchronizer,
		private FilterStringParser $filterStringParser,
		private MessageMapper $messageMapper,
		private PreviewEnhancer $previewEnhancer,
		private LoggerInterface $logger,
		private MailboxSync $mailboxSync,
		private ICacheFactory $cacheFactory,
		private ITimeFactory $timeFactory,
	) {
	}

	/**
	 * @param Account $account
	 * @param Mailbox $mailbox
	 *
	 * @throws MailboxLockedException
	 * @throws ServiceException
	 */
	public function clearCache(Account $account,
		Mailbox $mailbox): void {
		$this->synchronizer->clearCache($account, $mailbox);
	}

	/**
	 * Run a (rather costly) sync to delete cached messages which are not present on IMAP anymore.
	 *
	 * @throws MailboxLockedException
	 * @throws ServiceException
	 */
	public function repairSync(Account $account, Mailbox $mailbox): void {
		$this->synchronizer->repairSync($account, $mailbox, $this->logger);
	}

	/**
	 * @param Account $account
	 * @param Mailbox $mailbox
	 * @param int $criteria
	 * @param bool $partialOnly
	 * @param string|null $filter
	 *
	 * @param int[] $knownIds
	 *
	 * @return Response
	 * @throws ClientException
	 * @throws MailboxNotCachedException
	 * @throws ServiceException
	 */
	public function syncMailbox(Account $account,
		Mailbox $mailbox,
		int $criteria,
		bool $partialOnly,
		?int $lastMessageTimestamp,
		?array $knownIds = null,
		string $sortOrder = IMailSearch::ORDER_NEWEST_FIRST,
		?string $filter = null): Response {
		if ($partialOnly && !$mailbox->isCached()) {
			throw MailboxNotCachedException::from($mailbox);
		}

		$query = $filter === null ? null : $this->filterStringParser->parse($filter);

		// Freshness gate: if ANY caller completed a real sync of this
		// mailbox within the last few seconds (see SYNC_FRESHNESS_WINDOW),
		// serve the database diff without opening an IMAP connection at
		// all. Initial syncs ($partialOnly === false) always run for real,
		// and without a distributed cache the marker is never found, so
		// behavior degrades to exactly what it was before.
		$freshnessCache = $this->cacheFactory->createDistributed('mail_sync_freshness');
		$freshnessKey = (string)$mailbox->getId();
		if ($partialOnly) {
			$freshUntil = $freshnessCache->get($freshnessKey);
			if ($freshUntil !== null && (int)$freshUntil >= $this->timeFactory->getTime()) {
				$this->logger->debug("Mailbox {$mailbox->getId()} was synced moments ago by another caller, serving cached state without IMAP");
				return $this->getDatabaseSyncChanges(
					$account,
					$mailbox,
					$knownIds ?? [],
					$lastMessageTimestamp,
					$sortOrder,
					$query
				);
			}
		}

		// One real sync per mailbox at a time, across every window and
		// bucket: the per-phase mailbox locks allow two callers whose
		// pruned criteria differ to run heavy phases CONCURRENTLY, and on
		// a large mailbox those parallel sessions throttle each other at
		// the provider (measured live: single syncs of ~25s degraded to
		// 72s each with three in flight, occupying half the mail pool).
		// The loser of this mutex serves the database diff immediately --
		// the winner's results land there as it progresses.
		$syncMutexKey = 'syncing_' . $mailbox->getId();
		$syncMutexAcquired = false;
		if ($partialOnly && $freshnessCache instanceof IMemcache) {
			$syncMutexAcquired = $freshnessCache->add($syncMutexKey, 1, 180);
		} elseif ($partialOnly) {
			// No distributed memcache with add(): no mutex, previous behavior.
			$syncMutexAcquired = true;
		}
		if ($partialOnly && !$syncMutexAcquired) {
			$this->logger->debug("Mailbox {$mailbox->getId()} already has a real sync in flight, serving current database state");
			return $this->getDatabaseSyncChanges(
				$account,
				$mailbox,
				$knownIds ?? [],
				$lastMessageTimestamp,
				$sortOrder,
				$query
			);
		}

		// By construction we only reach here when a real sync WILL run
		// (either an initial sync, which always runs for real, or a partial
		// sync that just won the per-mailbox mutex above) -- so this is the
		// right place to count it against the global load signal,
		// unconditionally.
		$countingLoad = false;
		if ($freshnessCache instanceof IMemcache) {
			$freshnessCache->add(self::LOAD_COUNTER_KEY, 0, self::LOAD_COUNTER_TTL);
			$freshnessCache->inc(self::LOAD_COUNTER_KEY);
			$countingLoad = true;
		}

		$client = $this->clientFactory->getClient($account);

		try {
			$this->synchronizer->sync(
				$account,
				$client,
				$mailbox,
				$this->logger,
				$criteria,
				$knownIds === null ? null : $this->messageMapper->findUidsForIds($mailbox, $knownIds),
				!$partialOnly
			);

			$this->mailboxSync->syncStats($client, $mailbox);

			// Only a completed sync (including fresh stats for the badge)
			// may arm the gate for followers.
			$freshnessCache->set(
				$freshnessKey,
				$this->timeFactory->getTime() + self::SYNC_FRESHNESS_WINDOW,
				self::SYNC_FRESHNESS_WINDOW * 4,
			);
		} catch (MailboxLockedException $e) {
			if (!$partialOnly) {
				throw $e;
			}
			// Another caller holds the sync lock RIGHT NOW -- its results
			// are landing in the database as it progresses. Serving the
			// current database diff gives this client everything known so
			// far at zero cost, instead of a 409 whose Retry-After sends it
			// into a capped exponential backoff (measured live: an unlucky
			// collision at the freshness-window boundary put a focused
			// window 90+ seconds behind a badge that had already updated).
			$this->logger->debug("Mailbox {$mailbox->getId()} is locked by another syncer, serving current database state instead of a retry hint");
		} finally {
			if ($countingLoad) {
				$freshnessCache->dec(self::LOAD_COUNTER_KEY);
			}
			if ($syncMutexAcquired && $freshnessCache instanceof IMemcache) {
				$freshnessCache->remove($syncMutexKey);
			}
			$client->logout();
		}

		return $this->getDatabaseSyncChanges(
			$account,
			$mailbox,
			$knownIds ?? [],
			$lastMessageTimestamp,
			$sortOrder,
			$query
		);
	}

	/**
	 * Whether the freshness gate would serve this mailbox from the
	 * database right now (no IMAP touched). Used by the controller to
	 * avoid charging such requests against the sync rate limit: the
	 * limiter exists to protect the mailbox/IMAP from being hammered,
	 * and a gated response costs neither.
	 */
	public function isMailboxFresh(Mailbox $mailbox): bool {
		$freshUntil = $this->cacheFactory->createDistributed('mail_sync_freshness')
			->get((string)$mailbox->getId());
		return $freshUntil !== null && (int)$freshUntil >= $this->timeFactory->getTime();
	}

	/**
	 * Whether the mail FPM pool currently has enough real syncs in flight
	 * (across every mailbox and every caller) to be considered busy -- see
	 * LOAD_COUNTER_KEY. Surfaced to the frontend on every sync response so
	 * its background poller can widen its own tick period; without a
	 * distributed memcache there is no signal, so this always reports
	 * "not busy" rather than guessing.
	 */
	public function isServerBusy(): bool {
		$cache = $this->cacheFactory->createDistributed('mail_sync_freshness');
		if (!($cache instanceof IMemcache)) {
			return false;
		}
		$count = $cache->get(self::LOAD_COUNTER_KEY);
		return $count !== null && (int)$count >= self::LOAD_BUSY_THRESHOLD;
	}

	/**
	 * @param Account $account
	 * @param Mailbox $mailbox
	 * @param int[] $knownIds
	 * @param SearchQuery $query
	 *
	 * @return Response
	 * @todo does not work with text token search queries
	 *
	 */
	private function getDatabaseSyncChanges(Account $account,
		Mailbox $mailbox,
		array $knownIds,
		?int $lastMessageTimestamp,
		string $sortOrder,
		?SearchQuery $query): Response {
		if ($knownIds === []) {
			$newIds = $this->messageMapper->findAllIds($mailbox, $sortOrder, self::COLD_START_SYNC_LIMIT);
		} else {
			$newIds = $this->messageMapper->findNewIds($mailbox, $knownIds, $lastMessageTimestamp, $sortOrder);
		}
		$order = $sortOrder === 'oldest' ? IMailSearch::ORDER_OLDEST_FIRST : IMailSearch::ORDER_NEWEST_FIRST;
		if ($query !== null) {
			// Filter new messages to those that also match the current filter
			$newUids = $this->messageMapper->findUidsForIds($mailbox, $newIds);
			$newIds = $this->messageMapper->findIdsByQuery($mailbox, $query, $order, null, $newUids);
		}
		$new = $this->messageMapper->findByMailboxAndIds($mailbox, $account->getUserId(), $newIds);

		// TODO: $changed = $this->messageMapper->findChanged($account, $mailbox, $uids);
		if ($query !== null) {
			$changedUids = $this->messageMapper->findUidsForIds($mailbox, $knownIds);
			$changedIds = $this->messageMapper->findIdsByQuery($mailbox, $query, $order, null, $changedUids);
		} else {
			$changedIds = $knownIds;
		}
		$changed = $this->messageMapper->findByMailboxAndIds($mailbox, $account->getUserId(), $changedIds);

		$stillKnownIds = array_map(static fn (Message $msg) => $msg->getId(), $changed);
		$vanished = array_values(array_diff($knownIds, $stillKnownIds));

		return new Response(
			// liveEnhance=false: a sync response must not block on live IMAP
			// preview/structure enhancement. A caller with a stale bucket can
			// legitimately receive hundreds of "new" messages in one diff --
			// live-enhancing them ran for minutes, tied up a mail-pool worker
			// past every timeout (measured: a steady stream of 504s, all on
			// the big Gmail INBOX), and since the client never got the
			// response, it re-requested the same huge diff every tick,
			// forever. Same treatment the message-LIST path already has.
			$this->previewEnhancer->process($account, $mailbox, $new, false, null, false),
			$changed,
			$vanished,
			$mailbox->getStats()
		);
	}
}
