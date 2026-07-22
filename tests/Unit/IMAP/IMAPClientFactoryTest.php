<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\IMAP;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCP\IConfig;
use ReflectionClass;

class IMAPClientFactoryTest extends TestCase {
	private function account(
		int $id = 13,
		string $host = 'imap.gmail.com',
		string $user = 'user@example.com',
		string $authMethod = 'xoauth2',
		string $accessToken = 'encrypted-access-token',
		string $password = 'encrypted-password',
	): Account {
		$mailAccount = new MailAccount();
		$mailAccount->setId($id);
		$mailAccount->setInboundHost($host);
		$mailAccount->setInboundPort(993);
		$mailAccount->setInboundSslMode('ssl');
		$mailAccount->setInboundUser($user);
		$mailAccount->setAuthMethod($authMethod);
		$mailAccount->setOauthAccessToken($accessToken);
		$mailAccount->setInboundPassword($password);
		return new Account($mailAccount);
	}

	private function rateLimiterHash(Account $account): string {
		$config = $this->createMock(IConfig::class);
		$config->expects(self::once())
			->method('getSystemValueString')
			->with('secret')
			->willReturn('instance-secret');

		$reflection = new ReflectionClass(IMAPClientFactory::class);
		/** @var IMAPClientFactory $factory */
		$factory = $reflection->newInstanceWithoutConstructor();
		$reflection->getProperty('config')->setValue($factory, $config);
		$method = $reflection->getMethod('buildRateLimiterHash');

		return $method->invoke($factory, $account);
	}

	public function testRateLimiterHashIsStableAcrossCredentialRotation(): void {
		$before = $this->rateLimiterHash($this->account(
			accessToken: 'encrypted-old-access-token',
			password: 'encrypted-old-password',
		));
		$after = $this->rateLimiterHash($this->account(
			accessToken: 'encrypted-new-access-token',
			password: 'encrypted-new-password',
		));

		self::assertSame($before, $after);
	}

	public function testRateLimiterHashSeparatesAccountsAndEndpoints(): void {
		$baseline = $this->rateLimiterHash($this->account());

		self::assertNotSame($baseline, $this->rateLimiterHash($this->account(id: 14)));
		self::assertNotSame($baseline, $this->rateLimiterHash($this->account(host: 'imap.example.com')));
		self::assertNotSame($baseline, $this->rateLimiterHash($this->account(user: 'other@example.com')));
		self::assertNotSame($baseline, $this->rateLimiterHash($this->account(authMethod: 'password')));
	}
}
