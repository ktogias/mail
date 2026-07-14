<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2017 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Db;

use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\QBMapper;
use OCP\DB\Exception as DBException;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * @template-extends QBMapper<LocalAttachment>
 */
class LocalAttachmentMapper extends QBMapper {
	public function __construct(
		IDBConnection $db,
		private LoggerInterface $logger,
	) {
		parent::__construct($db, 'mail_attachments');
	}

	/**
	 * @return LocalAttachment[]
	 */
	public function findByLocalMessageId(string $userId, int $localMessageId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere(
				$qb->expr()->eq('local_message_id', $qb->createNamedParameter($localMessageId, IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT)
			);
		return $this->findEntities($qb);
	}

	/**
	 * @return LocalAttachment[]
	 */
	public function findByLocalMessageIds(array $localMessageIds): array {
		if ($localMessageIds === []) {
			return [];
		}
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->in('local_message_id', $qb->createNamedParameter($localMessageIds, IQueryBuilder::PARAM_INT_ARRAY), IQueryBuilder::PARAM_INT_ARRAY)
			);
		return $this->findEntities($qb);
	}

	/**
	 * @throws DoesNotExistException
	 */
	public function find(string $userId, int $id): LocalAttachment {
		$qb = $this->db->getQueryBuilder();
		$query = $qb
			->select('*')
			->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT));

		return $this->findEntity($query);
	}

	/**
	 * @throws Throwable
	 * @throws \OCP\DB\Exception
	 */
	public function deleteForLocalMessage(string $userId, int $localMessageId): void {
		$this->db->beginTransaction();
		try {
			$qb = $this->db->getQueryBuilder();
			$qb->delete($this->getTableName())
				->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
				->andWhere($qb->expr()->eq('local_message_id', $qb->createNamedParameter($localMessageId), IQueryBuilder::PARAM_INT));
			$qb->executeStatement();
			$this->db->commit();
		} catch (Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
	}

	/**
	 * @throws Throwable
	 * @throws DBException
	 */
	public function saveLocalMessageAttachments(string $userId, int $localMessageId, array $attachmentIds): void {
		$this->db->beginTransaction();
		try {
			$qb = $this->db->getQueryBuilder();
			$qb->update($this->getTableName())
				->set('local_message_id', $qb->createNamedParameter($localMessageId, IQueryBuilder::PARAM_INT))
				->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
				->andWhere(
					$qb->expr()->in('id', $qb->createNamedParameter($attachmentIds, IQueryBuilder::PARAM_INT_ARRAY), IQueryBuilder::PARAM_INT_ARRAY)
				);
			$qb->executeStatement();
			$this->db->commit();
		} catch (DBException $e) {
			$this->db->rollBack();
			if ($e->getReason() === DBException::REASON_FOREIGN_KEY_VIOLATION) {
				// The draft (the oc_mail_local_messages row $localMessageId
				// points at) no longer exists: it was deleted concurrently
				// by a competing request -- normally Send finishing (which
				// deletes the draft once the message is transmitted) while
				// this autosave was still in flight attaching the very same
				// draft's forwarded/inline attachments. Confirmed live: a
				// reply carrying 19 inline images from the original message
				// took 28-64s per autosave (each one re-fetched every image
				// over IMAP from scratch, see handleAttachments()'s own
				// caching fix for that), giving a wide window for the user
				// to hit Send before an older autosave finished. Even with
				// that fixed, any sufficiently slow network condition can
				// still open this same window, so this stays as a hard
				// guarantee rather than relying on the window staying
				// narrow. There is nothing left to attach to: this save
				// lost the race and is simply stale, not a real failure --
				// surfacing it to the user as a 500 would be misleading
				// (confirmed live: the message had already sent
				// successfully by the time this exception fired).
				$this->logger->debug('Dropped a stale attachment-linking update for local message {id}: the message no longer exists (likely superseded by a concurrent send)', [
					'id' => $localMessageId,
				]);
				return;
			}
			throw $e;
		} catch (Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
	}

	/**
	 * @return LocalAttachment[]
	 * @throws \OCP\DB\Exception
	 */
	public function findByIds(string $userId, array $attachmentIds): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere(
				$qb->expr()->in('id', $qb->createNamedParameter($attachmentIds, IQueryBuilder::PARAM_INT_ARRAY), IQueryBuilder::PARAM_INT_ARRAY)
			);
		return $this->findEntities($qb);
	}
}
