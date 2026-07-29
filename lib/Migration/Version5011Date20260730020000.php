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
 * Nullable, so readers fall back to `<uid>.ics` -- the conventional name, and
 * therefore right for anything the Tasks app created itself.
 *
 * No backfill step here, but NOT because the information is unrecoverable:
 * that was the first assumption and it was wrong. `oc_calendarobjects` stores
 * `uid` and `uri` side by side, so the mapping is one join away:
 *
 *   UPDATE oc_mail_message_tasks t SET task_uri = co.uri
 *     FROM oc_calendarobjects co JOIN oc_calendars c ON c.id = co.calendarid
 *    WHERE t.task_uri IS NULL AND co.uid = t.task_uid AND c.uri = t.calendar_uri;
 *
 * It is left out of the migration because those are core tables this app does
 * not own, and reaching across into another app's schema from a migration is
 * a worse precedent than a one-off repair. The single affected row on this
 * install was fixed with exactly that statement.
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
