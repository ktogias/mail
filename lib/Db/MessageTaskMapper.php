<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Db;

use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use function array_values;

/** @template-extends QBMapper<MessageTask> */
class MessageTaskMapper extends QBMapper {
	public function __construct(IDBConnection $db) {
		parent::__construct($db, 'mail_message_tasks', MessageTask::class);
	}

	/**
	 * Every task made from any message in a thread.
	 *
	 * One query per thread rather than one per message: a long conversation is
	 * exactly the case this index exists for, and forty round trips to render
	 * a header chip would be worse than not having the feature.
	 *
	 * @return MessageTask[]
	 */
	public function findByThreadRootId(string $userId, string $threadRootId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->eq('user_id', $qb->createNamedParameter($userId)),
				$qb->expr()->eq('thread_root_id', $qb->createNamedParameter($threadRootId)),
			)
			->orderBy('created_at', 'ASC');
		return $this->findEntities($qb);
	}

	/**
	 * The fallback for a message with no thread root of its own.
	 *
	 * @return MessageTask[]
	 */
	public function findByMessageId(string $userId, string $messageId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->eq('user_id', $qb->createNamedParameter($userId)),
				$qb->expr()->eq('message_id', $qb->createNamedParameter($messageId)),
			)
			->orderBy('created_at', 'ASC');
		return $this->findEntities($qb);
	}

	public function deleteByTaskUid(string $userId, string $taskUid): void {
		$qb = $this->db->getQueryBuilder();
		$qb->delete($this->getTableName())
			->where(
				$qb->expr()->eq('user_id', $qb->createNamedParameter($userId)),
				$qb->expr()->eq('task_uid', $qb->createNamedParameter($taskUid)),
			);
		$qb->executeStatement();
	}

	/**
	 * @param string[] $threadRootIds
	 * @return MessageTask[]
	 */
	public function findByThreadRootIds(string $userId, array $threadRootIds): array {
		if ($threadRootIds === []) {
			return [];
		}
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->eq('user_id', $qb->createNamedParameter($userId)),
				$qb->expr()->in('thread_root_id', $qb->createNamedParameter($threadRootIds, IQueryBuilder::PARAM_STR_ARRAY)),
			);
		return array_values($this->findEntities($qb));
	}
}
