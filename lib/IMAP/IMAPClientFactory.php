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
	 * Idle timeout for work no user is waiting on.
	 *
	 * Two seconds is enough for a healthy server to answer and short enough
	 * that a sequence of stalled steps cannot add up to the 41.9s that was
	 * measured. A provider this slow is not going to produce a useful body
	 * search anyway.
	 */
	private const DEFAULT_BACKGROUND_TIMEOUT_SECONDS = 2;

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

		// One idle timeout does not suit every caller.
		//
		// This value reaches stream_set_timeout(), so it bounds how long ANY
		// single read may sit with no data -- and Horde's literal-data loop
		// checks it explicitly too. What it cannot bound is the SUM: a request
		// that connects, is refused, refreshes its token, logs in again,
		// SELECTs and SEARCHes spends up to this long at each step, and none of
		// them misbehaves. Measured 2026-08-15: one deep-search took 41.9s that
		// way and the client abandoned it at about 40s, so the last stretch was
		// work whose result nobody could still read.
		//
		// Interactive work keeps the full patience: a user waiting on a delete
		// would rather wait than retry. Background and search work does not
		// earn it -- for a body search the header results are already on screen
		// in ~100ms, so giving up early costs the user nothing and giving up
		// late costs them the whole page.
		$timeout = self::isInteractiveCaller($allowReservedSlot, $workClass)
			? (int)$this->config->getSystemValue('app.mail.imap.timeout', 5)
			: max(1, (int)$this->config->getSystemValue(
				'app.mail.imap.background-timeout',
				self::DEFAULT_BACKGROUND_TIMEOUT_SECONDS,
			));

		$params = [
			'username' => $user,
			'password' => $decryptedPassword,
			'hostspec' => $host,
			'port' => $port,
			'secure' => $sslMode,
			'timeout' => $timeout,
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
