<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Durable, bounded server-side idempotency records for client mutation replay.
 *
 * @psalm-api
 */
class Version5011Date20260724120000 extends SimpleMigrationStep {
	/** @param Closure(): ISchemaWrapper $schemaClosure */
	#[\Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		$schema = $schemaClosure();
		if ($schema->hasTable('mail_client_operations')) {
			return null;
		}

		$table = $schema->createTable('mail_client_operations');
		$table->addColumn('id', Types::BIGINT, [
			'autoincrement' => true,
			'notnull' => true,
			'unsigned' => true,
		]);
		$table->addColumn('user_id', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		$table->addColumn('operation_id', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		$table->addColumn('request_hash', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		$table->addColumn('status', Types::STRING, [
			'notnull' => true,
			'length' => 16,
		]);
		$table->addColumn('response_payload', Types::TEXT, [
			'notnull' => false,
		]);
		$table->addColumn('created_at', Types::BIGINT, [
			'notnull' => true,
		]);
		$table->addColumn('updated_at', Types::BIGINT, [
			'notnull' => true,
		]);
		$table->addColumn('expires_at', Types::BIGINT, [
			'notnull' => true,
		]);
		$table->setPrimaryKey(['id']);
		$table->addUniqueIndex(['user_id', 'operation_id'], 'mail_client_op_user_uidx');
		$table->addIndex(['expires_at'], 'mail_client_op_expiry_idx');
		return $schema;
	}
}
