<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Db;

use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/** @template-extends QBMapper<SearchJob> */
class SearchJobMapper extends QBMapper {
	public function __construct(IDBConnection $db) {
		parent::__construct($db, 'mail_search_jobs', SearchJob::class);
	}

	public function findById(int $id): SearchJob {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)));
		return $this->findEntity($qb);
	}

	public function findForUser(int $id, string $userId): SearchJob {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)),
				$qb->expr()->eq('user_id', $qb->createNamedParameter($userId)),
			);
		return $this->findEntity($qb);
	}

	public function findByJobKey(string $jobKey): SearchJob {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where($qb->expr()->eq('job_key', $qb->createNamedParameter($jobKey)));
		return $this->findEntity($qb);
	}

	public function requestCancel(int $id, string $userId, int $now): bool {
		$qb = $this->db->getQueryBuilder();
		$updated = $qb->update($this->getTableName())
			->set('cancel_requested', $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL))
			->set('status', $qb->createNamedParameter(SearchJob::STATUS_CANCELLED))
			->set('updated_at', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT))
			->where(
				$qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)),
				$qb->expr()->eq('user_id', $qb->createNamedParameter($userId)),
				$qb->expr()->notIn('status', $qb->createNamedParameter([
					SearchJob::STATUS_COMPLETE,
					SearchJob::STATUS_FAILED,
					SearchJob::STATUS_CANCELLED,
				], IQueryBuilder::PARAM_STR_ARRAY)),
			)
			->executeStatement();
		return $updated > 0;
	}

	/**
	 * Store a worker transition only while cancellation is still false.
	 * This prevents a late chunk from resurrecting a cancelled job.
	 */
	public function storeWorkerState(SearchJob $job): bool {
		$qb = $this->db->getQueryBuilder();
		$updated = $qb->update($this->getTableName())
			->set('status', $qb->createNamedParameter($job->getStatus()))
			->set('cursor_at', $qb->createNamedParameter($job->getCursorAt(), $job->getCursorAt() === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_INT))
			->set('cursor_id', $qb->createNamedParameter($job->getCursorId(), $job->getCursorId() === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_INT))
			->set('next_end', $qb->createNamedParameter($job->getNextEnd(), IQueryBuilder::PARAM_INT))
			->set('searched_through', $qb->createNamedParameter($job->getSearchedThrough(), IQueryBuilder::PARAM_INT))
			->set('result_count', $qb->createNamedParameter($job->getResultCount(), IQueryBuilder::PARAM_INT))
			->set('chunks_done', $qb->createNamedParameter($job->getChunksDone(), IQueryBuilder::PARAM_INT))
			->set('result_payload', $qb->createNamedParameter($job->getResultPayload(), $job->getResultPayload() === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_STR))
			->set('exhausted', $qb->createNamedParameter($job->getExhausted(), IQueryBuilder::PARAM_BOOL))
			->set('error_code', $qb->createNamedParameter($job->getErrorCode(), $job->getErrorCode() === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_STR))
			->set('updated_at', $qb->createNamedParameter($job->getUpdatedAt(), IQueryBuilder::PARAM_INT))
			->set('expires_at', $qb->createNamedParameter($job->getExpiresAt(), IQueryBuilder::PARAM_INT))
			->where(
				$qb->expr()->eq('id', $qb->createNamedParameter($job->getId(), IQueryBuilder::PARAM_INT)),
				$qb->expr()->eq('cancel_requested', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL)),
			)
			->executeStatement();
		return $updated > 0;
	}

	public function deleteExpired(int $now): int {
		$qb = $this->db->getQueryBuilder();
		return $qb->delete($this->getTableName())
			->where($qb->expr()->lt('expires_at', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT)))
			->executeStatement();
	}
}
