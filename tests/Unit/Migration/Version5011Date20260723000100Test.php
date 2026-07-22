<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Migration;

use Doctrine\DBAL\Schema\Table;
use Doctrine\DBAL\Types\Types;
use OCA\Mail\Migration\Version5011Date20260723000100;
use OCP\DB\IPreparedStatement;
use OCP\DB\IResult;
use OCP\DB\ISchemaWrapper;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use PHPUnit\Framework\TestCase;

class Version5011Date20260723000100Test extends TestCase {
	public function testPostgresCreatesTheDescendingIndexConcurrently(): void {
		$connection = $this->createMock(IDBConnection::class);
		$connection->method('getDatabaseProvider')->willReturn(IDBConnection::PLATFORM_POSTGRES);
		$table = $this->mailMessagesTable();
		$schema = $this->schema($table);
		$output = $this->createMock(IOutput::class);
		$statement = $this->createMock(IPreparedStatement::class);
		$statement->expects(self::once())
			->method('execute')
			->willReturn($this->createMock(IResult::class));
		$connection->expects(self::once())
			->method('prepare')
			->with('CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_msg_mailbox_sent_id_idx ON *PREFIX*mail_messages (mailbox_id, sent_at DESC, id DESC)')
			->willReturn($statement);
		$migration = new Version5011Date20260723000100($connection);

		$result = $migration->changeSchema($output, static fn () => $schema, []);
		$migration->postSchemaChange($output, static fn () => $schema, []);

		self::assertSame($schema, $result);
		self::assertFalse($table->hasIndex('mail_msg_mailbox_sent_id_idx'));
	}

	public function testPortablePlatformsCreateTheEquivalentCompositeIndexInSchema(): void {
		$connection = $this->createMock(IDBConnection::class);
		$connection->method('getDatabaseProvider')->willReturn(IDBConnection::PLATFORM_MYSQL);
		$connection->expects(self::never())->method('prepare');
		$table = $this->mailMessagesTable();
		$schema = $this->schema($table);
		$output = $this->createMock(IOutput::class);
		$migration = new Version5011Date20260723000100($connection);

		$result = $migration->changeSchema($output, static fn () => $schema, []);
		$migration->postSchemaChange($output, static fn () => $schema, []);

		self::assertSame($schema, $result);
		self::assertSame(
			['mailbox_id', 'sent_at', 'id'],
			$table->getIndex('mail_msg_mailbox_sent_id_idx')->getColumns(),
		);
	}

	public function testExistingIndexMakesTheMigrationIdempotent(): void {
		$connection = $this->createMock(IDBConnection::class);
		$connection->expects(self::never())->method('getDatabaseProvider');
		$connection->expects(self::never())->method('prepare');
		$table = $this->mailMessagesTable();
		$table->addIndex(['mailbox_id', 'sent_at', 'id'], 'mail_msg_mailbox_sent_id_idx');
		$schema = $this->schema($table);
		$output = $this->createMock(IOutput::class);
		$migration = new Version5011Date20260723000100($connection);

		$result = $migration->changeSchema($output, static fn () => $schema, []);
		$migration->postSchemaChange($output, static fn () => $schema, []);

		self::assertNull($result);
	}

	private function schema(Table $table): ISchemaWrapper {
		$schema = $this->createMock(ISchemaWrapper::class);
		$schema->method('getTable')->with('mail_messages')->willReturn($table);
		return $schema;
	}

	private function mailMessagesTable(): Table {
		$table = new Table('oc_mail_messages');
		$table->addColumn('mailbox_id', Types::BIGINT);
		$table->addColumn('sent_at', Types::BIGINT);
		$table->addColumn('id', Types::BIGINT);
		return $table;
	}
}
