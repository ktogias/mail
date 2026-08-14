<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Migration;

use Doctrine\DBAL\Schema\Schema;
use OCA\Mail\Migration\Version5010Date20260722120000;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use PHPUnit\Framework\TestCase;

class Version5010Date20260722120000Test extends TestCase {
	public function testCreatesDurableBoundedSearchJobTable(): void {
		$dbalSchema = new Schema();
		$schema = $this->createMock(ISchemaWrapper::class);
		$schema->method('hasTable')->with('mail_search_jobs')->willReturn(false);
		$schema->expects(self::once())
			->method('createTable')
			->with('mail_search_jobs')
			->willReturnCallback(static fn () => $dbalSchema->createTable('oc_mail_search_jobs'));
		// No job registration any more: deep search became stateless in .108,
		// so there is no table of jobs to reap and no cleanup job to register.
		$migration = new Version5010Date20260722120000();

		$result = $migration->changeSchema(
			$this->createMock(IOutput::class),
			static fn () => $schema,
			[],
		);

		self::assertSame($schema, $result);
		$table = $dbalSchema->getTable('oc_mail_search_jobs');
		self::assertTrue($table->hasColumn('result_payload'));
		self::assertTrue($table->hasColumn('cancel_requested'));
		self::assertTrue($table->hasColumn('expires_at'));
		self::assertTrue($table->hasIndex('mail_search_job_key_uidx'));
		self::assertTrue($table->getIndex('mail_search_job_key_uidx')->isUnique());
		self::assertSame(['status', 'expires_at'], $table->getIndex('mail_search_expiry_idx')->getColumns());
		$migration->postSchemaChange($this->createMock(IOutput::class), static fn () => $schema, []);
	}

	public function testExistingTableMakesMigrationIdempotent(): void {
		$schema = $this->createMock(ISchemaWrapper::class);
		$schema->method('hasTable')->with('mail_search_jobs')->willReturn(true);
		$schema->expects(self::never())->method('createTable');

		$migration = new Version5010Date20260722120000();
		$result = $migration->changeSchema(
			$this->createMock(IOutput::class),
			static fn () => $schema,
			[],
		);

		self::assertNull($result);
		$migration->postSchemaChange($this->createMock(IOutput::class), static fn () => $schema, []);
	}
}
