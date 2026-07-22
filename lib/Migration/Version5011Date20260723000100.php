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

/**
 * Reconcile the mailbox-local keyset index after the historical
 * Version5010Date20260722000000 identity collision.
 *
 * This deliberately repeats the published index migration under a new,
 * immutable identifier. Fresh installs normally no-op here because the old
 * index migration ran first; installations that used the old identifier for
 * the invitation columns instead get the missing index during normal upgrade.
 *
 * @psalm-api
 */
class Version5011Date20260723000100 extends SimpleMigrationStep {
	private bool $createPostgresIndex = false;

	public function __construct(
		private IDBConnection $connection,
	) {
	}

	/** @param Closure(): ISchemaWrapper $schemaClosure */
	#[\Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		$schema = $schemaClosure();
		$table = $schema->getTable('mail_messages');
		if ($table->hasIndex('mail_msg_mailbox_sent_id_idx')) {
			return null;
		}

		if ($this->connection->getDatabaseProvider() === IDBConnection::PLATFORM_POSTGRES) {
			$this->createPostgresIndex = true;
			return $schema;
		}

		$table->addIndex(['mailbox_id', 'sent_at', 'id'], 'mail_msg_mailbox_sent_id_idx');
		return $schema;
	}

	/** @param Closure(): ISchemaWrapper $schemaClosure */
	#[\Override]
	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		if (!$this->createPostgresIndex) {
			return;
		}

		$this->connection->prepare(
			'CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_msg_mailbox_sent_id_idx'
			. ' ON *PREFIX*mail_messages (mailbox_id, sent_at DESC, id DESC)'
		)->execute();
		$output->info('Mailbox sent-time keyset index is in place');
	}
}
