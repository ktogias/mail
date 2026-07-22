<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Migration;

use Doctrine\DBAL\Schema\Table;
use Doctrine\DBAL\Types\Types;
use OCA\Mail\Migration\Version5011Date20260723000000;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use PHPUnit\Framework\TestCase;

class Version5011Date20260723000000Test extends TestCase {
	public function testAddsBothInvitationSettingColumns(): void {
		$table = $this->mailAccountsTable();
		$schema = $this->schema($table);
		$migration = new Version5011Date20260723000000();

		$result = $migration->changeSchema(
			$this->createMock(IOutput::class),
			static fn () => $schema,
			[],
		);

		self::assertSame($schema, $result);
		self::assertTrue($table->hasColumn('imip_allow_unmatched'));
		self::assertFalse($table->getColumn('imip_allow_unmatched')->getNotnull());
		self::assertTrue($table->hasColumn('default_calendar_url'));
		self::assertFalse($table->getColumn('default_calendar_url')->getNotnull());
		self::assertSame(4000, $table->getColumn('default_calendar_url')->getLength());
	}

	public function testAddsOnlyTheMissingColumn(): void {
		$table = $this->mailAccountsTable();
		$table->addColumn('imip_allow_unmatched', Types::BOOLEAN, [
			'default' => false,
			'notnull' => false,
		]);
		$schema = $this->schema($table);
		$migration = new Version5011Date20260723000000();

		$result = $migration->changeSchema(
			$this->createMock(IOutput::class),
			static fn () => $schema,
			[],
		);

		self::assertSame($schema, $result);
		self::assertTrue($table->hasColumn('imip_allow_unmatched'));
		self::assertTrue($table->hasColumn('default_calendar_url'));
	}

	public function testExistingColumnsMakeTheMigrationIdempotent(): void {
		$table = $this->mailAccountsTable();
		$table->addColumn('imip_allow_unmatched', Types::BOOLEAN, [
			'default' => false,
			'notnull' => false,
		]);
		$table->addColumn('default_calendar_url', Types::STRING, [
			'length' => 4000,
			'notnull' => false,
			'default' => null,
		]);
		$schema = $this->schema($table);
		$migration = new Version5011Date20260723000000();

		$result = $migration->changeSchema(
			$this->createMock(IOutput::class),
			static fn () => $schema,
			[],
		);

		self::assertNull($result);
	}

	private function schema(Table $table): ISchemaWrapper {
		$schema = $this->createMock(ISchemaWrapper::class);
		$schema->method('getTable')->with('mail_accounts')->willReturn($table);
		return $schema;
	}

	private function mailAccountsTable(): Table {
		$table = new Table('oc_mail_accounts');
		$table->addColumn('id', Types::BIGINT);
		return $table;
	}
}
