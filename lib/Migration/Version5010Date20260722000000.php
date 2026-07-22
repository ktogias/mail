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
 * Per-account calendar-invitation settings:
 * - imip_allow_unmatched: accept invitations even when no attendee matches a
 *   configured account address (forwards, mailing lists).
 * - default_calendar_url: calendar that events from emails and accepted
 *   invitations on this account default to.
 *
 * @psalm-api
 */
class Version5010Date20260722000000 extends SimpleMigrationStep {

	/**
	 * @param IOutput $output
	 * @param Closure(): ISchemaWrapper $schemaClosure
	 * @param array $options
	 * @return null|ISchemaWrapper
	 */
	#[\Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		$schema = $schemaClosure();
		$accountsTable = $schema->getTable('mail_accounts');
		if (!$accountsTable->hasColumn('imip_allow_unmatched')) {
			$accountsTable->addColumn('imip_allow_unmatched', Types::BOOLEAN, [
				'default' => false,
				'notnull' => false,
			]);
		}
		if (!$accountsTable->hasColumn('default_calendar_url')) {
			$accountsTable->addColumn('default_calendar_url', Types::STRING, [
				'length' => 4000,
				'notnull' => false,
				'default' => null,
			]);
		}
		return $schema;
	}
}
