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
 * Trigram indexes for the substring searches of the message search.
 *
 * The search path matches free-text terms with ILIKE '%term%' against
 * mail_messages.subject and mail_recipients.email/label. A leading
 * wildcard makes btree indexes useless, so every such search scans all
 * candidate rows of the mailbox -- measured at ~15s for one search
 * against a 27k-message mailbox on small hardware, and concurrent
 * searches pile up behind each other from there.
 *
 * PostgreSQL's pg_trgm extension provides GIN trigram indexes that
 * serve exactly this access pattern (ILIKE with leading wildcard, for
 * search terms of 3+ characters). This migration creates them when it
 * can:
 *  - PostgreSQL only: other databases skip silently (no equivalent
 *    facility, behaviour simply stays as it is today).
 *  - The pg_trgm extension must be available: CREATE EXTENSION is
 *    attempted (works when the database user has sufficient rights,
 *    e.g. on typical container setups), otherwise the admin can create
 *    it manually and re-run the migration; without it the indexes are
 *    skipped silently as well.
 *
 * Everything here is an optional, transparent optimization: no schema
 * the app depends on changes, and skipping is always safe.
 *
 * @psalm-api
 */
class Version5010Date20260710000000 extends SimpleMigrationStep {
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

		if (!$this->ensureTrgmExtension($output)) {
			return;
		}

		$prefix = $options['tablePrefix'] ?? 'oc_';
		$indexes = [
			'mail_msgs_subject_trgm_idx' => $prefix . 'mail_messages USING gin (subject gin_trgm_ops)',
			'mail_recips_email_trgm_idx' => $prefix . 'mail_recipients USING gin (email gin_trgm_ops)',
			'mail_recips_label_trgm_idx' => $prefix . 'mail_recipients USING gin (label gin_trgm_ops)',
		];

		foreach ($indexes as $name => $definition) {
			try {
				$this->connection->executeStatement("CREATE INDEX IF NOT EXISTS $name ON $definition");
				$output->info("Trigram index $name is in place");
			} catch (Throwable $e) {
				// Optional optimization: never fail the upgrade over it.
				$this->logger->warning("Could not create trigram index $name: {$e->getMessage()}", [
					'exception' => $e,
				]);
				$output->warning("Could not create trigram index $name (see log); searches will work but stay slower");
			}
		}
	}

	private function ensureTrgmExtension(IOutput $output): bool {
		try {
			$result = $this->connection->executeQuery("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'");
			$exists = $result->fetchOne() !== false;
			$result->closeCursor();
			if ($exists) {
				return true;
			}
		} catch (Throwable $e) {
			$this->logger->warning('Could not check for the pg_trgm extension: ' . $e->getMessage(), ['exception' => $e]);
			return false;
		}

		try {
			$this->connection->executeStatement('CREATE EXTENSION IF NOT EXISTS pg_trgm');
			return true;
		} catch (Throwable $e) {
			// Requires elevated rights on some setups -- the admin can run
			// `CREATE EXTENSION pg_trgm;` manually and re-run the upgrade.
			$this->logger->info('pg_trgm extension not available and could not be created; skipping trigram search indexes: ' . $e->getMessage());
			$output->info('pg_trgm not available; skipping optional trigram search indexes');
			return false;
		}
	}
}
