<?php

declare(strict_types=1);

/**
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
 * Durable state for bounded, background deep-search pages.
 *
 * Results deliberately live on the job row instead of in an unbounded result
 * table: one job materializes at most one UI page and expires shortly after it
 * completes.  Subsequent pages get their own cursor-keyed, coalescible job.
 *
 * @psalm-api
 */
class Version5010Date20260722120000 extends SimpleMigrationStep {
	/** @param Closure(): ISchemaWrapper $schemaClosure */
	#[\Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		$schema = $schemaClosure();
		if ($schema->hasTable('mail_search_jobs')) {
			return null;
		}

		$table = $schema->createTable('mail_search_jobs');
		$table->addColumn('id', Types::BIGINT, [
			'autoincrement' => true,
			'notnull' => true,
			'unsigned' => true,
		]);
		$table->addColumn('user_id', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		$table->addColumn('effective_user_id', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		$table->addColumn('account_id', Types::BIGINT, [
			'notnull' => true,
			'unsigned' => true,
		]);
		$table->addColumn('mailbox_id', Types::BIGINT, [
			'notnull' => true,
			'unsigned' => true,
		]);
		$table->addColumn('job_key', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		$table->addColumn('mailbox_generation', Types::STRING, [
			'notnull' => true,
			'length' => 32,
		]);
		$table->addColumn('filter', Types::TEXT, [
			'notnull' => true,
		]);
		$table->addColumn('sort_order', Types::STRING, [
			'notnull' => true,
			'length' => 4,
		]);
		$table->addColumn('view', Types::STRING, [
			'notnull' => true,
			'length' => 16,
		]);
		$table->addColumn('status', Types::STRING, [
			'notnull' => true,
			'length' => 16,
		]);
		$table->addColumn('cursor_at', Types::BIGINT, [
			'notnull' => false,
		]);
		$table->addColumn('cursor_id', Types::BIGINT, [
			'notnull' => false,
		]);
		$table->addColumn('next_end', Types::BIGINT, [
			'notnull' => true,
		]);
		$table->addColumn('searched_through', Types::BIGINT, [
			'notnull' => true,
		]);
		$table->addColumn('page_limit', Types::INTEGER, [
			'notnull' => true,
			'unsigned' => true,
		]);
		$table->addColumn('priority_split', Types::BOOLEAN, [
			'notnull' => true,
			'default' => false,
		]);
		$table->addColumn('result_count', Types::INTEGER, [
			'notnull' => true,
			'unsigned' => true,
			'default' => 0,
		]);
		$table->addColumn('chunks_done', Types::INTEGER, [
			'notnull' => true,
			'unsigned' => true,
			'default' => 0,
		]);
		$table->addColumn('result_payload', Types::TEXT, [
			'notnull' => false,
		]);
		$table->addColumn('cancel_requested', Types::BOOLEAN, [
			'notnull' => true,
			'default' => false,
		]);
		$table->addColumn('exhausted', Types::BOOLEAN, [
			'notnull' => true,
			'default' => false,
		]);
		$table->addColumn('error_code', Types::STRING, [
			'notnull' => false,
			'length' => 64,
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
		$table->addUniqueIndex(['job_key'], 'mail_search_job_key_uidx');
		$table->addIndex(['user_id', 'id'], 'mail_search_user_id_idx');
		$table->addIndex(['status', 'expires_at'], 'mail_search_expiry_idx');
		return $schema;
	}

	/** @param Closure(): ISchemaWrapper $schemaClosure */
	#[\Override]
	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		// The cleanup job this used to register no longer exists: deep search
		// became stateless, so there is no table of jobs to reap. A fresh
		// install must not register a class it cannot build, and an existing
		// one has the row removed by Version5011Date20260814030000.
	}
}
