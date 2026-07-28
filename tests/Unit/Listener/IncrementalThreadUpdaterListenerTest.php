<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Listener;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IUserPreferences;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Events\NewMessagesSynchronized;
use OCA\Mail\IMAP\Threading\DatabaseMessage;
use OCA\Mail\IMAP\Threading\ThreadBuilder;
use OCA\Mail\Listener\IncrementalThreadUpdaterListener;
use OCA\Mail\Support\PerformanceLogger;
use OCP\AppFramework\Utility\ITimeFactory;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class IncrementalThreadUpdaterListenerTest extends TestCase {
	/** @var MessageMapper|MockObject */
	private $mapper;
	/** @var IUserPreferences|MockObject */
	private $preferences;
	private IncrementalThreadUpdaterListener $listener;
	private Account $account;

	protected function setUp(): void {
		parent::setUp();

		$this->mapper = $this->createMock(MessageMapper::class);
		$this->preferences = $this->createMock(IUserPreferences::class);
		$this->preferences->method('getPreference')->willReturn('threaded');

		$this->listener = new IncrementalThreadUpdaterListener(
			$this->mapper,
			new ThreadBuilder(new PerformanceLogger(
				$this->createMock(ITimeFactory::class),
				$this->createMock(LoggerInterface::class),
			)),
			$this->preferences,
			new NullLogger(),
		);

		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setUserId('user');
		$this->account = new Account($mailAccount);
	}

	private function newMessage(int $id, string $messageId, ?string $inReplyTo, array $references): Message {
		$message = new Message();
		$message->setId($id);
		$message->setSubject('Re: Budget');
		$message->setMessageId($messageId);
		$message->setInReplyTo($inReplyTo);
		$message->setReferences(json_encode($references));
		return $message;
	}

	private function event(Message ...$messages): NewMessagesSynchronized {
		return new NewMessagesSynchronized($this->account, new Mailbox(), $messages);
	}

	public function testThreadsTheClosureOfTheBatchInsteadOfTheAccount(): void {
		$new = $this->newMessage(3, '<a3>', '<a2>', ['<a1>', '<a2>']);

		$this->mapper->expects(self::once())
			->method('findThreadRootsOfMessageIds')
			->with($this->account, ['<a1>', '<a2>'])
			->willReturn(['<a1>']);
		// Both the reachable thread and the batch's own id, never the account.
		$this->mapper->expects(self::once())
			->method('findThreadingDataForRoots')
			->with($this->account, ['<a1>', '<a3>'])
			->willReturn([
				DatabaseMessage::fromRowData(2, 'Re: Budget', '<a2>', json_encode(['<a1>']), '<a1>', '<a1>'),
				DatabaseMessage::fromRowData(3, 'Re: Budget', '<a3>', json_encode(['<a1>', '<a2>']), '<a2>', '<a3>'),
			]);
		$this->mapper->expects(self::never())->method('findThreadingData');
		$this->mapper->expects(self::once())
			->method('writeThreadIds')
			->with(self::callback(static function (array $written): bool {
				foreach ($written as $message) {
					if ($message->getThreadRootId() !== '<a1>') {
						return false;
					}
				}
				return $written !== [];
			}));

		$this->listener->handle($this->event($new));
	}

	public function testIgnoresMessagesThatCannotChangeAnyThread(): void {
		// No in-reply-to and no references: rooted at itself, which is what
		// the insert already wrote, and what findThreadingData() excludes from
		// the full rebuild for the same reason. Doing work here would be
		// per-message cost for no possible change.
		$standalone = $this->newMessage(9, '<s1>', null, []);

		$this->mapper->expects(self::never())->method('findThreadRootsOfMessageIds');
		$this->mapper->expects(self::never())->method('findThreadingDataForRoots');
		$this->mapper->expects(self::never())->method('writeThreadIds');

		$this->listener->handle($this->event($standalone));
	}

	public function testDoesNothingForAFlatView(): void {
		$preferences = $this->createMock(IUserPreferences::class);
		$preferences->method('getPreference')->willReturn('singleton');
		$listener = new IncrementalThreadUpdaterListener(
			$this->mapper,
			new ThreadBuilder(new PerformanceLogger(
				$this->createMock(ITimeFactory::class),
				$this->createMock(LoggerInterface::class),
			)),
			$preferences,
			new NullLogger(),
		);

		$this->mapper->expects(self::never())->method('findThreadRootsOfMessageIds');
		$this->mapper->expects(self::never())->method('writeThreadIds');

		$listener->handle($this->event($this->newMessage(3, '<a3>', '<a2>', ['<a2>'])));
	}
}
