<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Disables PostgreSQL's cost-based JIT compilation for the database
 * this app's tables live in.
 *
 * Confirmed live against mailbox 149 (27k messages): a threaded
 * priority-inbox text search (`match:anyof` across to/from/subject,
 * the same query shape the trigram indexes in
 * Version5010Date20260710000000 target) measured at 3635ms total
 * execution -- of which 3149ms was pure JIT compilation
 * (Inlining/Optimization/Emission), not the query itself. With
 * `jit = off`, the identical query ran in 330ms: an 11x speedup from
 * removing overhead that added no value.
 *
 * PostgreSQL enables JIT automatically once a query's *estimated*
 * cost crosses `jit_above_cost` (default 100000). This app's search
 * queries carry inflated cost estimates -- an artifact of how the
 * planner prices the correlated EXISTS subqueries used for recipient
 * and thread-wide flag matching -- even though the real, index-driven
 * work is small and fast. PostgreSQL's own documentation notes JIT is
 * "only worthwhile for long-running, CPU-bound queries": the opposite
 * of this workload, a small OLTP lookup repeated constantly by a live
 * web app, with a fresh database connection (and so a fresh JIT
 * decision) on every single request. On modest hardware already busy
 * with background mail polling, this is exactly the kind of overhead
 * that turns an otherwise-fast query into a stacked, CPU-contended
 * timeout under concurrent load.
 *
 *  - PostgreSQL only: other databases have no equivalent concept and
 *    are left untouched.
 *  - Scoped to the database (via current_database(), not a hardcoded
 *    name), not instance-wide or per-role: the smallest blast radius
 *    that still covers every connection this app's queries run on.
 *    Safe even if the same database also serves other apps' tables --
 *    JIT is a pure execution-strategy toggle, it changes nothing about
 *    query results.
 *  - Optional and transparent: if it fails (e.g. insufficient rights
 *    on a locked-down setup), the app keeps working exactly as before,
 *    just without this specific optimization.
 *
 * @psalm-api
 */
class Version5010Date20260713234500 extends SimpleMigrationStep {
	public function __construct(
		private IDBConnection $connection,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 */
	#[\Override]
	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		if ($this->connection->getDatabaseProvider() !== IDBConnection::PLATFORM_POSTGRES) {
			return;
		}

		$database = $this->currentDatabaseName();
		if ($database === null) {
			$output->warning('Could not determine the current database name; skipping the JIT-disable optimization');
			return;
		}

		try {
			// Identifier, not a value -- cannot be parameterized. Quoted
			// defensively all the same, even though it comes from the
			// server itself (current_database()), not user input.
			$quoted = '"' . str_replace('"', '""', $database) . '"';
			$this->connection->executeStatement("ALTER DATABASE $quoted SET jit = off");
			$output->info("Disabled PostgreSQL JIT for database $database (see this migration's docblock for why)");
		} catch (Throwable $e) {
			// Optional optimization: never fail the upgrade over it.
			$this->logger->warning('Could not disable PostgreSQL JIT: ' . $e->getMessage(), [
				'exception' => $e,
			]);
			$output->warning('Could not disable PostgreSQL JIT (see log); searches on large mailboxes may stay slower than necessary');
		}
	}

	private function currentDatabaseName(): ?string {
		try {
			$result = $this->connection->executeQuery('SELECT current_database()');
			$name = $result->fetchOne();
			$result->closeCursor();
			return $name !== false ? (string)$name : null;
		} catch (Throwable $e) {
			$this->logger->warning('Could not determine the current database name: ' . $e->getMessage(), [
				'exception' => $e,
			]);
			return null;
		}
	}
}
