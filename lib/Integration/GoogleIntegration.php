<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Integration;

use Exception;
use OCA\Mail\Account;
use OCA\Mail\AppInfo\Application;
use OCA\Mail\ConfigLexicon;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IMemcache;
use OCP\IURLGenerator;
use OCP\Security\ICrypto;
use Psr\Log\LoggerInterface;
use function json_decode;
use function json_encode;

class GoogleIntegration {
	private ITimeFactory $timeFactory;
	private IAppConfig $appConfig;
	private ICrypto $crypto;
	private IClientService $clientService;
	private IURLGenerator $urlGenerator;

	// How long a request is allowed to hold the refresh lock before it's
	// considered abandoned (e.g. the holder crashed or was killed
	// mid-refresh) and another request may try again. Generous relative
	// to a normal refresh (a single HTTPS round trip to Google), well
	// short of the REFRESH_BUFFER_SECONDS window refresh() itself waits
	// for before this is even reached.
	private const REFRESH_LOCK_TTL = 30;

	// How long before the token's declared expiry to start refreshing.
	// Confirmed live: even with the refresh lock below, a 60s buffer left
	// every "losing" concurrent request holding a token with under a
	// minute of declared validity left -- sometimes already past it by
	// the time its IMAP round trip reached Gmail, since Account rows are
	// loaded fresh (and independently) per PHP-FPM request, so a loser
	// never sees the winner's refreshed token mid-request. Widening the
	// buffer doesn't remove the race (several requests can still start
	// at the exact same instant), but it gives the winner's refresh
	// (a single HTTPS round trip, normally well under a second) time to
	// land in the database before the *next* wave of requests -- e.g.
	// the following polling tick -- reads the account row again and
	// picks up the already-refreshed token instead of racing at all.
	private const REFRESH_BUFFER_SECONDS = 300;

	public function __construct(
		ITimeFactory $timeFactory,
		IAppConfig $appConfig,
		ICrypto $crypto,
		IClientService $clientService,
		IURLGenerator $urlGenerator,
		private LoggerInterface $logger,
		private ICacheFactory $cacheFactory,
		private IConfig $config,
	) {
		$this->timeFactory = $timeFactory;
		$this->clientService = $clientService;
		$this->crypto = $crypto;
		$this->appConfig = $appConfig;
		$this->urlGenerator = $urlGenerator;
	}

	public function configure(string $clientId, string $clientSecret): void {
		$this->appConfig->setValueString(
			Application::APP_ID,
			ConfigLexicon::GOOGLE_OAUTH_CLIENT_ID,
			$clientId
		);
		$this->appConfig->setValueString(
			Application::APP_ID,
			ConfigLexicon::GOOGLE_OAUTH_CLIENT_SECRET,
			$this->crypto->encrypt($clientSecret),
		);
	}

	public function unlink(): void {
		$this->appConfig->deleteKey(
			Application::APP_ID,
			ConfigLexicon::GOOGLE_OAUTH_CLIENT_ID,
		);
		$this->appConfig->deleteKey(
			Application::APP_ID,
			ConfigLexicon::GOOGLE_OAUTH_CLIENT_SECRET,
		);
	}

	public function getClientId(): ?string {
		$value = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::GOOGLE_OAUTH_CLIENT_ID);
		if ($value === '') {
			return null;
		}
		return $value;
	}

	public function isGoogleOauthAccount(Account $account): bool {
		return $account->getMailAccount()->getInboundHost() === 'imap.gmail.com'
			&& $account->getMailAccount()->getAuthMethod() === 'xoauth2';
	}

	public function finishConnect(Account $account,
		string $code): Account {
		$clientId = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::GOOGLE_OAUTH_CLIENT_ID);
		$encryptedClientSecret = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::GOOGLE_OAUTH_CLIENT_SECRET);
		if (empty($clientId) || empty($encryptedClientSecret)) {
			// This is highly unexpected
			$this->logger->critical('Can not finish Google account linking due to missing client secrets');
			return $account;
		}
		$clientSecret = $this->crypto->decrypt($encryptedClientSecret);
		$httpClient = $this->clientService->newClient();
		try {
			$response = $httpClient->post('https://oauth2.googleapis.com/token', [
				'content-type' => 'application/json',
				'body' => json_encode([
					'client_id' => $clientId,
					'client_secret' => $clientSecret,
					'grant_type' => 'authorization_code',
					'redirect_uri' => $this->getRedirectUrl(),
					'code' => $code,
				], JSON_THROW_ON_ERROR)
			]);
		} catch (Exception $e) {
			$this->logger->error('Could not link Google account: ' . $e->getMessage(), [
				'exception' => $e,
			]);
			return $account;
		}

		$data = json_decode($response->getBody(), true, 512, JSON_THROW_ON_ERROR);
		$encryptedRefreshToken = $this->crypto->encrypt($data['refresh_token']);
		$account->getMailAccount()->setOauthRefreshToken($encryptedRefreshToken);
		$encryptedAccessToken = $this->crypto->encrypt($data['access_token']);
		$account->getMailAccount()->setOauthAccessToken($encryptedAccessToken);
		$account->getMailAccount()->setOauthTokenTtl($this->timeFactory->getTime() + $data['expires_in']);
		return $account;
	}

	/**
	 * @param bool $force Skip the expiry check after an actual IMAP
	 *                    authentication rejection. Forced callers still obey the
	 *                    distributed lock: exactly one request may contact Google's token
	 *                    endpoint, while concurrent losers fail fast and pick up the
	 *                    winner's persisted token on a subsequent request.
	 */
	public function refresh(Account $account, bool $force = false): Account {
		$oauthRefreshToken = $account->getMailAccount()->getOauthRefreshToken();
		if ($account->getMailAccount()->getOauthTokenTtl() === null || $oauthRefreshToken === null) {
			// Account is not authorized yet
			return $account;
		}

		// Only refresh if the token is within REFRESH_BUFFER_SECONDS of expiry
		if (!$force && $this->timeFactory->getTime() <= ($account->getMailAccount()->getOauthTokenTtl() - self::REFRESH_BUFFER_SECONDS)) {
			// No need to refresh yet
			return $account;
		}

		// IMAP connections aren't pooled across requests (see
		// IMAPClientFactory::getClient() -- a fresh one is opened, and
		// this refresh() re-checked, on every single API call), so
		// several concurrent requests for the same account routinely
		// observe "about to expire" at the same moment. Without
		// coordination, all of them raced Google's token endpoint at
		// once -- confirmed live: intermittent "Mail server denied
		// authentication" IMAP rejections for this account (see
		// nextcloud-mail-oauth-integration.md), each costing a full
		// failed connection attempt on top of the wasted duplicate
		// refreshes. A short, best-effort lock lets exactly one request
		// actually refresh; everyone else just proceeds with the token
		// they already have and picks up the refreshed one on their own
		// next request, by which point REFRESH_BUFFER_SECONDS has
		// generally given the winner's refresh time to land in the
		// database (see REFRESH_BUFFER_SECONDS for why). Forced refreshes
		// must use the same single-flight rule: bypassing this lock caused
		// every denied FPM request to rotate the token independently and
		// amplify transient provider throttling.
		$lockCache = $this->cacheFactory->createDistributed('mail_oauth_refresh_lock');
		$lockKey = 'google_account_' . $account->getId();
		$gotLock = !($lockCache instanceof IMemcache) || $lockCache->add($lockKey, true, self::REFRESH_LOCK_TTL);
		if (!$gotLock) {
			if ($force) {
				$this->logger->info('Skipped forced Google OAuth refresh because another request owns the account lock', [
					'accountId' => $account->getId(),
				]);
			}
			return $account;
		}

		$clientId = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::GOOGLE_OAUTH_CLIENT_ID);
		$encryptedClientSecret = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::GOOGLE_OAUTH_CLIENT_SECRET);
		if (empty($clientId) || empty($encryptedClientSecret)) {
			// Nothing to do here
			return $account;
		}

		$refreshToken = $this->crypto->decrypt($oauthRefreshToken);
		$clientSecret = $this->crypto->decrypt($encryptedClientSecret);
		$httpClient = $this->clientService->newClient();
		try {
			$response = $httpClient->post('https://oauth2.googleapis.com/token', [
				'content-type' => 'application/json',
				'body' => json_encode([
					'client_id' => $clientId,
					'client_secret' => $clientSecret,
					'grant_type' => 'refresh_token',
					'refresh_token' => $refreshToken,
				], JSON_THROW_ON_ERROR),
				// This request sits INSIDE an IMAP login: HordeImapClient
				// forces a refresh when a login is denied, then retries. None
				// of the IMAP timeouts cover it -- it is an outbound HTTPS
				// call, and IClient::DEFAULT_REQUEST_TIMEOUT is 30 seconds.
				//
				// Measured 2026-08-15: a deep-search took 41.9s as a stack of
				// individually-bounded steps, and this was the only one that
				// could contribute thirty of them on its own.
				//
				// A token refresh is a small request to a provider's own
				// endpoint. If it cannot answer in five seconds it is not
				// going to, and the IMAP login it was meant to rescue has
				// already failed -- so waiting longer only makes the failure
				// slower.
				'timeout' => $this->config->getSystemValueInt('app.mail.oauth.refresh-timeout', 5),
				'connect_timeout' => 3,
			]);
		} catch (Exception $e) {
			$this->logger->warning('Could not refresh Google OAuth token for account {accountId}: ' . $e->getMessage(), [
				'exception' => $e,
				'accountId' => $account->getId(),
			]);
			return $account;
		}

		$data = json_decode($response->getBody(), true, 512, JSON_THROW_ON_ERROR);
		$encryptedAccessToken = $this->crypto->encrypt($data['access_token']);
		$account->getMailAccount()->setOauthAccessToken($encryptedAccessToken);
		$account->getMailAccount()->setOauthTokenTtl($this->timeFactory->getTime() + $data['expires_in']);

		return $account;
	}

	public function getRedirectUrl(): string {
		return $this->urlGenerator->linkToRouteAbsolute('mail.googleIntegration.oauthRedirect');
	}
}
