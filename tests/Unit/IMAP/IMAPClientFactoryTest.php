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
use OCA\Mail\IMAP\ImapWorkClass;
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

	/**
	 * The idle timeout reaches stream_set_timeout(), so it bounds any single
	 * read -- but not the sum. A request that connects, is refused, refreshes
	 * its token, logs in again, SELECTs and SEARCHes spends up to that long at
	 * each step: measured 2026-08-15, one deep-search reached 41.9s that way
	 * and the client abandoned it around 40s.
	 *
	 * So the patience is spent where someone is waiting for it. A body search
	 * is not: its header results are already on screen in ~100ms.
	 *
	 * @dataProvider interactiveCallerProvider
	 */
	public function testOnlyWorkAUserWaitsOnKeepsTheFullIdleTimeout(bool $allowReservedSlot, ?string $workClass, bool $expected): void {
		self::assertSame(
			$expected,
			IMAPClientFactory::isInteractiveCaller($allowReservedSlot, $workClass),
		);
	}

	public function interactiveCallerProvider(): array {
		return [
			'a mutation the user triggered' => [false, ImapWorkClass::QUICK_MUTATION, true],
			'an explicitly reserved slot' => [true, null, true],
			'active content' => [false, ImapWorkClass::ACTIVE_CONTENT, true],
			'background maintenance' => [false, ImapWorkClass::MAINTENANCE, false],
			'unclassified' => [false, null, false],
		];
	}

	/**
	 * @param array<string, int> $configured
	 * @return array{int, int}
	 */
	private function timeouts(bool $interactive, array $configured = []): array {
		$config = $this->createMock(IConfig::class);
		$config->method('getSystemValue')->willReturnCallback(
			static fn (string $key, $default) => $configured[$key] ?? $default,
		);

		$reflection = new ReflectionClass(IMAPClientFactory::class);
		/** @var IMAPClientFactory $factory */
		$factory = $reflection->newInstanceWithoutConstructor();
		$reflection->getProperty('config')->setValue($factory, $config);

		return $factory->resolveTimeouts($interactive);
	}

	/**
	 * Horde spends `timeout` on the connect, on stream_set_timeout() and on its
	 * literal-read loop -- but it is a POLL INTERVAL, not a deadline: a read
	 * that times out mid-command is tolerated for as long as the total stays
	 * under `read_timeout`. The connect and AUTHENTICATE phase gets no such
	 * tolerance, so a `timeout` too small for a TLS handshake desynchronises
	 * the stream and surfaces as a bogus "Mail server denied authentication".
	 *
	 * That is what a 2s background `timeout` did here for nine days, while
	 * buying no impatience at all -- `read_timeout` was never set, so the real
	 * deadline stayed at Horde's 120s default.
	 */
	public function testTheConnectTimeoutLeavesRoomForAHandshakeForEveryCaller(): void {
		[$interactiveConnect] = $this->timeouts(true);
		[$backgroundConnect] = $this->timeouts(false);

		self::assertSame($interactiveConnect, $backgroundConnect, 'the handshake costs the same whoever asked for it');
		self::assertGreaterThanOrEqual(10, $backgroundConnect, 'a TLS handshake against a slow provider must fit');
	}

	public function testImpatienceIsExpressedAsAReadDeadlineNotAConnectTimeout(): void {
		[, $interactiveRead] = $this->timeouts(true);
		[, $backgroundRead] = $this->timeouts(false);

		self::assertLessThan($interactiveRead, $backgroundRead, 'work nobody waits on gives up sooner');
		self::assertLessThan(120, $interactiveRead, 'still below the Horde default it replaces');
	}

	/**
	 * Horde only consults `read_timeout` once a `timeout` has fired, so a read
	 * deadline shorter than one poll could never be enforced.
	 */
	public function testAReadDeadlineIsNeverShorterThanASinglePoll(): void {
		[$connect, $read] = $this->timeouts(false, ['app.mail.imap.background-timeout' => 1]);

		self::assertSame($connect, $read);
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
