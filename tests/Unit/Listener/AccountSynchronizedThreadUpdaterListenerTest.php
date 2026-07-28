<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Listener;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\AppInfo\Application;
use OCA\Mail\Contracts\IUserPreferences;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Events\SynchronizationEvent;
use OCA\Mail\IMAP\Threading\ThreadBuilder;
use OCA\Mail\Listener\AccountSynchronizedThreadUpdaterListener;
use OCA\Mail\Support\PerformanceLogger;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IConfig;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * The full rebuild is the reconciliation pass now, not the hot path.
 *
 * IncrementalThreadUpdaterListener threads each batch against the threads it
 * can reach, which is exact for everything except ThreadBuilder's step 5 --
 * subject-only merges between threads that reference nothing of each other.
 * This listener is what eventually catches those, so it must still run, just
 * not on every sync: it cost 274MB and ~6s per sync of a 169,970-message
 * account, inside whichever request happened to trigger it.
 *
 * The live deploy never exercised the interval itself -- the syncs that
 * followed it exited earlier, at the pre-existing "no significant changes"
 * guard -- so the behaviour is pinned here rather than assumed from the
 * absence of rebuilds in a log.
 */
class AccountSynchronizedThreadUpdaterListenerTest extends TestCase {
	private const NOW = 1785280257;

	/** @var MessageMapper|MockObject */
	private $mapper;
	/** @var IConfig|MockObject */
	private $config;
	private AccountSynchronizedThreadUpdaterListener $listener;
	private Account $account;

	protected function setUp(): void {
		parent::setUp();

		$this->mapper = $this->createMock(MessageMapper::class);
		$this->config = $this->createMock(IConfig::class);

		$preferences = $this->createMock(IUserPreferences::class);
		$preferences->method('getPreference')->willReturn('threaded');

		$timeFactory = $this->createMock(ITimeFactory::class);
		$timeFactory->method('getTime')->willReturn(self::NOW);

		$this->listener = new AccountSynchronizedThreadUpdaterListener(
			$preferences,
			$this->mapper,
			new ThreadBuilder(new PerformanceLogger(
				$this->createMock(ITimeFactory::class),
				$this->createMock(LoggerInterface::class),
			)),
			$this->config,
			$timeFactory,
		);

		$mailAccount = new MailAccount();
		$mailAccount->setId(13);
		$mailAccount->setUserId('user');
		$this->account = new Account($mailAccount);
	}

	private function event(bool $backgroundSync = true): SynchronizationEvent {
		return new SynchronizationEvent($this->account, new NullLogger(), true, $backgroundSync);
	}

	public function testNeverRebuildsInsideABrowserRequest(): void {
		// The web path syncs one mailbox at a time and dispatches without the
		// flag. Loading every message of the account there is what put 274MB
		// and ~6s inside a request someone was waiting on.
		$this->config->method('getAppValue')->willReturn('0');
		$this->mapper->expects(self::never())->method('findThreadingData');
		$this->config->expects(self::never())->method('setAppValue');

		$this->listener->handle($this->event(false));
	}

	public function testSkipsTheRebuildWhenItReconciledRecently(): void {
		$this->config->method('getAppValue')
			->with(Application::APP_ID, 'threads-rebuilt-at-13', '0')
			->willReturn((string)(self::NOW - 3600));

		$this->mapper->expects(self::never())->method('findThreadingData');
		$this->config->expects(self::never())->method('setAppValue');

		$this->listener->handle($this->event());
	}

	public function testRebuildsOnceTheIntervalHasElapsed(): void {
		$this->config->method('getAppValue')
			->willReturn((string)(self::NOW - 25 * 60 * 60));
		$this->mapper->expects(self::once())
			->method('findThreadingData')
			->willReturn([]);
		// Recorded so the next sync inside the window skips.
		$this->config->expects(self::once())
			->method('setAppValue')
			->with(Application::APP_ID, 'threads-rebuilt-at-13', (string)self::NOW);

		$this->listener->handle($this->event());
	}

	public function testRebuildsWhenItHasNeverRun(): void {
		$this->config->method('getAppValue')->willReturn('0');
		$this->mapper->expects(self::once())->method('findThreadingData')->willReturn([]);

		$this->listener->handle($this->event());
	}

	public function testDoesNotRecordATimestampWhenTheRebuildFails(): void {
		// Otherwise one failure buys a whole day of not trying again, and the
		// subject-only merges stay unreconciled with nothing saying so.
		$this->config->method('getAppValue')->willReturn('0');
		$this->mapper->method('findThreadingData')
			->willThrowException(new \RuntimeException('database went away'));
		$this->config->expects(self::never())->method('setAppValue');

		$this->expectException(\RuntimeException::class);
		$this->listener->handle($this->event());
	}
}
