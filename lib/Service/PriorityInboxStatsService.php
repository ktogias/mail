<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service;

use Horde_Imap_Client;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\MessageMapper;

/**
 * Builds Priority Inbox overview counters entirely from the local database.
 *
 * In particular this service intentionally uses MailboxMapper directly:
 * MailManager::getMailboxes() can reconcile against IMAP, which would turn a
 * lightweight UI summary into another network fan-out.
 */
class PriorityInboxStatsService {
	public function __construct(
		private AccountService $accountService,
		private MailboxMapper $mailboxMapper,
		private MessageMapper $messageMapper,
	) {
	}

	/**
	 * @return array{
	 *     sections: array{
	 *         favorite: array{total: int, unread: int},
	 *         important: array{total: int, unread: int},
	 *         other: array{total: int, unread: int}
	 *     },
	 *     complete: bool
	 * }
	 */
	public function getStats(string $userId, bool $threaded, bool $sortFavorites): array {
		$accounts = [
			...$this->accountService->findByUserId($userId),
			...$this->accountService->findDelegatedAccounts($userId),
		];

		$mailboxIds = [];
		$complete = true;
		foreach ($accounts as $account) {
			foreach ($this->mailboxMapper->findAll($account) as $mailbox) {
				if (!$mailbox->isSpecialUse(Horde_Imap_Client::SPECIALUSE_INBOX) && !$mailbox->isInbox()) {
					continue;
				}
				$mailboxIds[] = $mailbox->getId();
				$complete = $complete && $mailbox->isCached();
			}
		}

		return [
			'sections' => $this->messageMapper->getPriorityInboxStats($mailboxIds, $threaded, $sortFavorites),
			'complete' => $complete,
		];
	}
}
