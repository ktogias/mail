<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Integration;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Integration\GoogleIntegration;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Http\Client\IClientService;
use OCP\Http\Client\IResponse;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IMemcache;
use OCP\IURLGenerator;
use OCP\Security\ICrypto;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class GoogleIntegrationTest extends TestCase {
	private ITimeFactory&MockObject $timeFactory;
	private IConfig&MockObject $config;
	private ICrypto&MockObject $crypto;
	private IClientService&MockObject $clientService;
	private IURLGenerator&MockObject $urlGenerator;
	private LoggerInterface&MockObject $logger;
	private ICacheFactory&MockObject $cacheFactory;
	private IMemcache&MockObject $lockCache;
	private GoogleIntegration $integration;

	protected function setUp(): void {
		parent::setUp();

		$this->timeFactory = $this->createMock(ITimeFactory::class);
		$this->config = $this->createMock(IConfig::class);
		$this->crypto = $this->createMock(ICrypto::class);
		$this->clientService = $this->createMock(IClientService::class);
		$this->urlGenerator = $this->createMock(IURLGenerator::class);
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->cacheFactory = $this->createMock(ICacheFactory::class);
		$this->lockCache = $this->createMock(IMemcache::class);
		$this->cacheFactory->method('createDistributed')->willReturn($this->lockCache);

		$this->integration = new GoogleIntegration(
			$this->timeFactory,
			$this->config,
			$this->crypto,
			$this->clientService,
			$this->urlGenerator,
			$this->logger,
			$this->cacheFactory,
		);
	}

	private function accountAboutToExpire(): Account {
		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setOauthRefreshToken('encrypted-refresh-token');
		$mailAccount->setOauthAccessToken('encrypted-old-access-token');
		// Within the REFRESH_BUFFER_SECONDS (300s) window refresh()
		// checks -- "now" is mocked to 1000 below, so this is already
		// inside it.
		$mailAccount->setOauthTokenTtl(1030);
		return new Account($mailAccount);
	}

	/**
	 * Confirmed live: IMAP connections aren't pooled across requests, so
	 * every single API call re-runs this check -- several concurrent
	 * requests for the same account routinely observe "about to expire"
	 * at the same moment and, without coordination, all raced Google's
	 * token endpoint at once. Intermittent "Mail server denied
	 * authentication" IMAP rejections resulted (see
	 * nextcloud-mail-oauth-integration.md).
	 */
	public function testRefreshesNormallyWhenItAcquiresTheLock(): void {
		$this->timeFactory->method('getTime')->willReturn(1000);
		$this->crypto->method('decrypt')->willReturnArgument(0);
		$this->crypto->method('encrypt')->willReturnArgument(0);
		$this->config->method('getAppValue')->willReturnMap([
			['mail', 'google_oauth_client_id', '', 'client-id'],
			['mail', 'google_oauth_client_secret', '', 'encrypted-client-secret'],
		]);
		$this->lockCache->expects(self::once())
			->method('add')
			->with('google_account_13', true, 30)
			->willReturn(true);

		$response = $this->createMock(IResponse::class);
		$response->method('getBody')->willReturn(json_encode([
			'access_token' => 'new-access-token',
			'refresh_token' => 'new-refresh-token',
			'expires_in' => 3600,
		]));
		$httpClient = $this->createMock(\OCP\Http\Client\IClient::class);
		$httpClient->expects(self::once())->method('post')->willReturn($response);
		$this->clientService->method('newClient')->willReturn($httpClient);

		$result = $this->integration->refresh($this->accountAboutToExpire());

		self::assertSame('new-access-token', $result->getMailAccount()->getOauthAccessToken());
		self::assertSame(1000 + 3600, $result->getMailAccount()->getOauthTokenTtl());
	}

	/**
	 * This request runs INSIDE an IMAP login: HordeImapClient forces a refresh
	 * when a login is denied, then retries. No IMAP timeout covers it -- it is
	 * an outbound HTTPS call, and IClient::DEFAULT_REQUEST_TIMEOUT is 30
	 * seconds.
	 *
	 * Measured 2026-08-15: a deep-search reached 41.9s as a stack of
	 * individually-bounded steps, and this was the only one that could
	 * contribute thirty of them by itself.
	 */
	public function testTheTokenRefreshCannotOutlastTheLoginItIsRescuing(): void {
		$this->timeFactory->method('getTime')->willReturn(1000);
		$this->crypto->method('decrypt')->willReturnArgument(0);
		$this->crypto->method('encrypt')->willReturnArgument(0);
		$this->config->method('getAppValue')->willReturnMap([
			['mail', 'google_oauth_client_id', '', 'client-id'],
			['mail', 'google_oauth_client_secret', '', 'encrypted-client-secret'],
		]);
		$this->config->method('getSystemValueInt')->willReturnCallback(
			static fn (string $key, int $default = 0): int => $default,
		);
		$this->lockCache->method('add')->willReturn(true);

		$response = $this->createMock(IResponse::class);
		$response->method('getBody')->willReturn(json_encode([
			'access_token' => 'new-access-token',
			'refresh_token' => 'new-refresh-token',
			'expires_in' => 3600,
		]));
		$options = null;
		$httpClient = $this->createMock(\OCP\Http\Client\IClient::class);
		$httpClient->method('post')->willReturnCallback(
			function (string $url, array $opts) use (&$options, $response) {
				$options = $opts;
				return $response;
			},
		);
		$this->clientService->method('newClient')->willReturn($httpClient);

		$this->integration->refresh($this->accountAboutToExpire());

		self::assertArrayHasKey('timeout', $options, 'an unbounded refresh can add 30s to an IMAP login');
		self::assertLessThanOrEqual(10, $options['timeout']);
		self::assertArrayHasKey('connect_timeout', $options);
	}

	public function testSkipsTheRefreshWhenAnotherRequestAlreadyHoldsTheLock(): void {
		$this->timeFactory->method('getTime')->willReturn(1000);
		$this->lockCache->expects(self::once())
			->method('add')
			->with('google_account_13', true, 30)
			->willReturn(false);

		$this->clientService->expects(self::never())->method('newClient');

		$account = $this->accountAboutToExpire();
		$result = $this->integration->refresh($account);

		// Unchanged -- whichever request holds the lock will refresh it,
		// and this account picks up the new one on its own next request.
		self::assertSame('encrypted-old-access-token', $result->getMailAccount()->getOauthAccessToken());
	}

	public function testForcedRefreshDoesNotBypassAnotherRequestLock(): void {
		$this->timeFactory->method('getTime')->willReturn(1000);
		$this->lockCache->expects(self::once())
			->method('add')
			->with('google_account_13', true, 30)
			->willReturn(false);

		$this->clientService->expects(self::never())->method('newClient');

		$result = $this->integration->refresh($this->accountAboutToExpire(), true);

		self::assertSame('encrypted-old-access-token', $result->getMailAccount()->getOauthAccessToken());
	}

	public function testDoesNotEvenAttemptTheLockWhenTheTokenIsNotNearExpiry(): void {
		$this->timeFactory->method('getTime')->willReturn(1000);
		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setOauthRefreshToken('encrypted-refresh-token');
		$mailAccount->setOauthAccessToken('encrypted-old-access-token');
		// Far from expiring -- well outside the REFRESH_BUFFER_SECONDS window.
		$mailAccount->setOauthTokenTtl(100000);
		$account = new Account($mailAccount);

		$this->cacheFactory->expects(self::never())->method('createDistributed');
		$this->clientService->expects(self::never())->method('newClient');

		$this->integration->refresh($account);
	}

	/**
	 * Pins the actual fix: a token 4 minutes from expiry sat outside the
	 * old 60s buffer and was left completely untouched by refresh() until
	 * requests started falling inside that last minute -- exactly where,
	 * confirmed live, concurrent "losing" requests hold a token with
	 * under 60s (sometimes negative) declared validity left and get
	 * "Mail server denied authentication" from Gmail. 300s gives the
	 * winner's refresh time to land in the database before that point.
	 */
	public function testRefreshesWithinTheWidenedFiveMinuteBuffer(): void {
		$this->timeFactory->method('getTime')->willReturn(1000);
		$this->crypto->method('decrypt')->willReturnArgument(0);
		$this->crypto->method('encrypt')->willReturnArgument(0);
		$this->config->method('getAppValue')->willReturnMap([
			['mail', 'google_oauth_client_id', '', 'client-id'],
			['mail', 'google_oauth_client_secret', '', 'encrypted-client-secret'],
		]);
		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setOauthRefreshToken('encrypted-refresh-token');
		$mailAccount->setOauthAccessToken('encrypted-old-access-token');
		// 4 minutes (240s) from expiry: outside the old 60s buffer, inside
		// the new 300s one.
		$mailAccount->setOauthTokenTtl(1240);
		$account = new Account($mailAccount);

		$this->lockCache->expects(self::once())
			->method('add')
			->with('google_account_13', true, 30)
			->willReturn(true);

		$response = $this->createMock(IResponse::class);
		$response->method('getBody')->willReturn(json_encode([
			'access_token' => 'new-access-token',
			'refresh_token' => 'new-refresh-token',
			'expires_in' => 3600,
		]));
		$httpClient = $this->createMock(\OCP\Http\Client\IClient::class);
		$httpClient->expects(self::once())->method('post')->willReturn($response);
		$this->clientService->method('newClient')->willReturn($httpClient);

		$result = $this->integration->refresh($account);

		self::assertSame('new-access-token', $result->getMailAccount()->getOauthAccessToken());
	}
}
