<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2016-2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-FileCopyrightText: 2014-2016 ownCloud, Inc.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Controller;

use Horde_Imap_Client;
use OCA\Mail\AppInfo\Application;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\IncompleteSyncException;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\Exception\MailboxNotCachedException;
use OCA\Mail\Exception\NotImplemented;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Http\TrapError;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\DelegationService;
use OCA\Mail\Service\Sync\SyncService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\OpenAPI;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUserManager;
use OCP\Security\RateLimiting\ILimiter;
use OCP\Security\RateLimiting\IRateLimitExceededException;

#[OpenAPI(scope: OpenAPI::SCOPE_IGNORE)]
class MailboxesController extends Controller {
	/**
	 * Per-mailbox cap on sync attempts, independent of how many browser
	 * tabs/devices/users are hitting it -- a mailbox sync lock is shared
	 * infrastructure, not a per-session resource, and several independent
	 * clients (a forgotten tab at the office, one at home, a phone) can
	 * otherwise hammer the very same lock without any of them being aware
	 * of the others. Sized generously enough for one well-behaved client's
	 * own exponential-backoff retries across a full lock lifetime, while
	 * still meaningfully capping many uncoordinated ones.
	 *
	 * Raised from 20 to 100: this budget is shared across every query
	 * bucket loaded for a mailbox (keyed by mailbox id only, not query --
	 * see the identifier below), and the frontend's watched-mailbox poller
	 * now ticks every ~10-15s per mailbox, not every 30-60s. Even a single
	 * loaded bucket alone means roughly 24 requests per SYNC_RATE_PERIOD
	 * (300s) just from steady, healthy polling -- above the old limit of
	 * 20 before accounting for a second bucket (e.g. "sort favorites
	 * separately"), manual actions, or the priority-inbox tail sync.
	 * Confirmed live: a single, healthy browser tab with no other client
	 * involved was hitting this limit routinely under completely normal
	 * operation, not just during genuine contention. 100 comfortably covers
	 * a few buckets at the fastest edge of the poller's jitter range plus
	 * headroom for everything else sharing the same budget, while still
	 * bounding a truly runaway client.
	 */
	private const SYNC_RATE_LIMIT = 200;
	private const SYNC_RATE_PERIOD = Mailbox::LOCK_TIMEOUT;

	/**
	 * The Retry-After sent to the client on 429 is deliberately much
	 * shorter than SYNC_RATE_PERIOD itself. Confirmed live: a client
	 * that hit the limit once (e.g. from a burst of several browser
	 * windows/tabs all reacting to the same event) and then honoured
	 * a Retry-After of the full period waited a genuinely felt ~5
	 * minutes before new mail appeared, even though the mailbox
	 * itself was free again almost immediately. A short retry hint
	 * costs at most a few more cheap, fast-rejected requests if the
	 * limit hasn't cleared yet -- far better than a single, long,
	 * user-visible stall.
	 */
	private const SYNC_RATE_LIMIT_RETRY_AFTER = 30;

	public function __construct(
		string $appName,
		IRequest $request,
		private AccountService $accountService,
		private ?string $userId,
		private IMailManager $mailManager,
		private SyncService $syncService,
		private readonly IConfig $config,
		private readonly ITimeFactory $timeFactory,
		private DelegationService $delegationService,
		private readonly ILimiter $limiter,
		private readonly IUserManager $userManager,
	) {
		parent::__construct($appName, $request);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $accountId
	 * @param bool $forceSync
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function index(int $accountId, bool $forceSync = false): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveAccountUserId($accountId, $this->userId);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		$account = $this->accountService->find($effectiveUserId, $accountId);

		$mailboxes = $this->mailManager->getMailboxes($account, $forceSync);
		return new JSONResponse([
			'id' => $accountId,
			'email' => $account->getEmail(),
			'mailboxes' => $mailboxes,
			'delimiter' => $mailboxes[0]?->getDelimiter(),
		]);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 * @param string $name
	 *
	 * @return JSONResponse
	 */
	#[TrapError]
	public function patch(int $id,
		?string $name = null,
		?bool $subscribed = null,
		?bool $syncInBackground = null): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveMailboxUserId($id, $this->userId);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		$mailbox = $this->mailManager->getMailbox($effectiveUserId, $id);
		$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());

		if ($name !== null) {
			$mailbox = $this->mailManager->renameMailbox(
				$account,
				$mailbox,
				$name
			);
			$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId changed mailbox: $id's name to $name on behalf of $effectiveUserId");
		}
		if ($subscribed !== null) {
			$mailbox = $this->mailManager->updateSubscription(
				$account,
				$mailbox,
				$subscribed
			);
			$subscribedVerb = $subscribed ? 'subscribed' : 'unsubscribed';
			$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId $subscribedVerb to mailbox: $id on behalf of $effectiveUserId");

		}
		if ($syncInBackground !== null) {
			$mailbox = $this->mailManager->enableMailboxBackgroundSync(
				$mailbox,
				$syncInBackground
			);
			$syncVerb = $syncInBackground ? 'enabled' : 'disabled';
			$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId $syncVerb background sync for mailbox: $id on behalf of $effectiveUserId");
		}
		return new JSONResponse($mailbox);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 * @param int[] $ids
	 *
	 * @param bool $init
	 * @param string|null $query
	 *
	 * @return JSONResponse
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function sync(int $id, array $ids = [], ?int $lastMessageTimestamp = null, bool $init = false, string $sortOrder = 'newest', ?string $query = null): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveMailboxUserId($id, $this->userId);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		$mailbox = $this->mailManager->getMailbox($effectiveUserId, $id);
		$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		$order = $sortOrder === 'newest' ? IMailSearch::ORDER_NEWEST_FIRST: IMailSearch::ORDER_OLDEST_FIRST;

		$user = $this->userManager->get($effectiveUserId);
		// A request the freshness gate will serve straight from the
		// database touches no IMAP and costs near nothing -- charging it
		// against the sync rate limit made the limit trip on request
		// VOLUME (windows x query buckets) even though almost none of
		// those requests did real work. Only requests that may actually
		// sync count. (Racy by design: the marker can expire between this
		// check and the sync -- an occasional uncounted real sync is
		// harmless.)
		// Also skip charging when the mailbox is already locked by another
		// in-flight sync: this request will be served from the database
		// (see SyncService), so it does no IMAP work either. Without this,
		// every member of the thundering herd that piles onto a
		// freshness-window expiry got charged although only the winner
		// actually syncs.
		$chargeRateLimit = $user !== null
			&& ($init || (!$this->syncService->isMailboxFresh($mailbox)
				&& !$mailbox->hasLocks($this->timeFactory->getTime())));
		if ($chargeRateLimit) {
			try {
				$this->limiter->registerUserRequest(
					'mail-sync-mailbox-' . $id,
					self::SYNC_RATE_LIMIT,
					self::SYNC_RATE_PERIOD,
					$user,
				);
			} catch (IRateLimitExceededException $e) {
				// Same "type" as MailboxLockedException so the frontend's
				// existing wait-and-retry handling applies unchanged; 429
				// (not 409) because this is "you're asking too often", not
				// "the mailbox happens to be locked right now".
				$response = \OCA\Mail\Http\JsonResponse::fail(
					[
						'message' => "Too many sync attempts for mailbox $id, please slow down",
						'type' => MailboxLockedException::class,
					],
					Http::STATUS_TOO_MANY_REQUESTS,
				);
				$response->addHeader('Retry-After', (string)self::SYNC_RATE_LIMIT_RETRY_AFTER);
				return $response;
			}
		}

		$this->config->setUserValue(
			$this->userId,
			Application::APP_ID,
			'ui-heartbeat',
			(string)$this->timeFactory->getTime(),
		);

		try {
			$syncResponse = $this->syncService->syncMailbox(
				$account,
				$mailbox,
				Horde_Imap_Client::SYNC_NEWMSGSUIDS | Horde_Imap_Client::SYNC_FLAGSUIDS | Horde_Imap_Client::SYNC_VANISHEDUIDS,
				!$init,
				$lastMessageTimestamp,
				array_map(static fn ($id) => (int)$id, $ids),
				$order,
				$query
			);
		} catch (MailboxNotCachedException $e) {
			return new JSONResponse([], Http::STATUS_PRECONDITION_REQUIRED);
		} catch (IncompleteSyncException $e) {
			return \OCA\Mail\Http\JsonResponse::fail([], Http::STATUS_ACCEPTED);
		} catch (MailboxLockedException $e) {
			// Re-fetch: the lock that caused this was acquired by someone
			// else after $mailbox was loaded above, so its in-memory lock
			// fields are stale.
			$freshMailbox = $this->mailManager->getMailbox($effectiveUserId, $id);
			$response = \OCA\Mail\Http\JsonResponse::failWith($e);
			$response->addHeader('Retry-After', (string)$this->computeRetryAfterSeconds($freshMailbox));
			return $response;
		}

		// Rides the response every watched-mailbox poll tick already makes
		// -- no extra request -- so the frontend's background poller can
		// widen its own tick period when the mail pool is busy (see
		// SyncService::isServerBusy()). Deliberately not applied to
		// user-initiated syncs (a manual refresh, opening a folder): only
		// the automatic background poller reads this field.
		$payload = $syncResponse->jsonSerialize();
		$payload['serverBusy'] = $this->syncService->isServerBusy();
		return new JSONResponse($payload);
	}

	/**
	 * How long a client should wait before trying this mailbox's sync
	 * again, based on when its active lock(s) will actually expire --
	 * rather than a guessed, fixed delay.
	 */
	private function computeRetryAfterSeconds(Mailbox $mailbox): int {
		$now = $this->timeFactory->getTime();
		$locks = [
			$mailbox->getSyncNewLock(),
			$mailbox->getSyncChangedLock(),
			$mailbox->getSyncVanishedLock(),
		];
		$remaining = array_map(
			static fn (?int $lock): int => $lock === null ? 0 : $lock + Mailbox::LOCK_TIMEOUT - $now,
			$locks,
		);
		return min(Mailbox::LOCK_TIMEOUT, max(5, ...$remaining));
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @return JSONResponse
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function clearCache(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveMailboxUserId($id, $this->userId);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		$mailbox = $this->mailManager->getMailbox($effectiveUserId, $id);
		$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());

		$this->syncService->clearCache($account, $mailbox);
		return new JSONResponse([]);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 */
	#[TrapError]
	public function markAllAsRead(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveMailboxUserId($id, $this->userId);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		$mailbox = $this->mailManager->getMailbox($effectiveUserId, $id);
		$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());

		$this->mailManager->markFolderAsRead($account, $mailbox);

		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId marked all messages as read in mailbox: $id on behalf of $effectiveUserId");

		return new JSONResponse([]);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function stats(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveMailboxUserId($id, $this->userId);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		$mailbox = $this->mailManager->getMailbox($effectiveUserId, $id);
		return new JSONResponse($mailbox->getStats());
	}

	/**
	 * @NoAdminRequired
	 *
	 *
	 * @return never
	 */
	#[TrapError]
	public function show() {
		throw new NotImplemented();
	}

	/**
	 * @NoAdminRequired
	 *
	 *
	 * @return never
	 */
	#[TrapError]
	public function update() {
		throw new NotImplemented();
	}

	/**
	 * @NoAdminRequired
	 *
	 *
	 * @return JSONResponse
	 * @throws ServiceException
	 * @throws ClientException
	 */
	#[TrapError]
	public function create(int $accountId, string $name): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveAccountUserId($accountId, $this->userId);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		$account = $this->accountService->find($effectiveUserId, $accountId);
		$mailbox = $this->mailManager->createMailbox($account, $name);
		$id = $mailbox->getId();
		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId created mailbox: $id on behalf of $effectiveUserId");

		return new JSONResponse($mailbox);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @return JSONResponse
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function destroy(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveMailboxUserId($id, $this->userId);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		$mailbox = $this->mailManager->getMailbox($effectiveUserId, $id);
		$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());

		$this->mailManager->deleteMailbox($account, $mailbox);
		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId deleted mailbox: $id on behalf of $effectiveUserId");

		return new JSONResponse();
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @return JSONResponse
	 * @throws ClientException
	 * @throws ServiceException
	 * @throws \OCP\AppFramework\Db\DoesNotExistException
	 */
	#[TrapError]
	public function clearMailbox(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveMailboxUserId($id, $this->userId);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		$mailbox = $this->mailManager->getMailbox($effectiveUserId, $id);
		$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());

		$this->mailManager->clearMailbox($account, $mailbox);
		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId cleared mailbox: $id on behalf of $effectiveUserId");
		return new JSONResponse();
	}

	/**
	 * Delete all vanished mails that are still cached.
	 */
	#[TrapError]
	#[NoAdminRequired]
	#[UserRateLimit(limit: 10, period: 600)]
	public function repair(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveMailboxUserId($id, $this->userId);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		$mailbox = $this->mailManager->getMailbox($effectiveUserId, $id);
		$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());

		$this->syncService->repairSync($account, $mailbox);
		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId repaired mailbox: $id on behalf of $effectiveUserId");

		return new JsonResponse();
	}
}
