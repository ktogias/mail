<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service;

use OCA\Mail\Db\ClientOperation;
use OCA\Mail\Db\ClientOperationMapper;
use OCA\Mail\Service\ClientOperationService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use PHPUnit\Framework\TestCase;

class ClientOperationServiceTest extends TestCase {
	public function testRecordsAndCompletesFirstAttempt(): void {
		$mapper = $this->createMock(ClientOperationMapper::class);
		$time = $this->createMock(ITimeFactory::class);
		$time->method('getTime')->willReturn(1_000);
		$mapper->expects($this->once())->method('deleteExpired')->with(1_000);
		$mapper->expects($this->once())
			->method('find')
			->willThrowException(new DoesNotExistException('new'));
		$mapper->expects($this->once())
			->method('insert')
			->willReturnCallback(static function (ClientOperation $operation): ClientOperation {
				$operation->setId(17);
				return $operation;
			});
		$mapper->expects($this->once())
			->method('complete')
			->with(17, '{"ok":true}', 1_000, 605_800);
		$service = new ClientOperationService($mapper, $time);

		$result = $service->execute(
			'user',
			'op-1',
			str_repeat('a', 64),
			static fn () => ['ok' => true],
		);

		self::assertSame([
			'state' => ClientOperation::STATUS_COMPLETE,
			'response' => ['ok' => true],
		], $result);
	}

	public function testReplaysCompletedResponseWithoutRunningOperation(): void {
		$record = new ClientOperation();
		$record->setRequestHash(str_repeat('a', 64));
		$record->setStatus(ClientOperation::STATUS_COMPLETE);
		$record->setResponsePayload('{"ok":true}');
		$mapper = $this->createMock(ClientOperationMapper::class);
		$mapper->method('find')->willReturn($record);
		$time = $this->createMock(ITimeFactory::class);
		$time->method('getTime')->willReturn(1_000);
		$called = false;
		$operation = static function () use (&$called): array {
			$called = true;
			return [];
		};
		$service = new ClientOperationService($mapper, $time);

		$result = $service->execute('user', 'op-1', str_repeat('a', 64), $operation);

		self::assertFalse($called);
		self::assertSame(['ok' => true], $result['response']);
	}

	public function testReturnsPendingForConcurrentDuplicate(): void {
		$record = new ClientOperation();
		$record->setRequestHash(str_repeat('a', 64));
		$record->setStatus(ClientOperation::STATUS_PENDING);
		$record->setUpdatedAt(999);
		$mapper = $this->createMock(ClientOperationMapper::class);
		$mapper->method('find')->willReturn($record);
		$time = $this->createMock(ITimeFactory::class);
		$time->method('getTime')->willReturn(1_000);
		$service = new ClientOperationService($mapper, $time);

		$result = $service->execute(
			'user',
			'op-1',
			str_repeat('a', 64),
			static fn () => ['unexpected' => true],
		);

		self::assertSame(['state' => ClientOperation::STATUS_PENDING], $result);
	}

	public function testReclaimsExpiredPendingLease(): void {
		$record = new ClientOperation();
		$record->setId(16);
		$record->setRequestHash(str_repeat('a', 64));
		$record->setStatus(ClientOperation::STATUS_PENDING);
		$record->setUpdatedAt(800);
		$mapper = $this->createMock(ClientOperationMapper::class);
		$mapper->expects($this->once())->method('find')->willReturn($record);
		$mapper->expects($this->once())->method('deleteOperation')->with(16);
		$mapper->expects($this->once())
			->method('insert')
			->willReturnCallback(static function (ClientOperation $operation): ClientOperation {
				$operation->setId(17);
				return $operation;
			});
		$mapper->expects($this->once())->method('complete');
		$time = $this->createMock(ITimeFactory::class);
		$time->method('getTime')->willReturn(1_000);
		$service = new ClientOperationService($mapper, $time);

		$result = $service->execute(
			'user',
			'op-1',
			str_repeat('a', 64),
			static fn () => ['ok' => true],
		);

		self::assertSame(['ok' => true], $result['response']);
	}
}
