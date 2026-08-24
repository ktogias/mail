<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Migration;

use Closure;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;
use Throwable;

/**
 * Keep PostgreSQL's statistics fresh on `oc_mail_recipients`.
 *
 * It is the largest table in this schema -- 4.67M rows against 2.05M in
 * `oc_mail_messages` on the install this was found on -- and its message-id
 * index had been scanned 61.5 million times. Every mailbox listing joins it.
 *
 * `oc_mail_messages` was given per-table autovacuum tuning by hand at some
 * point; `oc_mail_recipients` never was. At PostgreSQL's default
 * `autovacuum_analyze_scale_factor` of 0.1 that table needs roughly 467,000
 * modifications before ANALYZE runs, so its statistics went stale for weeks:
 * measured at 230,380 changes and twelve days since the last analyze.
 *
 * Stale statistics on the joined side is what lets the planner pick a
 * disk-bound plan. Measured before and after ANALYZE on that install:
 *
 *   mailbox 31 (15,902 messages)   18.03s -> 5.16s worst case
 *   mailbox 39 ( 6,015 messages)   18.33s -> 5.62s worst case
 *
 * Both at 1.7-2.2% CPU while slow, which is the signature of waiting on disk
 * rather than computing. Note the larger Gmail inbox (27,539 messages) was
 * never among the slow ones: this was never about volume.
 *
 * Done as a migration because the setting was applied by hand once and would
 * be lost by any restore, rebuild or move of the database -- and its absence
 * is invisible until someone measures a listing query.
 *
 * PostgreSQL only. `ALTER TABLE ... SET (autovacuum_*)` is not portable, and
 * MySQL/SQLite have no equivalent knob, so they are skipped rather than
 * emulated. Failure is reported and swallowed: a tuning hint must never block
 * an app upgrade.
 *
 * @psalm-api
 */
class Version5011Date20260814010000 extends SimpleMigrationStep {
	public function __construct(
		private IDBConnection $connection,
	) {
	}

	#[\Override]
	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		if ($this->connection->getDatabaseProvider() !== IDBConnection::PLATFORM_POSTGRES) {
			$output->info('Not PostgreSQL: skipping the autovacuum tuning for oc_mail_recipients');
			return;
		}

		// *PREFIX* is expanded by Connection::finishQuery(); IDBConnection has
		// no prefix accessor, and this is the convention core migrations use
		// for raw DDL.
		$table = '*PREFIX*mail_recipients';

		try {
			// 0.02 mirrors what oc_mail_messages already carries, so the two
			// halves of every listing join keep statistics of the same age.
			$this->connection->executeStatement(
				'ALTER TABLE ' . $table . ' SET ('
				. 'autovacuum_analyze_scale_factor = 0.02, '
				. 'autovacuum_vacuum_insert_scale_factor = 0.02'
				. ')',
			);
			// The setting only governs FUTURE autovacuum runs. Without this the
			// table keeps whatever stale statistics it already had until the
			// next 2% of rows change, which on a quiet install is still days.
			$this->connection->executeStatement('ANALYZE ' . $table);
			$output->info('Tuned autovacuum and refreshed statistics for ' . $table);
		} catch (Throwable $e) {
			$output->warning(
				'Could not tune autovacuum for ' . $table . ': ' . $e->getMessage()
				. ' -- listing queries may be slower until ANALYZE runs',
			);
		}
	}
}
