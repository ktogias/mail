<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Migration;

use Doctrine\DBAL\Schema\Schema;
use OCA\Mail\Migration\Version5011Date20260724120000;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use PHPUnit\Framework\TestCase;

class Version5011Date20260724120000Test extends TestCase {
	public function testCreatesClientOperationJournalOnce(): void {
		$dbalSchema = new Schema();
		$schema = $this->createMock(ISchemaWrapper::class);
		$schema->method('hasTable')
			->with('mail_client_operations')
			->willReturn(false);
		$schema->method('createTable')
			->with('mail_client_operations')
			->willReturnCallback(static fn () => $dbalSchema->createTable('oc_mail_client_operations'));
		$migration = new Version5011Date20260724120000();

		$result = $migration->changeSchema(
			$this->createMock(IOutput::class),
			static fn () => $schema,
			[],
		);

		self::assertSame($schema, $result);
		$table = $dbalSchema->getTable('oc_mail_client_operations');
		self::assertSame(
			['id', 'user_id', 'operation_id', 'request_hash', 'status', 'response_payload', 'created_at', 'updated_at', 'expires_at'],
			array_keys($table->getColumns()),
		);
		self::assertTrue($table->hasIndex('mail_client_op_user_uidx'));
		self::assertTrue($table->hasIndex('mail_client_op_expiry_idx'));
	}

	public function testNoOpsWhenTableAlreadyExists(): void {
		$schema = $this->createMock(ISchemaWrapper::class);
		$schema->method('hasTable')
			->with('mail_client_operations')
			->willReturn(true);

		$result = (new Version5011Date20260724120000())->changeSchema(
			$this->createMock(IOutput::class),
			static fn () => $schema,
			[],
		);

		self::assertNull($result);
	}
}
