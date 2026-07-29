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
 * The CalDAV object name, which is what the Tasks app actually routes on.
 *
 * Version5011Date20260729180000 stored only the VTODO's UID and built the deep
 * link from it. That link never worked. The Tasks app's route is
 * `/apps/tasks/calendars/<calendar>/tasks/<taskId>`, and its own code passes
 * `task.uri` as that parameter -- the basename of the CalDAV object, `.ics`
 * included. The two are NOT the same string: cdav-library names a newly
 * created object with a fresh identifier of its own, so a task whose UID is
 * `e179a093-…` lives at `85D8FD67-….ics`.
 *
 * Nullable, and no attempt to backfill. The old rows genuinely do not contain
 * the information -- recovering it would mean fetching every object in the
 * calendar and matching on UID. Readers fall back to `<uid>.ics`, which is the
 * conventional name and therefore right for anything the Tasks app created
 * itself; it stays wrong for the handful this bug produced, and re-creating
 * those tasks is the honest fix.
 *
 * @psalm-api
 */
class Version5011Date20260730020000 extends SimpleMigrationStep {
	/** @param Closure(): ISchemaWrapper $schemaClosure */
	#[\Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		$schema = $schemaClosure();
		if (!$schema->hasTable('mail_message_tasks')) {
			return null;
		}
		$table = $schema->getTable('mail_message_tasks');
		if ($table->hasColumn('task_uri')) {
			return null;
		}

		// 255 to match calendar_uri and task_uid. A CalDAV object name is a
		// path segment, so it is bounded in practice well below that.
		$table->addColumn('task_uri', Types::STRING, [
			'notnull' => false,
			'length' => 255,
		]);
		return $schema;
	}
}
