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

class MicrosoftIntegration {
	private ITimeFactory $timeFactory;
	private IAppConfig $appConfig;
	private ICrypto $crypto;
	private IClientService $clientService;
	private IURLGenerator $urlGenerator;

	// See GoogleIntegration::REFRESH_LOCK_TTL for the reasoning -- same
	// race, same fix, for Microsoft accounts.
	private const REFRESH_LOCK_TTL = 30;

	// See GoogleIntegration::REFRESH_BUFFER_SECONDS for the reasoning --
	// same race, same fix, for Microsoft accounts.
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

	public function configure(?string $tenantId, string $clientId, string $clientSecret): void {
		if ($tenantId !== null) {
			$this->appConfig->setValueString(
				Application::APP_ID,
				ConfigLexicon::MICROSOFT_OAUTH_TENANT_ID,
				$tenantId
			);
		}
		$this->appConfig->setValueString(
			Application::APP_ID,
			ConfigLexicon::MICROSOFT_OAUTH_CLIENT_ID,
			$clientId
		);
		$this->appConfig->setValueString(
			Application::APP_ID,
			ConfigLexicon::MICROSOFT_OAUTH_CLIENT_SECRET,
			$this->crypto->encrypt($clientSecret),
		);
	}

	public function unlink(): void {
		$this->appConfig->deleteKey(
			Application::APP_ID,
			ConfigLexicon::MICROSOFT_OAUTH_TENANT_ID,
		);
		$this->appConfig->deleteKey(
			Application::APP_ID,
			ConfigLexicon::MICROSOFT_OAUTH_CLIENT_ID,
		);
		$this->appConfig->deleteKey(
			Application::APP_ID,
			ConfigLexicon::MICROSOFT_OAUTH_CLIENT_SECRET,
		);
	}

	public function getTenantId(): ?string {
		return $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::MICROSOFT_OAUTH_TENANT_ID, 'common');
	}

	public function getClientId(): ?string {
		$value = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::MICROSOFT_OAUTH_CLIENT_ID);
		if ($value === '') {
			return null;
		}
		return $value;
	}

	public function isMicrosoftOauthAccount(Account $account): bool {
		return $account->getMailAccount()->getInboundHost() === 'outlook.office365.com'
			&& $account->getMailAccount()->getAuthMethod() === 'xoauth2';
	}

	public function finishConnect(Account $account,
		string $code): Account {
		$tenantId = $this->getTenantId();
		$clientId = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::MICROSOFT_OAUTH_CLIENT_ID);
		$encryptedClientSecret = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::MICROSOFT_OAUTH_CLIENT_SECRET);
		if (empty($tenantId) || empty($clientId) || empty($encryptedClientSecret)) {
			// This is highly unexpected
			$this->logger->critical('Can not finish Microsoft account linking due to missing client secrets');
			return $account;
		}
		$clientSecret = $this->crypto->decrypt($encryptedClientSecret);
		$httpClient = $this->clientService->newClient();
		try {
			$response = $httpClient->post("https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token", [
				'form_params' => [
					'client_id' => $clientId,
					'client_secret' => $clientSecret,
					'grant_type' => 'authorization_code',
					'redirect_uri' => $this->getRedirectUrl(),
					'code' => $code,
				],
			]);
		} catch (Exception $e) {
			$this->logger->error('Could not link Microsoft account: ' . $e->getMessage(), [
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
	 * @param bool $force See GoogleIntegration::refresh()'s $force doc
	 *                    comment -- same expiry bypass and single-flight rule for
	 *                    Microsoft accounts.
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

		// See GoogleIntegration::refresh() for the reasoning -- same
		// unpooled-IMAP-connection race, same fix.
		$lockCache = $this->cacheFactory->createDistributed('mail_oauth_refresh_lock');
		$lockKey = 'microsoft_account_' . $account->getId();
		$gotLock = !($lockCache instanceof IMemcache) || $lockCache->add($lockKey, true, self::REFRESH_LOCK_TTL);
		if (!$gotLock) {
			if ($force) {
				$this->logger->info('Skipped forced Microsoft OAuth refresh because another request owns the account lock', [
					'accountId' => $account->getId(),
				]);
			}
			return $account;
		}

		$tenantId = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::MICROSOFT_OAUTH_TENANT_ID);
		$clientId = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::MICROSOFT_OAUTH_CLIENT_ID);
		$encryptedClientSecret = $this->appConfig->getValueString(Application::APP_ID, ConfigLexicon::MICROSOFT_OAUTH_CLIENT_SECRET);
		if (empty($tenantId) || empty($clientId) || empty($encryptedClientSecret)) {
			// Nothing to do here
			return $account;
		}

		$refreshToken = $this->crypto->decrypt($oauthRefreshToken);
		$clientSecret = $this->crypto->decrypt($encryptedClientSecret);
		$httpClient = $this->clientService->newClient();
		try {
			$response = $httpClient->post("https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token", [
				'content-type' => 'application/json',
				'form_params' => [
					'client_id' => $clientId,
					'client_secret' => $clientSecret,
					'grant_type' => 'refresh_token',
					'refresh_token' => $refreshToken,
				],
				// Same reasoning as GoogleIntegration::refresh(): this sits
				// inside an IMAP login, no IMAP timeout covers it, and
				// IClient::DEFAULT_REQUEST_TIMEOUT is 30 seconds.
				'timeout' => $this->config->getSystemValueInt('app.mail.oauth.refresh-timeout', 5),
				'connect_timeout' => 3,
			]);
		} catch (Exception $e) {
			$this->logger->warning('Could not refresh Microsoft OAuth token for account {accountId}: ' . $e->getMessage(), [
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
		return $this->urlGenerator->linkToRouteAbsolute('mail.microsoftIntegration.oauthRedirect');
	}
}
