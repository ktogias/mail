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

	public function testHandleMessageFlagged() {
		$account = $this->createStub(Account::class);
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$message = new Message();
		$message->setUid(123);
		$event = new MessageFlaggedEvent(
			$account,
			$mailbox,
			$message,
			'$junk',
			true
		);
		$this->serviceMock->getParameter('mapper')
			->expects($this->once())
			->method('update')
			->with($message);

		$this->listener->handle($event);

		$this->assertTrue($message->getFlagJunk());
	}

	public function testHandleMessageFlaggedTag() {
		$account = $this->createStub(Account::class);
		$mailbox = new Mailbox();
		$mailbox->setId(149);
		$message = new Message();
		$message->setUid(123);
		$event = new MessageFlaggedEvent(
			$account,
			$mailbox,
			$message,
			Tag::LABEL_IMPORTANT,
			true
		);
		$this->serviceMock->getParameter('mapper')
			->expects($this->once())
			->method('update')
			->with($message);

		$this->listener->handle($event);
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
		$message = new Message();
		$message->setUid(123);
		// Upstream carries the resolved Message on the event now, so the
		// listener no longer fetches it -- only the local-write record is
		// still the fork's own.
		$event = new MessageFlaggedEvent(
			$account,
			$mailbox,
			$message,
			'seen',
			true
		);
		$this->serviceMock->getParameter('mapper')
			->expects($this->once())
			->method('update')
			->with($message);
		$this->serviceMock->getParameter('mapper')
			->expects($this->once())
			->method('recordLocalFlagWrite')
			->with(149, 123, 'seen', true);

		$this->listener->handle($event);

		$this->assertTrue($message->getFlagSeen());
	}
}
