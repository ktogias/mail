<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2017 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\IMAP;

use Exception;
use Horde_Imap_Client_Password_Xoauth2;
use Horde_Imap_Client_Socket;
use OCA\Mail\Account;
use OCA\Mail\Cache\HordeCacheFactory;
use OCA\Mail\Db\MailAccountMapper;
use OCA\Mail\Events\BeforeImapClientCreated;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Integration\GoogleIntegration;
use OCA\Mail\Integration\MicrosoftIntegration;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IMemcache;
use OCP\Security\ICrypto;
use Psr\Log\LoggerInterface;
use function hash;
use function implode;
use function max;
use function min;

class IMAPClientFactory {
	private const DEFAULT_ACCOUNT_CONCURRENCY = 3;
	private const MAX_ACCOUNT_CONCURRENCY = 10;
	private const RESERVED_INTERACTIVE_CONNECTIONS = 1;
	/**
	 * Read deadline for work no user is waiting on.
	 *
	 * Twenty seconds is long enough that a healthy provider always answers
	 * within it and short enough that a stalled body search is abandoned while
	 * its results could still have been used. It replaces a 2s `timeout` that
	 * never bounded anything (see getClient(): Horde treats `timeout` as a poll
	 * interval and `read_timeout` as the deadline) and broke the login
	 * handshake instead.
	 */
	private const DEFAULT_BACKGROUND_READ_TIMEOUT_SECONDS = 20;

	/**
	 * Read deadline for work a user is waiting on. Below Horde's own 120s
	 * default, because a minute of silence is already a failed interaction.
	 */
	private const DEFAULT_READ_TIMEOUT_SECONDS = 60;

	/**
	 * Connect timeout, and the interval at which a silent read is polled.
	 *
	 * It has to cover a full TCP + TLS + greeting + AUTHENTICATE exchange,
	 * because that phase is NOT covered by the tolerant SERVER_READTIMEOUT
	 * handling in Horde's command loop -- a read that times out there
	 * desynchronises the stream and surfaces as a bogus authentication
	 * failure. Fifteen seconds against a provider whose healthy handshake was
	 * measured in fractions of a second leaves generous headroom for the slow
	 * ones without letting a genuinely dead host hang a worker.
	 */
	private const DEFAULT_CONNECT_TIMEOUT_SECONDS = 15;

	private const DEFAULT_USER_FETCH_WAIT_MILLISECONDS = 8_000;
	private const MAX_USER_FETCH_WAIT_MILLISECONDS = 15_000;

	/** @var array<string, int> */
	private array $loginCounts = [];

	/** @var ICrypto */
	private $crypto;

	/** @var IConfig */
	private $config;

	/** @var ICacheFactory */
	private $cacheFactory;

	/** @var IEventDispatcher */
	private $eventDispatcher;

	private ITimeFactory $timeFactory;

	public function __construct(
		ICrypto $crypto,
		IConfig $config,
		ICacheFactory $cacheFactory,
		IEventDispatcher $eventDispatcher,
		ITimeFactory $timeFactory,
		private HordeCacheFactory $hordeCacheFactory,
		private GoogleIntegration $googleIntegration,
		private MicrosoftIntegration $microsoftIntegration,
		private MailAccountMapper $mailAccountMapper,
		private LoggerInterface $logger,
	) {
		$this->crypto = $crypto;
		$this->config = $config;
		$this->cacheFactory = $cacheFactory;
		$this->eventDispatcher = $eventDispatcher;
		$this->timeFactory = $timeFactory;
	}

	/**
	 * Get the connection object for the given account
	 *
	 * Connections are not closed until destruction, so the caller site is
	 * responsible to log out as soon as possible to keep the number of open
	 * (and stale) connections at a minimum.
	 *
	 * @param Account $account
	 * @param bool $useCache
	 * @param bool $allowReservedSlot interactive mutations may use the one
	 *                                per-account slot ordinary fetch/sync
	 *                                work cannot consume
	 * @param bool $waitForSlot user-facing reads may wait briefly for ordinary
	 *                          capacity instead of failing immediately; this
	 *                          never grants access to a reserved mutation slot
	 *
	 * @return Horde_Imap_Client_Socket
	 * @throws ServiceException
	 */
	public function getClient(
		Account $account,
		bool $useCache = true,
		bool $allowReservedSlot = false,
		bool $waitForSlot = false,
		?string $workClass = null,
	): Horde_Imap_Client_Socket {
		$this->eventDispatcher->dispatchTyped(
			new BeforeImapClientCreated($account)
		);
		$host = $account->getMailAccount()->getInboundHost();
		$user = $account->getMailAccount()->getInboundUser();
		$decryptedPassword = null;
		if ($account->getMailAccount()->getInboundPassword() !== null) {
			$decryptedPassword = $this->crypto->decrypt($account->getMailAccount()->getInboundPassword());
		}
		$port = $account->getMailAccount()->getInboundPort();
		$sslMode = $account->getMailAccount()->getInboundSslMode();
		if ($sslMode === 'none') {
			$sslMode = false;
		}

		// One idle timeout does not suit every caller -- but `timeout` was the
		// wrong lever for saying so, and this used to set only that one.
		//
		// Horde spends `timeout` three ways: the connect timeout, the argument
		// to stream_set_timeout(), and the bound on its literal-data read loop.
		// What it is NOT is a deadline. When a read times out mid-command,
		// Socket.php catches SERVER_READTIMEOUT and keeps reading for as long
		// as the total is still under `read_timeout` -- so `timeout` is a POLL
		// INTERVAL and `read_timeout` is the actual deadline. We never set
		// `read_timeout`, leaving it at Horde's 120s default.
		//
		// So a 2s `timeout` bought no impatience whatsoever, and cost the one
		// phase that tolerant catch does not cover: connect, greeting and
		// AUTHENTICATE. Captured live against Gmail on 2026-08-24 with
		// per-account IMAP debug -- 67 read timeouts across 32 connections in
		// ten minutes, each leaving the stream desynchronised, so the next
		// command came back `BAD Unknown command: AUTHENTICATE` and Horde
		// reported it as `Mail server denied authentication` (code 102). Horde
		// then fell back to plaintext LOGIN, which Gmail refused as well: two
		// failed auth attempts per incident feeding our own breaker, for what
		// was never an authentication problem. Nine days of "Gmail is rejecting
		// our OAuth token" was this.
		//
		// Hence: `timeout` is now a connect/poll value with room for a TLS
		// handshake, and the per-caller patience moved to `read_timeout`, which
		// is the value Horde actually enforces. Interactive work keeps the
		// longer deadline -- a user waiting on a delete would rather wait than
		// retry; background and search work does not earn it, because a body
		// search's header results are already on screen in ~100ms.
		[$connectTimeout, $readTimeout] = $this->resolveTimeouts(
			self::isInteractiveCaller($allowReservedSlot, $workClass),
		);

		$params = [
			'username' => $user,
			'password' => $decryptedPassword,
			'hostspec' => $host,
			'port' => $port,
			'secure' => $sslMode,
			'timeout' => $connectTimeout,
			'read_timeout' => $readTimeout,
			'context' => [
				'ssl' => [
					'verify_peer' => $this->config->getSystemValueBool('app.mail.verify-tls-peer', true),
					'verify_peer_name' => $this->config->getSystemValueBool('app.mail.verify-tls-peer', true),
				],
			],
		];
		if ($account->getMailAccount()->getAuthMethod() === 'xoauth2') {
			try {
				$oauthAccessToken = $account->getMailAccount()->getOauthAccessToken();
				if ($oauthAccessToken === null) {
					throw new ServiceException('Missing access token for xoauth2 account');
				}
				$decryptedAccessToken = $this->crypto->decrypt($oauthAccessToken);
			} catch (Exception $e) {
				throw new ServiceException('Could not decrypt account access token: ' . $e->getMessage(), 0, $e);
			}

			$params['password'] = $decryptedAccessToken; // Not used, but Horde wants this
			$params['xoauth2_token'] = new Horde_Imap_Client_Password_Xoauth2(
				$account->getEmail(),
				$decryptedAccessToken,
			);
		}
		$rateLimiterHash = $this->buildRateLimiterHash($account);
		if ($useCache) {
			$params['cache'] = [
				'backend' => $this->hordeCacheFactory->newCache($account),
			];
		}
		if ($account->getMailAccount()->getDebug() || $this->config->getSystemValueBool('app.mail.debug')) {
			$fn = "mail-{$account->getUserId()}-{$account->getId()}-imap.log";
			$params['debug'] = $this->config->getSystemValue('datadirectory') . '/' . $fn;
		}

		$client = new HordeImapClient($params, $this);

		$rateLimitingCache = $this->cacheFactory->createDistributed('mail_imap_ratelimit');
		if ($rateLimitingCache instanceof IMemcache) {
			$client->enableRateLimiter($rateLimitingCache, $rateLimiterHash, $this->timeFactory);
		}

		$accountConcurrency = $this->config->getSystemValueInt(
			'app.mail.imap.account-concurrency',
			self::DEFAULT_ACCOUNT_CONCURRENCY,
		);
		$concurrencyCache = $this->cacheFactory->createDistributed('mail_imap_concurrency');
		if ($accountConcurrency > 0 && $concurrencyCache instanceof IMemcache) {
			$workClass = ImapWorkClass::normalize(
				$workClass,
				$allowReservedSlot
					? ImapWorkClass::QUICK_MUTATION
					: ($waitForSlot ? ImapWorkClass::ACTIVE_CONTENT : ImapWorkClass::MAINTENANCE),
			);
			$waitMilliseconds = ($waitForSlot || ImapWorkClass::isForeground($workClass) || $workClass === ImapWorkClass::QUICK_MUTATION)
				? min(
					max(
						$this->config->getSystemValueInt(
							'app.mail.imap.user-fetch-wait-ms',
							self::DEFAULT_USER_FETCH_WAIT_MILLISECONDS,
						),
						0,
					),
					self::MAX_USER_FETCH_WAIT_MILLISECONDS,
				)
				: 0;
			$client->enableConnectionSemaphore(new ImapConnectionSemaphore(
				$concurrencyCache,
				$rateLimiterHash,
				min($accountConcurrency, self::MAX_ACCOUNT_CONCURRENCY),
				self::RESERVED_INTERACTIVE_CONNECTIONS,
			), $allowReservedSlot, $waitMilliseconds, $workClass);
		}

		// Lets _login() force a real token refresh and retry once, itself,
		// the moment a login is denied -- see HordeImapClient::
		// enableAuthRetry()'s own comment. Wired unconditionally: the
		// underlying logic already no-ops cleanly for a non-OAuth account.
		$client->enableAuthRetry($account, $this->googleIntegration, $this->microsoftIntegration, $this->mailAccountMapper, $this->crypto);
		$client->enableAuthTelemetry($this->logger);

		return $client;
	}

	/**
	 * Build one stable circuit-breaker identity for an IMAP endpoint.
	 *
	 * The previous hash included the full Horde parameter array, including
	 * the decrypted password/access token. Every OAuth refresh therefore
	 * moved the same account to a fresh failure bucket and discarded its
	 * backoff history. Credentials are deliberately excluded: a successful
	 * login clears the stable streak, while repeated failures must accumulate
	 * across token rotations.
	 */
	/**
	 * Is a user waiting on this client, right now?
	 *
	 * Extracted so the decision can be tested on its own: getClient() builds a
	 * real Horde socket client, which makes the branch around it awkward to
	 * reach from a unit test and therefore easy to get wrong unnoticed.
	 */
	public static function isInteractiveCaller(bool $allowReservedSlot, ?string $workClass): bool {
		return $allowReservedSlot
			|| $workClass === ImapWorkClass::QUICK_MUTATION
			|| ($workClass !== null && ImapWorkClass::isForeground($workClass));
	}

	/**
	 * The connect/poll timeout and the read deadline for this caller.
	 *
	 * Extracted for the same reason as isInteractiveCaller(): getClient()
	 * builds a real socket client, so the arithmetic around it is otherwise
	 * unreachable from a unit test.
	 *
	 * The connect value is never allowed below the read deadline's own floor
	 * of one poll -- a `read_timeout` shorter than the `timeout` that has to
	 * fire before Horde ever consults it would be silently unenforceable, and
	 * a connect timeout shorter than a TLS handshake is the defect this whole
	 * change exists to remove.
	 *
	 * @return array{int, int} connect timeout and read deadline, in seconds
	 */
	public function resolveTimeouts(bool $interactive): array {
		$connect = max(1, (int)$this->config->getSystemValue(
			'app.mail.imap.connect-timeout',
			self::DEFAULT_CONNECT_TIMEOUT_SECONDS,
		));
		$read = $interactive
			? (int)$this->config->getSystemValue(
				'app.mail.imap.timeout',
				self::DEFAULT_READ_TIMEOUT_SECONDS,
			)
			: (int)$this->config->getSystemValue(
				'app.mail.imap.background-timeout',
				self::DEFAULT_BACKGROUND_READ_TIMEOUT_SECONDS,
			);

		return [$connect, max($connect, $read)];
	}

	private function buildRateLimiterHash(Account $account): string {
		$mailAccount = $account->getMailAccount();
		return hash(
			'sha512',
			implode("\0", [
				'imap-rate-limit-v2',
				$this->config->getSystemValueString('secret'),
				(string)$account->getId(),
				$mailAccount->getInboundHost(),
				(string)$mailAccount->getInboundPort(),
				$mailAccount->getInboundSslMode(),
				$mailAccount->getInboundUser(),
				$mailAccount->getAuthMethod(),
			]),
		);
	}

	public function recordLogin(string $host): void {
		$this->loginCounts[$host] = ($this->loginCounts[$host] ?? 0) + 1;
	}

	/** @return array<string, int> */
	public function getLoginStats(): array {
		return $this->loginCounts;
	}
}
