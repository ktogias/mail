<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Listener;

use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Events\MessageDeletedEvent;
use OCA\Mail\Events\MessageFlaggedEvent;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use Psr\Log\LoggerInterface;

/**
 * @template-implements IEventListener<Event>
 */
class MessageCacheUpdaterListener implements IEventListener {
	public function __construct(
		private MessageMapper $mapper,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if ($event instanceof MessageFlaggedEvent) {
			$message = $event->getMessage();
			$message->setFlag($event->getFlag(), $event->isSet());
			$this->mapper->update($message);

			// This row is now newer than any sync still holding a FETCH from
			// before the IMAP STORE that triggered this event. Record the
			// write so updateBulk() can tell that a contradicting fresh
			// reading is stale rather than a real external change --
			// see MessageMapper::shouldTrustFreshFlagReading().
			$this->mapper->recordLocalFlagWrite(
				$event->getMailbox()->getId(),
				$event->getUid(),
				$event->getFlag(),
				$event->isSet(),
			);
		} elseif ($event instanceof MessageDeletedEvent) {
			$this->mapper->deleteByUid(
				$event->getMailbox(),
				$event->getUid()
			);
		}
	}
}
