<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Contracts;

use OCA\Mail\Account;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Service\Search\SearchQuery;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\IUser;

interface IMailSearch {
	public const ORDER_NEWEST_FIRST = 'DESC';
	public const ORDER_OLDEST_FIRST = 'ASC';
	public const VIEW_SINGLETON = 'singleton';
	public const VIEW_THREADED = 'threaded';
	/**
	 * @throws DoesNotExistException
	 * @throws ClientException
	 * @throws ServiceException
	 */
	public function findMessage(Account $account,
		Mailbox $mailbox,
		Message $message): Message;

	/**
	 * @param Account $account
	 * @param Mailbox $mailbox
	 * @param string $sortOrder
	 * @param string|null $filter
	 * @param int|null $cursor
	 * @param int|null $limit
	 * @param string|null $userId
	 * @param string|null $view
	 * @param bool $prioritySplit return an exact page for each Priority Inbox section
	 * @param int|null $cursorId database-id tie breaker for the timestamp cursor
	 *
	 * @return Message[]
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	public function findMessages(Account $account,
		Mailbox $mailbox,
		string $sortOrder,
		?string $filter,
		?int $cursor,
		?int $limit,
		?string $userId,
		?string $view,
		bool $prioritySplit = false,
		?int $cursorId = null): array;

	/**
	 * Run a search through all mailboxes of a user.
	 *
	 * @return Message[]
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	public function findMessagesGlobally(IUser $user, SearchQuery $query, ?int $limit): array;

	/**
	 * Which of a search's free-text words match nothing in this mailbox.
	 *
	 * Only meaningful for a search that returned nothing: the words are
	 * ANDed, so an empty list never says which word was responsible, and a
	 * user cannot tell a typo from a word that is only in a message body from
	 * a word whose accents or capitalisation differ from what they typed.
	 *
	 * @return string[] a subset of the query's free-text words, in the order
	 *                  they were typed; empty when every word matches
	 *                  something and only their combination does not
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	public function findUnmatchedTexts(Mailbox $mailbox,
		?string $filter,
		?string $view): array;
}
