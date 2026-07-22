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
 * Reconcile the per-account invitation settings after the historical
 * Version5010Date20260722000000 identity collision.
 *
 * Some upgraded installations ran that identifier when it added these two
 * columns, while the published fork release uses the same identifier for the
 * mailbox listing index. A fresh install therefore needs the columns and an
 * upgraded install may already have either, both, or neither side. Never infer
 * state from the old migration record; inspect the schema idempotently.
 *
 * @psalm-api
 */
class Version5011Date20260723000000 extends SimpleMigrationStep {
	/** @param Closure(): ISchemaWrapper $schemaClosure */
	#[\Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		$schema = $schemaClosure();
		$table = $schema->getTable('mail_accounts');
		$changed = false;

		if (!$table->hasColumn('imip_allow_unmatched')) {
			$table->addColumn('imip_allow_unmatched', Types::BOOLEAN, [
				'default' => false,
				'notnull' => false,
			]);
			$changed = true;
		}

		if (!$table->hasColumn('default_calendar_url')) {
			$table->addColumn('default_calendar_url', Types::STRING, [
				'length' => 4000,
				'notnull' => false,
				'default' => null,
			]);
			$changed = true;
		}

		return $changed ? $schema : null;
	}
}
