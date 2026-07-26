<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Listener;

use ChristophWurst\Nextcloud\Testing\ServiceMockObject;
use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\Tag;
use OCA\Mail\Events\MessageFlaggedEvent;
use OCA\Mail\Listener\MessageCacheUpdaterListener;
use OCP\EventDispatcher\Event;

class MessageCacheUpdaterListenerTest extends TestCase {
	/** @var ServiceMockObject */
	private $serviceMock;

	/** @var MessageCacheUpdaterListener */
	private $listener;

	protected function setUp(): void {
		parent::setUp();

		$this->serviceMock = $this->createServiceMock(MessageCacheUpdaterListener::class);
		$this->listener = $this->serviceMock->getService();
	}

	public function testHandleUnrelated() {
		$event = new Event();
		$this->serviceMock->getParameter('mapper')
			->expects($this->never())
			->method('deleteByUid');

		$this->listener->handle($event);
	}

	public function testHandleMessageFlaggedNotCached() {
		$account = $this->createStub(Account::class);
		$mailbox = $this->createStub(Mailbox::class);
		$event = new MessageFlaggedEvent(
			$account,
			$mailbox,
			123,
			Tag::LABEL_IMPORTANT,
			true
		);
		$this->serviceMock->getParameter('mapper')
			->expects($this->once())
			->method('findByUids')
			->with($event->getMailbox(), [123])
			->willReturn([]);
		$this->serviceMock->getParameter('mapper')
			->expects($this->never())
			->method('update');

		$this->listener->handle($event);
	}

	public function testHandleMessageFlagged() {
		$account = $this->createStub(Account::class);
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$event = new MessageFlaggedEvent(
			$account,
			$mailbox,
			123,
			'$junk',
			true
		);
		$message = new Message();
		$this->serviceMock->getParameter('mapper')
			->expects($this->once())
			->method('findByUids')
			->with($event->getMailbox(), [123])
			->willReturn([$message]);
		$this->serviceMock->getParameter('mapper')
			->expects($this->once())
			->method('update')
			->with($message);

		$this->listener->handle($event);

		$this->assertTrue($message->getFlagJunk());
	}

	/**
	 * The row this listener just wrote is newer than any sync still holding
	 * a FETCH from before the IMAP STORE. Recording the write is what lets
	 * MessageMapper::updateBulk() tell a stale contradicting reading from a
	 * real external change -- without it, marking a message read is silently
	 * reverted by whichever partial sync happens to land next.
	 */
	public function testHandleMessageFlaggedRecordsTheLocalWrite() {
		$account = $this->createStub(Account::class);
		// A real entity, not a stub: Mailbox::getId() is a magic
		// __call() accessor that PHPUnit cannot configure.
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$event = new MessageFlaggedEvent(
			$account,
			$mailbox,
			123,
			'seen',
			true
		);
		$message = new Message();
		$this->serviceMock->getParameter('mapper')
			->expects($this->once())
			->method('findByUids')
			->willReturn([$message]);
		$this->serviceMock->getParameter('mapper')
			->expects($this->once())
			->method('recordLocalFlagWrite')
			->with(149, 123, 'seen', true);

		$this->listener->handle($event);

		$this->assertTrue($message->getFlagSeen());
	}
}
