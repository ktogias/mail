<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;
use OCP\IDBConnection;
use Throwable;

/**
 * Removes the deep-search job store. Deep search is stateless now.
 *
 * What the table was for: a background job walked one 180-day window per
 * five-minute cron tick and persisted its progress so the next tick could
 * resume. Three measurements removed the need for any of it.
 *
 * A header-only window costs 21 ms, so the entire depth of the largest mailbox
 * on this install is ~100 ms. An IMAP body SEARCH costs the same whether it
 * spans 180 days or all of history -- 2,704 ms unbounded against 2,680 ms for
 * five windows -- so since .107 one round trip answers the whole mailbox.
 * A complete search of every header and every body is therefore ~2.7 s, all of
 * it one Gmail round trip. That is a request, not a background job.
 *
 * What the table cost, meanwhile: on 2026-08-14 it held thirteen rows from one
 * afternoon's typing, each 102 chunks into a walk that had reached 1975, still
 * advancing nine and a half hours after the tabs that started them had given
 * up. They could not expire either, because every deferral renewed the TTL.
 *
 * The row in `oc_jobs` for the cleanup job goes with it. Nextcloud tolerates a
 * job whose class is missing -- it logs and drops it -- but leaving one behind
 * is leaving a puzzle for whoever reads that table next.
 *
 * @psalm-api
 */
class Version5011Date20260814030000 extends SimpleMigrationStep {
	private const CLEANUP_JOB_CLASS = 'OCA\Mail\BackgroundJob\DeepSearchCleanupJob';
	private const WORKER_JOB_CLASS = 'OCA\Mail\BackgroundJob\DeepSearchJob';

	public function __construct(
		private IDBConnection $connection,
	) {
	}

	/**
	 * Queued workers are deleted BEFORE the table goes, not after.
	 *
	 * Each one holds a jobId pointing into `mail_search_jobs`. Dropping the
	 * table first would leave rows in `oc_jobs` that cron would keep picking
	 * up until each failed its way out.
	 */
	#[\Override]
	public function preSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		try {
			$removed = $this->connection->executeStatement(
				'DELETE FROM `*PREFIX*jobs` WHERE `class` IN (?, ?)',
				[self::CLEANUP_JOB_CLASS, self::WORKER_JOB_CLASS],
			);
			$output->info('Removed ' . $removed . ' deep-search background job(s)');
		} catch (Throwable $e) {
			// A leftover job row is untidy, never fatal: the class is gone,
			// so the worst case is Nextcloud logging and discarding it.
			$output->warning('Could not remove the deep-search background jobs: ' . $e->getMessage());
		}
	}

	/** @param Closure(): ISchemaWrapper $schemaClosure */
	#[\Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		$schema = $schemaClosure();
		if (!$schema->hasTable('mail_search_jobs')) {
			return null;
		}
		$schema->dropTable('mail_search_jobs');
		$output->info('Dropped mail_search_jobs: deep search no longer keeps server-side state');
		return $schema;
	}
}
