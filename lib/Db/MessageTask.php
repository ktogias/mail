<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Db;

use JsonSerializable;
use OCP\AppFramework\Db\Entity;

/**
 * A task made from a message, indexed so the message can find it again.
 *
 * The authoritative link is the VTODO's URL property; this is only the reverse
 * index, because CalDAV cannot be asked "what points at this message". See
 * Migration\Version5011Date20260729180000 for why it is keyed on the Message-ID.
 *
 * @method string getUserId()
 * @method void setUserId(string $value)
 * @method string getMessageId()
 * @method void setMessageId(string $value)
 * @method string|null getThreadRootId()
 * @method void setThreadRootId(string|null $value)
 * @method string getCalendarUri()
 * @method void setCalendarUri(string $value)
 * @method string getTaskUid()
 * @method void setTaskUid(string $value)
 * @method string|null getTaskUri()
 * @method void setTaskUri(string|null $value)
 * @method string|null getSummary()
 * @method void setSummary(string|null $value)
 * @method int getCreatedAt()
 * @method void setCreatedAt(int $value)
 */
class MessageTask extends Entity implements JsonSerializable {
	protected $userId;
	protected $messageId;
	protected $threadRootId;
	protected $calendarUri;
	protected $taskUid;
	protected $taskUri;
	protected $summary;
	protected $createdAt;

	public function __construct() {
		$this->addType('createdAt', 'integer');
	}

	public function jsonSerialize(): array {
		return [
			'id' => $this->getId(),
			// The browser matches these against the envelopes it already has,
			// so it never needs a second request to decide which message in a
			// thread carries the chip.
			'messageId' => $this->getMessageId(),
			'threadRootId' => $this->getThreadRootId(),
			'calendarUri' => $this->getCalendarUri(),
			'taskUid' => $this->getTaskUid(),
			// The CalDAV object name, `.ics` included. This -- not the UID --
			// is what the Tasks app routes on. Null on rows written before
			// Version5011Date20260730020000; see that migration.
			'taskUri' => $this->getTaskUri(),
			'summary' => $this->getSummary(),
			'createdAt' => $this->getCreatedAt(),
		];
	}
}
