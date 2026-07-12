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
		// Within the 60s grace window refresh() checks -- "now" is
		// mocked to 1000 below, so this is already inside it.
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

	public function testSkipsTheRefreshWhenAnotherRequestAlreadyHoldsTheLock(): void {
		$this->timeFactory->method('getTime')->willReturn(1000);
		$this->lockCache->expects(self::once())
			->method('add')
			->with('google_account_13', true, 30)
			->willReturn(false);

		$this->clientService->expects(self::never())->method('newClient');

		$account = $this->accountAboutToExpire();
		$result = $this->integration->refresh($account);

		// Unchanged -- the token this request already had is still
		// valid for the 60s grace period; whichever request holds the
		// lock will refresh it, and this account picks up the new one on
		// its own next request.
		self::assertSame('encrypted-old-access-token', $result->getMailAccount()->getOauthAccessToken());
	}

	public function testDoesNotEvenAttemptTheLockWhenTheTokenIsNotNearExpiry(): void {
		$this->timeFactory->method('getTime')->willReturn(1000);
		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setOauthRefreshToken('encrypted-refresh-token');
		$mailAccount->setOauthAccessToken('encrypted-old-access-token');
		// Far from expiring -- well outside the 60s grace window.
		$mailAccount->setOauthTokenTtl(100000);
		$account = new Account($mailAccount);

		$this->cacheFactory->expects(self::never())->method('createDistributed');
		$this->clientService->expects(self::never())->method('newClient');

		$this->integration->refresh($account);
	}
}
