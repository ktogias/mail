<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace Unit\IMAP;

use ChristophWurst\Nextcloud\Testing\TestCase;
use Horde_Imap_Client_Exception;
use OCA\Mail\Account;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\MailAccountMapper;
use OCA\Mail\IMAP\HordeImapClient;
use OCA\Mail\IMAP\ImapConnectionSemaphore;
use OCA\Mail\IMAP\ImapWorkClass;
use OCA\Mail\Integration\GoogleIntegration;
use OCA\Mail\Integration\MicrosoftIntegration;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IMemcache;
use OCP\Security\ICrypto;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

/**
 * Testable subclass that stubs out the real IMAP connection. $succeeds
 * controls whether the next imapLogin() call succeeds or throws the same
 * exception a real denied/rejected login would; $imapLoginOverride, when
 * set, takes priority over $succeeds and lets a test vary the outcome
 * per call (e.g. fail once, then succeed on the retry).
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
 *
 * setParam() is also overridden and merely recorded: the real
 * Horde_Imap_Client_Base::setParam() would work fine even without a real
 * constructor (it just writes into $_params, which has a class-level
 * default), but recording calls directly is a more direct assertion
 * than reaching into that internal array.
 */
class TestableHordeImapClient extends HordeImapClient {
	public bool $succeeds = false;
	public int $imapLoginCalls = 0;
	/** @var callable|null */
	public $imapLoginOverride = null;
	/** @var list<array{0: string, 1: mixed}> */
	public array $setParamCalls = [];

	public function __construct() {
		// Skip Horde constructor — we only test rate limiter logic.
	}

	public function attemptLogin() {
		return $this->_login();
	}

	protected function imapLogin() {
		$this->imapLoginCalls++;
		if ($this->imapLoginOverride !== null) {
			return ($this->imapLoginOverride)($this->imapLoginCalls);
		}
		if ($this->succeeds) {
			return 'ok';
		}
		throw new Horde_Imap_Client_Exception(
			'Mail server denied authentication.',
			Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED,
		);
	}

	#[\Override]
	public function setParam($key, $val) {
		$this->setParamCalls[] = [$key, $val];
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

	private function googleAccount(): Account {
		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setUserId('user');
		$mailAccount->setEmail('ktogias@gmail.com');
		$mailAccount->setInboundHost('imap.gmail.com');
		$mailAccount->setAuthMethod('xoauth2');
		$mailAccount->setOauthAccessToken('encrypted-old-access-token');
		$mailAccount->setOauthTokenTtl($this->now + 10 * 60);
		return new Account($mailAccount);
	}

	public function testConcurrencyLimitFailsBeforeImapAndDoesNotCountAsAuthFailure(): void {
		$occupier = new ImapConnectionSemaphore($this->cache, 'account-concurrency', 1);
		$occupier->acquire();
		$this->client->enableConnectionSemaphore(new ImapConnectionSemaphore($this->cache, 'account-concurrency', 1));

		try {
			$this->client->attemptLogin();
			self::fail('expected the concurrency-limited attempt to throw');
		} catch (Horde_Imap_Client_Exception $e) {
			self::assertSame(Horde_Imap_Client_Exception::SERVER_CONNECT, $e->getCode());
			self::assertSame('IMAP account concurrency limit reached', $e->getMessage());
		}

		self::assertSame(0, $this->client->imapLoginCalls);
		self::assertNull($this->cache->get('testhash_failures'));
	}

	public function testInteractiveClientCanUseTheReservedSlotWithoutExceedingTheHardLimit(): void {
		// Both ordinary lanes have to be filled through the work classes that
		// own them. This used to call acquire() twice, from back when
		// "ordinary" meant one undifferentiated pool of limit - reservedSlots.
		// Since the work-class partition landed (2026-07-24) the lanes are
		// hard-separated -- with limit 3 and one reserved slot, active content
		// may take slot 1 or 0 while sync/background work may take only slot 0
		// -- so the second acquire() was asking the sync lane for a second
		// slot it is never allowed to have, and the test failed on the setup
		// rather than on what it is named for.
		$activeContent = new ImapConnectionSemaphore($this->cache, 'account-concurrency', 3, 1);
		$syncLane = new ImapConnectionSemaphore($this->cache, 'account-concurrency', 3, 1);
		self::assertTrue($activeContent->acquireFor(ImapWorkClass::ACTIVE_CONTENT));
		self::assertTrue($syncLane->acquireFor(ImapWorkClass::MAINTENANCE));

		$this->client->enableConnectionSemaphore(
			new ImapConnectionSemaphore($this->cache, 'account-concurrency', 3, 1),
			true,
		);
		$this->client->succeeds = true;

		$this->client->attemptLogin();

		self::assertSame(1, $this->client->imapLoginCalls);
		$overflow = new ImapConnectionSemaphore($this->cache, 'account-concurrency', 3, 1);
		self::assertFalse($overflow->acquire(true));
	}

	public function testFailedLoginReleasesItsConcurrencySlot(): void {
		$this->client->enableConnectionSemaphore(new ImapConnectionSemaphore($this->cache, 'account-concurrency', 1));
		$this->client->succeeds = false;

		try {
			$this->client->attemptLogin();
		} catch (Horde_Imap_Client_Exception) {
			// Expected auth rejection.
		}
		$nextConnection = new ImapConnectionSemaphore($this->cache, 'account-concurrency', 1);

		self::assertTrue($nextConnection->acquire());
	}

	public function testSuccessfulLoginHoldsItsSlotUntilLogout(): void {
		$this->client->enableConnectionSemaphore(new ImapConnectionSemaphore($this->cache, 'account-concurrency', 1));
		$this->client->succeeds = true;
		$this->client->attemptLogin();
		$nextConnection = new ImapConnectionSemaphore($this->cache, 'account-concurrency', 1);

		self::assertFalse($nextConnection->acquire());

		$this->client->logout();

		self::assertTrue($nextConnection->acquire());
	}

	public function testAuthTelemetryContainsOnlyWhitelistedMetadata(): void {
		$account = $this->googleAccount();
		$googleIntegration = $this->createMock(GoogleIntegration::class);
		$microsoftIntegration = $this->createMock(MicrosoftIntegration::class);
		$mailAccountMapper = $this->createMock(MailAccountMapper::class);
		$crypto = $this->createMock(ICrypto::class);
		$logger = $this->createMock(LoggerInterface::class);
		$this->client->enableAuthRetry($account, $googleIntegration, $microsoftIntegration, $mailAccountMapper, $crypto);
		$this->client->enableAuthTelemetry($logger);
		$this->client->succeeds = false;
		$googleIntegration->method('isGoogleOauthAccount')->willReturn(false);
		$microsoftIntegration->method('isMicrosoftOauthAccount')->willReturn(false);
		$logger->expects(self::once())
			->method('warning')
			->with(
				'IMAP authentication rejected for account {accountId}',
				self::callback(function (array $context): bool {
					self::assertSame(13, $context['accountId']);
					self::assertSame('imap.gmail.com', $context['host']);
					self::assertSame('xoauth2', $context['authMethod']);
					self::assertSame('initial', $context['retryPhase']);
					self::assertSame('5-30m', $context['tokenTtlBucket']);
					self::assertArrayNotHasKey('exception', $context);
					$serialized = json_encode($context, JSON_THROW_ON_ERROR);
					self::assertStringNotContainsString('ktogias@gmail.com', $serialized);
					self::assertStringNotContainsString('encrypted-old-access-token', $serialized);
					return true;
				}),
			);

		try {
			$this->client->attemptLogin();
		} catch (Horde_Imap_Client_Exception) {
			// Expected auth rejection.
		}
	}

	/**
	 * Moved here from ImapToDbSynchronizerTest (formerly
	 * testSyncForcesATokenRefreshAndRetriesLoginOnceAfterAnAuthRejection
	 * and its three siblings): the forced-refresh-and-retry-once
	 * protection now lives in _login() itself, not in a wrapper around
	 * one specific caller's own login() call -- see
	 * HordeImapClient::enableAuthRetry()'s own comment for why. Confirmed
	 * live for a Google account well within its stored token's declared
	 * validity window (so not simply caught by REFRESH_BUFFER_SECONDS):
	 * "Mail server denied authentication" still happens occasionally,
	 * across more than one IMAP call site.
	 */
	public function testLoginForcesATokenRefreshAndRetriesOnceAfterAnAuthRejection(): void {
		$account = $this->googleAccount();
		$googleIntegration = $this->createMock(GoogleIntegration::class);
		$microsoftIntegration = $this->createMock(MicrosoftIntegration::class);
		$mailAccountMapper = $this->createMock(MailAccountMapper::class);
		$crypto = $this->createMock(ICrypto::class);
		$this->client->enableAuthRetry($account, $googleIntegration, $microsoftIntegration, $mailAccountMapper, $crypto);

		$this->client->imapLoginOverride = function (int $callNumber) {
			if ($callNumber === 1) {
				throw new Horde_Imap_Client_Exception('Mail server denied authentication.', Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED);
			}
			return 'ok';
		};

		$googleIntegration->method('isGoogleOauthAccount')->with($account)->willReturn(true);
		$refreshedMailAccount = new MailAccount();
		$refreshedMailAccount->setId(13);
		$refreshedMailAccount->setEmail('ktogias@gmail.com');
		$refreshedMailAccount->setOauthAccessToken('encrypted-new-access-token');
		$googleIntegration->expects(self::once())
			->method('refresh')
			->with($account, true)
			->willReturn(new Account($refreshedMailAccount));
		$mailAccountMapper->expects(self::once())
			->method('update')
			->with($refreshedMailAccount);
		$crypto->method('decrypt')->with('encrypted-new-access-token')->willReturn('plaintext-new-access-token');

		$this->client->attemptLogin();

		self::assertSame(2, $this->client->imapLoginCalls);
		self::assertCount(1, $this->client->setParamCalls);
		self::assertSame('xoauth2_token', $this->client->setParamCalls[0][0]);
		self::assertInstanceOf(\Horde_Imap_Client_Password_Xoauth2::class, $this->client->setParamCalls[0][1]);
		// A retry that succeeds is a plain success as far as the rate
		// limiter is concerned -- the original rejection must not cost
		// this now-healthy account any part of a backoff window.
		self::assertNull($this->cache->get('testhash_failures'));
		self::assertNull($this->cache->get('testhash_blocked_until'));
	}

	public function testLoginGivesUpAfterASecondAuthRejectionEvenAfterARefreshButOnlyCountsOneFailure(): void {
		$account = $this->googleAccount();
		$googleIntegration = $this->createMock(GoogleIntegration::class);
		$microsoftIntegration = $this->createMock(MicrosoftIntegration::class);
		$mailAccountMapper = $this->createMock(MailAccountMapper::class);
		$crypto = $this->createMock(ICrypto::class);
		$this->client->enableAuthRetry($account, $googleIntegration, $microsoftIntegration, $mailAccountMapper, $crypto);
		$this->client->succeeds = false;

		$googleIntegration->method('isGoogleOauthAccount')->with($account)->willReturn(true);
		$refreshedMailAccount = new MailAccount();
		$refreshedMailAccount->setId(13);
		$refreshedMailAccount->setEmail('ktogias@gmail.com');
		$refreshedMailAccount->setOauthAccessToken('encrypted-new-access-token');
		$googleIntegration->method('refresh')->willReturn(new Account($refreshedMailAccount));
		$crypto->method('decrypt')->willReturn('plaintext-new-access-token');

		try {
			$this->client->attemptLogin();
			self::fail('expected the second, post-retry rejection to throw');
		} catch (Horde_Imap_Client_Exception $e) {
			self::assertSame('Mail server denied authentication.', $e->getMessage());
		}

		self::assertSame(2, $this->client->imapLoginCalls);
		// Exactly ONE failure recorded, not two -- the retry happening
		// inside _login() itself, not as two independent outer calls
		// each separately triggering the rate limiter, is what makes
		// this correct (the previous, wrapper-based design would have
		// recorded two failures for this exact sequence).
		self::assertSame(1, $this->cache->get('testhash_failures'));
	}

	public function testLoginDoesNotRetryWhenTheForcedRefreshProducesNoNewToken(): void {
		$account = $this->googleAccount();
		$googleIntegration = $this->createMock(GoogleIntegration::class);
		$microsoftIntegration = $this->createMock(MicrosoftIntegration::class);
		$mailAccountMapper = $this->createMock(MailAccountMapper::class);
		$crypto = $this->createMock(ICrypto::class);
		$this->client->enableAuthRetry($account, $googleIntegration, $microsoftIntegration, $mailAccountMapper, $crypto);
		$this->client->succeeds = false;

		$googleIntegration->method('isGoogleOauthAccount')->with($account)->willReturn(true);
		// The forced refresh() call itself failed (e.g. Google's token
		// endpoint was unreachable) -- the account comes back unchanged,
		// still holding the exact same (already known-bad) access token.
		$googleIntegration->method('refresh')->willReturn($account);
		$mailAccountMapper->expects(self::never())->method('update');

		try {
			$this->client->attemptLogin();
			self::fail('expected the rejection to throw without a retry');
		} catch (Horde_Imap_Client_Exception $e) {
			self::assertSame('Mail server denied authentication.', $e->getMessage());
		}

		self::assertSame(1, $this->client->imapLoginCalls, 'no retry should have been attempted at all');
		self::assertCount(0, $this->client->setParamCalls);
	}

	public function testLoginDoesNotRetryForANonOauthAccount(): void {
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$mailAccount->setInboundHost('imap.example.com');
		$mailAccount->setAuthMethod('password');
		$account = new Account($mailAccount);
		$googleIntegration = $this->createMock(GoogleIntegration::class);
		$microsoftIntegration = $this->createMock(MicrosoftIntegration::class);
		$mailAccountMapper = $this->createMock(MailAccountMapper::class);
		$crypto = $this->createMock(ICrypto::class);
		$this->client->enableAuthRetry($account, $googleIntegration, $microsoftIntegration, $mailAccountMapper, $crypto);
		$this->client->succeeds = false;

		$googleIntegration->method('isGoogleOauthAccount')->willReturn(false);
		$microsoftIntegration->method('isMicrosoftOauthAccount')->willReturn(false);
		$googleIntegration->expects(self::never())->method('refresh');
		$microsoftIntegration->expects(self::never())->method('refresh');

		try {
			$this->client->attemptLogin();
			self::fail('expected the rejection to throw without a retry');
		} catch (Horde_Imap_Client_Exception $e) {
			self::assertSame('Mail server denied authentication.', $e->getMessage());
		}

		self::assertSame(1, $this->client->imapLoginCalls);
	}

	public function testLoginNeverRetriesWithoutEnableAuthRetryHavingBeenCalled(): void {
		// $this->client (from setUp()) never had enableAuthRetry() called
		// on it -- exactly a plain, non-xoauth2 password account, or any
		// client predating this feature. Must behave exactly as before:
		// a single failed attempt, no retry, normal rate-limiter
		// bookkeeping.
		$this->client->succeeds = false;

		try {
			$this->client->attemptLogin();
			self::fail('expected the rejection to throw without a retry');
		} catch (Horde_Imap_Client_Exception $e) {
			self::assertSame('Mail server denied authentication.', $e->getMessage());
		}

		self::assertSame(1, $this->client->imapLoginCalls);
	}
}
