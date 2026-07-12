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
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Http\Client\IClientService;
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
	private IConfig $config;
	private ICrypto $crypto;
	private IClientService $clientService;
	private IURLGenerator $urlGenerator;

	// How long a request is allowed to hold the refresh lock before it's
	// considered abandoned (e.g. the holder crashed or was killed
	// mid-refresh) and another request may try again. Generous relative
	// to a normal refresh (a single HTTPS round trip to Google), well
	// short of the 60s grace window refresh() itself waits for before
	// this is even reached.
	private const REFRESH_LOCK_TTL = 30;

	public function __construct(
		ITimeFactory $timeFactory,
		IConfig $config,
		ICrypto $crypto,
		IClientService $clientService,
		IURLGenerator $urlGenerator,
		private LoggerInterface $logger,
		private ICacheFactory $cacheFactory,
	) {
		$this->timeFactory = $timeFactory;
		$this->clientService = $clientService;
		$this->crypto = $crypto;
		$this->config = $config;
		$this->urlGenerator = $urlGenerator;
	}

	public function configure(string $clientId, string $clientSecret): void {
		$this->config->setAppValue(
			Application::APP_ID,
			'google_oauth_client_id',
			$clientId
		);
		$this->config->setAppValue(
			Application::APP_ID,
			'google_oauth_client_secret',
			$this->crypto->encrypt($clientSecret),
		);
	}

	public function unlink(): void {
		$this->config->deleteAppValue(
			Application::APP_ID,
			'google_oauth_client_id',
		);
		$this->config->deleteAppValue(
			Application::APP_ID,
			'google_oauth_client_secret',
		);
	}

	public function getClientId(): ?string {
		$value = $this->config->getAppValue(Application::APP_ID, 'google_oauth_client_id');
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
		$clientId = $this->config->getAppValue(Application::APP_ID, 'google_oauth_client_id');
		$encryptedClientSecret = $this->config->getAppValue(Application::APP_ID, 'google_oauth_client_secret');
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

	public function refresh(Account $account): Account {
		$oauthRefreshToken = $account->getMailAccount()->getOauthRefreshToken();
		if ($account->getMailAccount()->getOauthTokenTtl() === null || $oauthRefreshToken === null) {
			// Account is not authorized yet
			return $account;
		}

		// Only refresh if the token expires in the next minute
		if ($this->timeFactory->getTime() <= ($account->getMailAccount()->getOauthTokenTtl() - 60)) {
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
		// they already have (still valid for the 60s grace period above)
		// and picks up the refreshed one on their own next request.
		$lockCache = $this->cacheFactory->createDistributed('mail_oauth_refresh_lock');
		$lockKey = 'google_account_' . $account->getId();
		if ($lockCache instanceof IMemcache && !$lockCache->add($lockKey, true, self::REFRESH_LOCK_TTL)) {
			return $account;
		}

		$clientId = $this->config->getAppValue(Application::APP_ID, 'google_oauth_client_id');
		$encryptedClientSecret = $this->config->getAppValue(Application::APP_ID, 'google_oauth_client_secret');
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
				], JSON_THROW_ON_ERROR)
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
