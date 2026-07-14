<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2023 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP;

use Horde_Imap_Client_Exception;
use Horde_Imap_Client_Exception_NoSupportExtension;
use Horde_Imap_Client_Socket;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IMemcache;
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

	#[\Override]
	public function login() {
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
	// ImapToDbSynchronizer::sync()'s forced-refresh retry exists to
	// catch) and only rarely sustained (e.g. a temporary provider-side
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
		if ($this->rateLimiterCache === null) {
			return $this->imapLogin();
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
			$result = $this->imapLogin();
			// Success -- whatever caused any earlier failures has
			// cleared up. Clear the streak immediately rather than
			// leaving a now-healthy account to wait out whatever was
			// left of its own backoff.
			$this->rateLimiterCache->remove($failureCountKey);
			$this->rateLimiterCache->remove($blockedUntilKey);
			return $result;
		} catch (Horde_Imap_Client_Exception $e) {
			if ($e->getCode() === Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED
				&& in_array($e->getMessage(), ['Authentication failed.', 'Mail server denied authentication.'], true)) {
				$failures = ((int)$this->rateLimiterCache->get($failureCountKey)) + 1;
				$this->rateLimiterCache->set($failureCountKey, $failures, self::FAILURE_STREAK_TTL);
				$delay = self::computeBackoffSeconds($failures);
				if ($delay > 0) {
					$this->rateLimiterCache->set($blockedUntilKey, $this->timeFactory->getTime() + $delay, $delay);
				}
			}
			throw $e;
		}
	}
}
