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
 * Which messages have a task made from them.
 *
 * The link itself lives in the VTODO, as its URL property -- that is the
 * standard place for it and the Tasks app already treats URL as a first-class
 * field. This table is the INDEX for the other direction, which CalDAV cannot
 * answer: there is no way to ask "which tasks point at this message" short of
 * fetching every task in every calendar, which is not something a thread can
 * do each time it opens.
 *
 * Keyed on the RFC 5322 Message-ID rather than the local row id. The row id
 * changes on a re-index and the mailbox id changes when the message is moved;
 * the Message-ID is what actually identifies a message for its whole life, and
 * is the identifier RFC 2392's mid: scheme is built on.
 *
 * Deliberately a HINT, not a source of truth. A task deleted from the Tasks
 * app leaves a row behind, so readers must tolerate a dangling entry and clean
 * it up when they find one.
 *
 * @psalm-api
 */
class Version5011Date20260729180000 extends SimpleMigrationStep {
	/** @param Closure(): ISchemaWrapper $schemaClosure */
	#[\Override]
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		$schema = $schemaClosure();
		if ($schema->hasTable('mail_message_tasks')) {
			return null;
		}

		$table = $schema->createTable('mail_message_tasks');
		$table->addColumn('id', Types::BIGINT, [
			'autoincrement' => true,
			'notnull' => true,
			'unsigned' => true,
		]);
		$table->addColumn('user_id', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		// The RFC 5322 Message-ID, angle brackets included, as stored in
		// mail_messages.message_id. Long because there is no practical limit
		// on the header and truncating would silently break the join.
		$table->addColumn('message_id', Types::STRING, [
			'notnull' => true,
			'length' => 1023,
		]);
		// Denormalised so a thread can ask one question instead of one per
		// message. A thread of forty messages opening forty queries is the
		// shape this index exists to avoid in the first place.
		$table->addColumn('thread_root_id', Types::STRING, [
			'notnull' => false,
			'length' => 1023,
		]);
		// Enough to rebuild the Tasks deep link
		// (/apps/tasks/#/calendars/<calendar>/tasks/<uid>) without asking
		// CalDAV anything.
		$table->addColumn('calendar_uri', Types::STRING, [
			'notnull' => true,
			'length' => 255,
		]);
		$table->addColumn('task_uid', Types::STRING, [
			'notnull' => true,
			'length' => 255,
		]);
		$table->addColumn('summary', Types::STRING, [
			'notnull' => false,
			'length' => 255,
		]);
		$table->addColumn('created_at', Types::BIGINT, [
			'notnull' => true,
		]);
		$table->setPrimaryKey(['id']);
		// One row per task, not per message: the same message may spawn
		// several tasks, and creating the same task twice must not.
		$table->addUniqueIndex(['user_id', 'task_uid'], 'mail_msg_task_uid_uidx');
		// The two read paths: a whole thread at once, and a single message.
		//
		// Prefixed on the long column. 1023 characters matches
		// mail_messages.message_id so the values line up exactly, but MySQL
		// cannot index that: utf8mb4 makes it 4092 bytes against InnoDB's 3072
		// limit, and the migration would fail on install rather than here. The
		// codebase already has this shape -- see
		// Version1100Date20210326103929's index on imap_message_id.
		$table->addIndex(['user_id', 'thread_root_id'], 'mail_msg_task_thread_idx', [], ['lengths' => [null, 128]]);
		$table->addIndex(['user_id', 'message_id'], 'mail_msg_task_msg_idx', [], ['lengths' => [null, 128]]);
		return $schema;
	}
}
