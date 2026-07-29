<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Controller;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Controller\MessageTasksController;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageTask;
use OCA\Mail\Db\MessageTaskMapper;
use OCA\Mail\Service\MailManager;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IRequest;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\NullLogger;

class MessageTasksControllerTest extends TestCase {
	/** @var MessageTaskMapper|MockObject */
	private $mapper;
	/** @var MailManager|MockObject */
	private $mailManager;
	private MessageTasksController $controller;

	protected function setUp(): void {
		parent::setUp();

		$this->mapper = $this->createMock(MessageTaskMapper::class);
		$this->mailManager = $this->createMock(MailManager::class);
		$timeFactory = $this->createMock(ITimeFactory::class);
		$timeFactory->method('getTime')->willReturn(1785600000);

		$this->controller = new MessageTasksController(
			'mail',
			$this->createMock(IRequest::class),
			'user',
			$this->mapper,
			$this->mailManager,
			$timeFactory,
			new NullLogger(),
		);
	}

	/**
	 * setThreadRootId(null) does NOT leave the root null -- it falls back to
	 * the message's own Message-ID, because a message with no references
	 * roots at itself. So the null case is reached by setting the root while
	 * the id is still unset, which is the shape a row read straight from the
	 * database can have: the column is nullable and predates that rule.
	 */
	private function message(string $messageId, ?string $threadRootId): Message {
		$message = new Message();
		$message->setId(42);
		if ($threadRootId === null) {
			$message->setThreadRootId(null);
			$message->setMessageId($messageId);
			return $message;
		}
		$message->setMessageId($messageId);
		$message->setThreadRootId($threadRootId);
		return $message;
	}

	public function testAsksForTheWholeThreadRatherThanOneMessage(): void {
		// The header chip is about the conversation, and a forty-message
		// thread must not mean forty requests -- that is the shape the index
		// exists to avoid in the first place.
		$this->mailManager->method('getMessage')->willReturn($this->message('<a@b>', '<root@b>'));
		$this->mapper->expects(self::once())
			->method('findByThreadRootId')
			->with('user', '<root@b>')
			->willReturn([]);
		$this->mapper->expects(self::never())->method('findByMessageId');

		$this->controller->index(42);
	}

	public function testFallsBackToTheMessageWhenItHasNoThreadRoot(): void {
		$this->mailManager->method('getMessage')->willReturn($this->message('<a@b>', null));
		$this->mapper->expects(self::once())
			->method('findByMessageId')
			->with('user', '<a@b>')
			->willReturn([]);

		$this->controller->index(42);
	}

	public function testAMessageThatIsGoneSimplyHasNoTasks(): void {
		// Consistent with the rest of the app: "gone" is an ordinary outcome,
		// not a fault. An error here would put a red toast on screen for a
		// decoration the user never asked for.
		$this->mailManager->method('getMessage')
			->willThrowException(new DoesNotExistException('gone'));

		$response = $this->controller->index(42);

		self::assertSame(Http::STATUS_OK, $response->getStatus());
		self::assertSame(['tasks' => []], $response->getData());
	}

	public function testIndexesATaskAgainstTheMessageId(): void {
		// The Message-ID, not the row id: the row id changes on a re-index and
		// the mailbox id changes when the message is filed elsewhere, and the
		// indicator has to survive both.
		$this->mailManager->method('getMessage')->willReturn($this->message('<a@b>', '<root@b>'));
		$this->mapper->expects(self::once())
			->method('insert')
			->with(self::callback(static function (MessageTask $task): bool {
				return $task->getMessageId() === '<a@b>'
					&& $task->getThreadRootId() === '<root@b>'
					&& $task->getCalendarUri() === 'personal'
					&& $task->getTaskUid() === 'uid-1'
					// The CalDAV object name, which is a DIFFERENT string from
					// the UID and is the one the Tasks app routes on.
					&& $task->getTaskUri() === '85D8FD67.ics'
					&& $task->getSummary() === 'Pay the invoice'
					&& $task->getUserId() === 'user';
			}))
			->willReturnArgument(0);

		$response = $this->controller->create(42, 'personal', 'uid-1', 'Pay the invoice', '85D8FD67.ics');

		self::assertSame(Http::STATUS_CREATED, $response->getStatus());
	}

	public function testKeepsIndexingWhenTheObjectNameIsUnknown(): void {
		// Nothing sends it yet from an older client, and a missing name is not
		// a reason to lose the indicator: the reader falls back to <uid>.ics.
		$this->mailManager->method('getMessage')->willReturn($this->message('<a@b>', '<root@b>'));
		$this->mapper->expects(self::once())
			->method('insert')
			->with(self::callback(static function (MessageTask $task): bool {
				return $task->getTaskUri() === null;
			}))
			->willReturnArgument(0);

		$response = $this->controller->create(42, 'personal', 'uid-1', 'Pay the invoice', '  ');

		self::assertSame(Http::STATUS_CREATED, $response->getStatus());
	}

	public function testRefusesToIndexAMessageWithNoMessageId(): void {
		// Better no indicator than one keyed on something a re-index
		// invalidates -- a chip that leads nowhere is worse than no chip.
		$this->mailManager->method('getMessage')->willReturn($this->message('', null));
		$this->mapper->expects(self::never())->method('insert');

		$response = $this->controller->create(42, 'personal', 'uid-1');

		self::assertSame(Http::STATUS_UNPROCESSABLE_ENTITY, $response->getStatus());
	}

	public function testRejectsAnEmptyCalendarOrTask(): void {
		$this->mapper->expects(self::never())->method('insert');

		self::assertSame(Http::STATUS_BAD_REQUEST, $this->controller->create(42, '', 'uid-1')->getStatus());
		self::assertSame(Http::STATUS_BAD_REQUEST, $this->controller->create(42, 'personal', ' ')->getStatus());
	}

	public function testForgetsATaskThatTurnedOutToBeGone(): void {
		// Nothing tells this app when a task is deleted in the Tasks app, so a
		// dangling row is normal and following the link is the only way we
		// ever find out. Cleaning up then is what keeps the chip honest.
		$this->mapper->expects(self::once())
			->method('deleteByTaskUid')
			->with('user', 'uid-1');

		$this->controller->destroy('uid-1');
	}
}
