<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2023 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP;

use Horde_Imap_Client_Exception;
use Horde_Imap_Client_Exception_NoSupportExtension;
use Horde_Imap_Client_Password_Xoauth2;
use Horde_Imap_Client_Socket;
use OCA\Mail\Account;
use OCA\Mail\Db\MailAccountMapper;
use OCA\Mail\Integration\GoogleIntegration;
use OCA\Mail\Integration\MicrosoftIntegration;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IMemcache;
use OCP\Security\ICrypto;
use Psr\Log\LoggerInterface;
use Throwable;
use function min;
use function random_int;

/**
 * "Decorator" around Horde's IMAP client to add auth error rate limiting.
 *
 * This is not a real decorator because the component to decorate doesn't have
 * an interface, making it hard to base a decorator on composition.
 * For simplicity the component is decorated by inheritance.
 */
class HordeImapClient extends Horde_Imap_Client_Socket {
	private ?IMemcache $rateLimiterCache = null;
	private ?ITimeFactory $timeFactory = null;
	private ?string $hash = null;
	private ?Account $account = null;
	private ?GoogleIntegration $googleIntegration = null;
	private ?MicrosoftIntegration $microsoftIntegration = null;
	private ?MailAccountMapper $mailAccountMapper = null;
	private ?ICrypto $crypto = null;
	private ?LoggerInterface $logger = null;
	private ?ImapConnectionSemaphore $connectionSemaphore = null;
	private bool $allowReservedConnectionSlot = false;

	public function __construct(
		array $params,
		private IMAPClientFactory $factory,
	) {
		parent::__construct($params);
	}

	public function enableRateLimiter(
		IMemcache $cache,
		string $hash,
		ITimeFactory $timeFactory,
	): void {
		$this->rateLimiterCache = $cache;
		$this->timeFactory = $timeFactory;
		$this->hash = $hash;
	}

	/**
	 * Wires in what's needed to force a real OAuth token refresh and
	 * retry a denied login once, transparently, inside _login() itself --
	 * see _login()'s own comment for why this lives here rather than in
	 * each individual caller. A client this was never called for (e.g. a
	 * plain, non-xoauth2 account, or any client predating this feature)
	 * simply never retries, falling straight through to the existing
	 * rate-limiter failure handling below, unchanged.
	 */
	public function enableAuthRetry(
		Account $account,
		GoogleIntegration $googleIntegration,
		MicrosoftIntegration $microsoftIntegration,
		MailAccountMapper $mailAccountMapper,
		ICrypto $crypto,
	): void {
		$this->account = $account;
		$this->googleIntegration = $googleIntegration;
		$this->microsoftIntegration = $microsoftIntegration;
		$this->mailAccountMapper = $mailAccountMapper;
		$this->crypto = $crypto;
	}

	public function enableAuthTelemetry(LoggerInterface $logger): void {
		$this->logger = $logger;
	}

	public function enableConnectionSemaphore(ImapConnectionSemaphore $semaphore, bool $allowReservedSlot = false): void {
		$this->connectionSemaphore = $semaphore;
		$this->allowReservedConnectionSlot = $allowReservedSlot;
	}

	#[\Override]
	public function logout() {
		try {
			parent::logout();
		} finally {
			$this->connectionSemaphore?->release();
		}
	}

	public function __destruct() {
		$this->connectionSemaphore?->release();
	}

	#[\Override]
	public function login() {
		// Horde calls this before every operation, even on an already
		// authenticated object. Besides enforcing the initial limit, this
		// refreshes the owned slot's TTL during a long-lived request.
		if ($this->_isAuthenticated) {
			$this->acquireConnectionSlot();
		}

		// Horde calls login() at the start of EVERY operation; it is
		// idempotent and returns immediately when the session is already
		// authenticated. Sending ID unconditionally after it therefore
		// added one extra ID round trip to the server before every
		// single command batch -- measured against Gmail via the
		// account-level IMAP debug log: 56 ID NIL commands in a
		// 3-minute window with only ONE real AUTHENTICATE, ~10.7s of
		// 29.9s total IMAP time, i.e. a third of all IMAP wall time
		// spent re-introducing ourselves to a server that already knew
		// us. Only a genuinely fresh login needs the ID (the whole
		// point is mail services that require a client id at session
		// setup) -- mirroring the same guard Horde's own login() uses
		// for its `id` parameter.
		//
		// Upstream landed the same optimization independently (see
		// 64bf79962, "perf: reduce multiple ID IMAP commands by Horde
		// client") while this fork already had it; kept this version on
		// merge since it's functionally identical and predates/documents
		// the measured rationale in more detail.
		$wasAuthenticated = $this->_isAuthenticated;

		parent::login();

		if ($wasAuthenticated) {
			return;
		}

		if ($this->capability->query('ID')) {
			try {
				$this->sendID();
				/* ID is queued - force sending the queued command. */
				$this->_sendCmd($this->_pipeline());
			} catch (Horde_Imap_Client_Exception_NoSupportExtension) {
				// Ignore if server doesn't support ID extension.
			}
		}
	}

	// How long a consecutive-failure streak is remembered if nobody ever
	// retries to either resolve or extend it -- just cache cleanup, not
	// a meaningful part of the backoff logic (which is driven by
	// BLOCKED_UNTIL's own, much shorter TTL below).
	private const FAILURE_STREAK_TTL = 2 * 60 * 60;

	// This started as upstream's flat "3 failures within a fixed 3-hour
	// window -> block for the rest of it" (git blame: "Rate-limit IMAP
	// auth if the password is wrong", 2023) -- a reasonable policy for a
	// genuinely, permanently wrong static password, which never
	// self-heals on its own no matter how long you wait. Applied
	// uniformly to xoauth2 accounts too, though, it conflates that case
	// with a completely different failure shape: an OAuth login denial
	// is usually transient (a token mid-refresh, exactly the race
	// forceRefreshTokenAndUpdateClient() below exists to catch) and
	// only rarely sustained (e.g. a temporary provider-side
	// block) -- and unlike a wrong static password, DOES recover on its
	// own once whatever's actually wrong clears up. A flat "block for up
	// to 3 hours regardless" both waited far longer than necessary for a
	// one-off blip AND kept the door open for genuinely broken repeated
	// attempts to blindly hammer away for a while before the block even
	// engaged. Confirmed live: account 13 hit the flat block twice on
	// 2026-07-14 (see nextcloud-mail-oauth-integration.md), the second
	// time within 7 seconds of the first real denial in a fresh window.
	//
	// Capped exponential backoff with full jitter, reset the moment ANY
	// login actually succeeds -- the "half-open -> closed" half of a
	// circuit breaker. Each CONSECUTIVE failure grows the wait before
	// the next real attempt is allowed, so a lone transient blip costs
	// nothing and a short streak costs only seconds, while a genuinely
	// sustained problem backs off increasingly (protecting the mail
	// server from being hammered, and reducing the chance of a
	// persistent-failure retry loop provoking an even longer block from
	// the provider's own side) -- but a single success at any point
	// clears the whole streak immediately, instead of making an already
	// -recovered account wait out a fixed clock that has no way to know
	// the underlying problem is already gone.
	private const BACKOFF_BASE_SECONDS = 30;
	private const BACKOFF_CAP_SECONDS = 30 * 60;

	protected function imapLogin() {
		$result = parent::_login();
		$this->factory->recordLogin($this->_params['hostspec']);
		return $result;
	}

	/**
	 * The upper bound of the full-jitter window for the Nth CONSECUTIVE
	 * auth failure -- split out from computeBackoffSeconds() below
	 * purely so the (deterministic) growth curve itself is directly
	 * unit-testable without needing to mock random_int(). See the
	 * constants and _login()'s own comment above for the reasoning.
	 */
	public static function computeBackoffBoundSeconds(int $consecutiveFailures): int {
		if ($consecutiveFailures <= 1) {
			// A lone failure shouldn't cost anything -- almost always
			// the near-expiry timing race the forced-refresh retry
			// exists to recover from, not evidence of a real problem
			// yet.
			return 0;
		}
		return min(
			self::BACKOFF_CAP_SECONDS,
			self::BACKOFF_BASE_SECONDS * (2 ** ($consecutiveFailures - 2)),
		);
	}

	/**
	 * Full-jitter exponential backoff for the Nth CONSECUTIVE auth
	 * failure: a uniformly random delay somewhere within
	 * [0, computeBackoffBoundSeconds($consecutiveFailures)]. Same
	 * full-jitter shape as computeLockRetryDelayMs() on the JS side, for
	 * the same reason: spreads out retries from several concurrent
	 * callers (the background poller, more than one open tab, cron)
	 * instead of having them all come back at exactly the same instant.
	 */
	public static function computeBackoffSeconds(int $consecutiveFailures): int {
		$bound = self::computeBackoffBoundSeconds($consecutiveFailures);
		if ($bound === 0) {
			return 0;
		}
		return random_int(0, $bound);
	}

	#[\Override]
	protected function _login() {
		return $this->attemptLoginWithRateLimiting(true);
	}

	/**
	 * @param bool $allowAuthRetry whether a denied login may still force
	 *                             a token refresh and retry once -- true for the very first
	 *                             attempt, false for the recursive retry call itself, so a
	 *                             rejection that survives the retry can only ever cost ONE
	 *                             rate-limiter failure, not two.
	 */
	private function attemptLoginWithRateLimiting(bool $allowAuthRetry) {
		if ($this->rateLimiterCache === null) {
			return $this->imapLoginWithConnectionSlot();
		}

		$failureCountKey = $this->hash . '_failures';
		$blockedUntilKey = $this->hash . '_blocked_until';

		$blockedUntil = $this->rateLimiterCache->get($blockedUntilKey);
		if ($blockedUntil !== null && $this->timeFactory->getTime() < (int)$blockedUntil) {
			// Still backing off from a recent consecutive-failure
			// streak. Let's fail without involving IMAP.
			throw new Horde_Imap_Client_Exception(
				'Too many auth attempts',
				Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED
			);
		}

		try {
			$result = $this->imapLoginWithConnectionSlot();
			// Success -- whatever caused any earlier failures has
			// cleared up. Clear the streak immediately rather than
			// leaving a now-healthy account to wait out whatever was
			// left of its own backoff.
			$this->rateLimiterCache->remove($failureCountKey);
			$this->rateLimiterCache->remove($blockedUntilKey);
			return $result;
		} catch (Horde_Imap_Client_Exception $e) {
			if (!$this->isRetryableAuthFailure($e)) {
				throw $e;
			}
			$this->logAuthRejection($e, $allowAuthRetry ? 'initial' : 'post_refresh');

			if ($allowAuthRetry && $this->forceRefreshTokenAndUpdateClient()) {
				// Confirmed live, repeatedly, across several different
				// IMAP call sites (routine background sync, but also a
				// plain message-flag/tag write -- see
				// nextcloud-mail-oauth-integration.md): a Google account
				// well within its stored token's declared validity
				// window still occasionally gets "Mail server denied
				// authentication". We already know right now that the
				// token we had was rejected; a forced refresh (bypassing
				// REFRESH_BUFFER_SECONDS entirely) just put a genuinely
				// new one in place on this same client, so retry exactly
				// once with it before treating this as a real failure.
				// Living here, in the one place every IMAP call
				// ultimately converges through, means every caller gets
				// this protection automatically -- not just whichever
				// call site happened to have its own retry wrapper
				// bolted on. A retry that succeeds is a plain success as
				// far as the rate limiter above is concerned (it re-enters
				// the same try block); a retry that also fails falls
				// through to the failure bookkeeping below exactly once,
				// not twice, since allowAuthRetry is false this time.
				$result = $this->attemptLoginWithRateLimiting(false);
				$this->logAuthRetryRecovered();
				return $result;
			}

			$failures = ((int)$this->rateLimiterCache->get($failureCountKey)) + 1;
			$this->rateLimiterCache->set($failureCountKey, $failures, self::FAILURE_STREAK_TTL);
			$delay = self::computeBackoffSeconds($failures);
			if ($delay > 0) {
				$this->rateLimiterCache->set($blockedUntilKey, $this->timeFactory->getTime() + $delay, $delay);
			}
			throw $e;
		}
	}

	private function imapLoginWithConnectionSlot() {
		$this->acquireConnectionSlot();

		try {
			return $this->imapLogin();
		} catch (Throwable $e) {
			$this->connectionSemaphore?->release();
			throw $e;
		}
	}

	private function acquireConnectionSlot(): void {
		if ($this->connectionSemaphore !== null && !$this->connectionSemaphore->acquire($this->allowReservedConnectionSlot)) {
			$this->logger?->notice('IMAP account concurrency limit reached for account {accountId}', [
				'accountId' => $this->account?->getId(),
				'host' => $this->account?->getMailAccount()->getInboundHost(),
				'limit' => $this->connectionSemaphore->getLimit(),
				'availableLimit' => $this->connectionSemaphore->getAvailableLimit($this->allowReservedConnectionSlot),
				'interactive' => $this->allowReservedConnectionSlot,
			]);
			throw new Horde_Imap_Client_Exception(
				'IMAP account concurrency limit reached',
				Horde_Imap_Client_Exception::SERVER_CONNECT,
			);
		}
	}

	private function logAuthRejection(Horde_Imap_Client_Exception $e, string $retryPhase): void {
		if ($this->logger === null || $this->account === null) {
			return;
		}

		$this->logger->warning('IMAP authentication rejected for account {accountId}', [
			'accountId' => $this->account->getId(),
			'host' => $this->account->getMailAccount()->getInboundHost(),
			'authMethod' => $this->account->getMailAccount()->getAuthMethod(),
			'retryPhase' => $retryPhase,
			'tokenTtlBucket' => $this->getTokenTtlBucket(),
			'hordeCode' => $e->getCode(),
			'reason' => $e->getMessage(),
		]);
	}

	private function logAuthRetryRecovered(): void {
		if ($this->logger === null || $this->account === null) {
			return;
		}

		$this->logger->info('IMAP authentication recovered after one OAuth refresh for account {accountId}', [
			'accountId' => $this->account->getId(),
			'host' => $this->account->getMailAccount()->getInboundHost(),
			'authMethod' => $this->account->getMailAccount()->getAuthMethod(),
		]);
	}

	private function getTokenTtlBucket(): string {
		$tokenTtl = $this->account?->getMailAccount()->getOauthTokenTtl();
		if ($tokenTtl === null || $this->timeFactory === null) {
			return 'unknown';
		}

		$remaining = $tokenTtl - $this->timeFactory->getTime();
		if ($remaining <= 0) {
			return 'expired';
		}
		if ($remaining <= 5 * 60) {
			return '0-5m';
		}
		if ($remaining <= 30 * 60) {
			return '5-30m';
		}
		return '30m+';
	}

	private function isRetryableAuthFailure(Horde_Imap_Client_Exception $e): bool {
		// The two messages Horde reports for a rejected login, as
		// opposed to a connection/network-level failure a token refresh
		// can't do anything about anyway.
		return $e->getCode() === Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED
			&& in_array($e->getMessage(), ['Authentication failed.', 'Mail server denied authentication.'], true);
	}

	/**
	 * Forces a real OAuth token refresh (bypassing REFRESH_BUFFER_SECONDS
	 * entirely -- see GoogleIntegration::refresh()'s $force doc comment)
	 * and, if it actually produced a new token, applies it to this same
	 * client so the very next login attempt uses it. Persists the
	 * refreshed token directly via MailAccountMapper rather than
	 * AccountService: AccountService itself depends on
	 * IMAPClientFactory (which constructs and wires up every
	 * HordeImapClient instance, this one included), so taking a direct
	 * AccountService dependency here would be a real circular
	 * dependency, not just a diamond -- the mapper is the same
	 * lower-level persistence AccountService::update() itself calls
	 * into, just without that layer's additional per-request account
	 * cache invalidation, which nothing in this retry path needs.
	 *
	 * @return bool whether a new token was obtained and applied
	 */
	private function forceRefreshTokenAndUpdateClient(): bool {
		if ($this->account === null) {
			// enableAuthRetry() was never called for this client -- no
			// account context to refresh against.
			return false;
		}
		if ($this->googleIntegration->isGoogleOauthAccount($this->account)) {
			$integration = $this->googleIntegration;
		} elseif ($this->microsoftIntegration->isMicrosoftOauthAccount($this->account)) {
			$integration = $this->microsoftIntegration;
		} else {
			// Not an OAuth account (e.g. a plain IMAP password that's
			// wrong, or was just changed) -- no token to refresh.
			return false;
		}

		$oldAccessToken = $this->account->getMailAccount()->getOauthAccessToken();
		$updated = $integration->refresh($this->account, true);
		$newAccessToken = $updated->getMailAccount()->getOauthAccessToken();
		if ($newAccessToken === null || $newAccessToken === $oldAccessToken) {
			// The forced refresh itself didn't produce a new token (the
			// network call to the provider failed, or the account
			// genuinely isn't authorized) -- retrying login would just
			// fail the exact same way again.
			return false;
		}

		$this->mailAccountMapper->update($updated->getMailAccount());
		$this->setParam(
			'xoauth2_token',
			new Horde_Imap_Client_Password_Xoauth2($this->account->getEmail(), $this->crypto->decrypt($newAccessToken)),
		);
		return true;
	}
}
