<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;
use Throwable;

/**
 * A partial index for the iMIP scan, which was reading 9,239 blocks to return
 * nothing.
 *
 * IMipMessageJob looks for calendar invitations still to be processed:
 *
 *   SELECT * FROM oc_mail_messages
 *    WHERE imip_message AND NOT imip_processed AND NOT imip_error
 *      AND NOT flag_junk AND sent_at > ?
 *    ORDER BY sent_at ASC
 *
 * There is no index for that shape. The planner fell back to
 * mail_msg_mailbox_sent_id_idx, whose leading column is mailbox_id, so it
 * could not seek on sent_at and scanned instead. Captured from the live
 * server with log_min_duration_statement:
 *
 *   duration: 16386.440 ms   ...   actual rows=0
 *   Buffers: shared hit=564 read=9239
 *
 * Sixteen seconds of disk on an I/O-bound NAS, every time the job runs, to
 * find zero rows. The job's own recorded execution_duration was 17 seconds.
 * That competes with everything else on the same disk -- mailbox syncs,
 * deletes, listings -- so its cost is not confined to calendar handling.
 *
 * The predicate is extremely selective: 358 rows of 2,056,249, or 0.017%. A
 * partial index is therefore 16 kB rather than the tens of megabytes a
 * composite index over four booleans plus sent_at would occupy on this table.
 *
 * Measured after creating it, both with literals and through PREPARE/EXECUTE
 * with the parameter shape the app actually sends -- because a partial index
 * whose predicate the planner cannot prove from a parameter is useless, and
 * that had to be verified rather than assumed:
 *
 *   Buffers: shared hit=1        Execution Time: 0.231 ms
 *
 * CONCURRENTLY so the build takes no lock on a 2M-row table that the mail app
 * writes to continuously; it took 19 seconds live. That means it cannot run
 * inside a transaction, which is why this is postSchemaChange with raw SQL
 * rather than a schema change.
 *
 * PostgreSQL only: partial indexes are not portable, and the platforms without
 * them are left alone rather than given a worse approximation.
 *
 * @psalm-api
 */
class Version5011Date20260814020000 extends SimpleMigrationStep {
	private const INDEX_NAME = 'mail_imip_pending_sent_idx';

	public function __construct(
		private IDBConnection $connection,
	) {
	}

	#[\Override]
	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		if ($this->connection->getDatabaseProvider() !== IDBConnection::PLATFORM_POSTGRES) {
			$output->info('Not PostgreSQL: skipping the partial iMIP index');
			return;
		}

		try {
			// IF NOT EXISTS keeps this repeatable: a CONCURRENTLY build that is
			// interrupted leaves an INVALID index behind, and the retry must not
			// fail on the name already being taken.
			$this->connection->executeStatement(
				'CREATE INDEX CONCURRENTLY IF NOT EXISTS ' . self::INDEX_NAME
				. ' ON *PREFIX*mail_messages (sent_at)'
				. ' WHERE imip_message AND NOT imip_processed'
				. ' AND NOT imip_error AND NOT flag_junk',
			);
			$output->info('Created ' . self::INDEX_NAME . ' for the iMIP scan');
		} catch (Throwable $e) {
			$output->warning(
				'Could not create ' . self::INDEX_NAME . ': ' . $e->getMessage()
				. ' -- the iMIP background job will keep scanning',
			);
		}
	}
}
