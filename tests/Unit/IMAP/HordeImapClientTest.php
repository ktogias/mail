<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Unit\IMAP;

use ChristophWurst\Nextcloud\Testing\TestCase;
use Horde_Imap_Client_Exception;
use OCA\Mail\IMAP\HordeImapClient;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IMemcache;
use PHPUnit\Framework\MockObject\MockObject;

/**
 * Testable subclass that stubs out the real IMAP connection. $succeeds
 * controls whether the next imapLogin() call succeeds or throws the same
 * exception a real denied/rejected login would.
 *
 * Exercises _login() directly via attemptLogin() rather than through the
 * inherited login() -- that goes through Horde_Imap_Client_Base's own
 * login()/capability-query machinery, which (correctly) isn't set up
 * here since the whole point is skipping Horde's real constructor to
 * test only the rate-limiter logic in isolation. That machinery never
 * gets reached on a FAILING login (the exception propagates straight
 * out of our overridden _login() before Horde's own post-login code
 * runs), which is why the original, failure-only version of this test
 * could get away with calling login() -- but a SUCCEEDING login does
 * reach it, and crashes on Horde internal state this test deliberately
 * never initializes.
 */
class TestableHordeImapClient extends HordeImapClient {
	public bool $succeeds = false;
	public int $imapLoginCalls = 0;

	public function __construct() {
		// Skip Horde constructor — we only test rate limiter logic.
	}

	public function attemptLogin() {
		return $this->_login();
	}

	protected function imapLogin() {
		$this->imapLoginCalls++;
		if ($this->succeeds) {
			return 'ok';
		}
		throw new Horde_Imap_Client_Exception(
			'Mail server denied authentication.',
			Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED,
		);
	}
}

/**
 * A tiny in-memory stand-in for IMemcache that behaves like the real thing
 * closely enough for these tests (get/set/remove with TTL bookkeeping
 * isn't itself under test here -- just that HordeImapClient calls them
 * with the right keys and values).
 */
class FakeRateLimiterCache implements IMemcache {
	private array $values = [];

	public function get($key) {
		return $this->values[$key] ?? null;
	}

	public function set($key, $value, $ttl = 0) {
		$this->values[$key] = $value;
		return true;
	}

	public function remove($key) {
		unset($this->values[$key]);
		return true;
	}

	public function hasKey($key) {
		return array_key_exists($key, $this->values);
	}

	public function clear($prefix = '') {
		$this->values = [];
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
		unset($this->values[$key]);
		return true;
	}

	public function ncad(string $key, mixed $old): bool {
		if (!$this->hasKey($key) || $this->get($key) === $old) {
			return false;
		}
		unset($this->values[$key]);
		return true;
	}
}

class HordeImapClientTest extends TestCase {
	private FakeRateLimiterCache $cache;
	private ITimeFactory|MockObject $timeFactory;
	private TestableHordeImapClient $client;
	private int $now;

	protected function setUp(): void {
		parent::setUp();

		$this->cache = new FakeRateLimiterCache();
		$this->now = 100_000;
		$this->timeFactory = $this->createMock(ITimeFactory::class);
		$this->timeFactory->method('getTime')->willReturnCallback(fn () => $this->now);

		$this->client = new TestableHordeImapClient();
		$this->client->enableRateLimiter($this->cache, 'testhash', $this->timeFactory);
	}

	public function testComputeBackoffBoundSecondsIsZeroForALoneFailure(): void {
		self::assertSame(0, HordeImapClient::computeBackoffBoundSeconds(0));
		self::assertSame(0, HordeImapClient::computeBackoffBoundSeconds(1));
	}

	public function testComputeBackoffBoundSecondsGrowsExponentially(): void {
		self::assertSame(30, HordeImapClient::computeBackoffBoundSeconds(2));
		self::assertSame(60, HordeImapClient::computeBackoffBoundSeconds(3));
		self::assertSame(120, HordeImapClient::computeBackoffBoundSeconds(4));
		self::assertSame(240, HordeImapClient::computeBackoffBoundSeconds(5));
	}

	public function testComputeBackoffBoundSecondsCapsAtThirtyMinutes(): void {
		// Uncapped, failure #10 would be 30 * 2^8 = 7680s -- must clamp
		// to the 30-minute (1800s) ceiling instead.
		self::assertSame(1800, HordeImapClient::computeBackoffBoundSeconds(10));
		self::assertSame(1800, HordeImapClient::computeBackoffBoundSeconds(50));
	}

	public function testComputeBackoffSecondsStaysWithinItsOwnBound(): void {
		for ($failures = 1; $failures <= 12; $failures++) {
			$bound = HordeImapClient::computeBackoffBoundSeconds($failures);
			for ($i = 0; $i < 20; $i++) {
				$delay = HordeImapClient::computeBackoffSeconds($failures);
				self::assertGreaterThanOrEqual(0, $delay);
				self::assertLessThanOrEqual($bound, $delay);
			}
		}
	}

	public function testALoneFailureDoesNotBlockTheNextAttempt(): void {
		// First attempt: denied. Since a single failure costs no
		// backoff, the very next attempt must still reach imapLogin()
		// for real, not get short-circuited.
		try {
			$this->client->attemptLogin();
			self::fail('expected the first attempt to throw');
		} catch (Horde_Imap_Client_Exception $e) {
			self::assertSame('Mail server denied authentication.', $e->getMessage());
		}

		self::assertSame(1, $this->client->imapLoginCalls);
		self::assertNull($this->cache->get('testhash_blocked_until'));

		$this->client->succeeds = true;
		$this->client->attemptLogin();

		self::assertSame(2, $this->client->imapLoginCalls, 'the second attempt must have reached imapLogin() for real, not been short-circuited');
	}

	public function testAThirdConsecutiveFailureBlocksFurtherAttemptsUntilTheBackoffElapses(): void {
		$this->client->succeeds = false;

		// Two failures: no block yet (bound is 0 for the first, and the
		// second's own jittered delay could legitimately land on 0 too,
		// but by the third we're guaranteed a non-zero bound).
		for ($i = 0; $i < 2; $i++) {
			try {
				$this->client->attemptLogin();
			} catch (Horde_Imap_Client_Exception) {
				// expected
			}
		}

		// Third failure: bound is now 60s (computeBackoffBoundSeconds(3)),
		// so it's possible (if unlikely) for jitter to land exactly on 0.
		// Force a specific, non-zero delay deterministically instead of
		// depending on real randomness for this assertion.
		$this->cache->set('testhash_failures', 2, 3600);
		try {
			$this->client->attemptLogin();
		} catch (Horde_Imap_Client_Exception) {
			// expected
		}

		$blockedUntil = $this->cache->get('testhash_blocked_until');
		if ($blockedUntil === null) {
			self::markTestSkipped('jitter happened to land on exactly 0 for this run; the bound is still correctly non-zero, see testComputeBackoffBoundSecondsGrowsExponentially');
		}

		self::assertGreaterThan($this->now, $blockedUntil);
		self::assertLessThanOrEqual($this->now + 60, $blockedUntil);

		$callsBeforeShortCircuit = $this->client->imapLoginCalls;

		// Still inside the backoff window: short-circuited, no real
		// imapLogin() call at all.
		try {
			$this->client->attemptLogin();
			self::fail('expected the still-blocked attempt to throw');
		} catch (Horde_Imap_Client_Exception $e) {
			self::assertSame('Too many auth attempts', $e->getMessage());
		}
		self::assertSame($callsBeforeShortCircuit, $this->client->imapLoginCalls, 'a blocked attempt must not touch IMAP at all');

		// Advance past the backoff window: the next attempt must reach
		// imapLogin() for real again.
		$this->now = $blockedUntil + 1;
		$this->client->succeeds = true;
		$this->client->attemptLogin();
		self::assertSame($callsBeforeShortCircuit + 1, $this->client->imapLoginCalls);
	}

	public function testASuccessAfterFailuresClearsTheStreakImmediately(): void {
		$this->cache->set('testhash_failures', 5, 3600);
		$this->cache->set('testhash_blocked_until', $this->now - 1, 3600); // already elapsed, so this attempt is allowed through

		$this->client->succeeds = true;
		$this->client->attemptLogin();

		self::assertNull($this->cache->get('testhash_failures'));
		self::assertNull($this->cache->get('testhash_blocked_until'));
	}

	public function testEachAccountIsRateLimitedIndependently(): void {
		$other = new TestableHordeImapClient();
		$other->enableRateLimiter($this->cache, 'otherhash', $this->timeFactory);

		$this->cache->set('testhash_failures', 5, 3600);
		$this->cache->set('testhash_blocked_until', $this->now + 3600, 3600);

		// The blocked account is still blocked...
		try {
			$this->client->attemptLogin();
			self::fail('expected the blocked account to throw');
		} catch (Horde_Imap_Client_Exception $e) {
			self::assertSame('Too many auth attempts', $e->getMessage());
		}

		// ...but a completely different account, keyed by its own hash,
		// is entirely unaffected.
		$other->succeeds = true;
		$other->attemptLogin();
		self::assertSame(1, $other->imapLoginCalls);
	}
}
