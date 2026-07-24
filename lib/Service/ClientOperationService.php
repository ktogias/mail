<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service;

use Closure;
use JsonException;
use OCA\Mail\Db\ClientOperation;
use OCA\Mail\Db\ClientOperationMapper;
use OCA\Mail\Exception\ClientException;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use Throwable;

/**
 * Small durable idempotency journal for browser-replayed target-state
 * mutations. It stores no message content, only a request hash and the compact
 * JSON response needed to answer a duplicate operation.
 */
class ClientOperationService {
	private const TTL_SECONDS = 7 * 24 * 60 * 60;
	private const PENDING_LEASE_SECONDS = 2 * 60;

	public function __construct(
		private ClientOperationMapper $mapper,
		private ITimeFactory $timeFactory,
	) {
	}

	/**
	 * @param Closure(): array $operation
	 * @return array{state: 'complete'|'pending', response?: array}
	 * @throws JsonException
	 */
	public function execute(
		string $userId,
		?string $operationId,
		string $requestHash,
		Closure $operation,
	): array {
		if ($operationId === null || $operationId === '') {
			return [
				'state' => ClientOperation::STATUS_COMPLETE,
				'response' => $operation(),
			];
		}
		if (strlen($operationId) > 64 || preg_match('/^[A-Za-z0-9._:-]+$/', $operationId) !== 1) {
			throw new ClientException('Invalid operation id');
		}

		$now = $this->timeFactory->getTime();
		$this->mapper->deleteExpired($now);
		try {
			$existing = $this->mapper->find($userId, $operationId);
			if ($existing->getStatus() !== ClientOperation::STATUS_PENDING
				|| $existing->getUpdatedAt() > $now - self::PENDING_LEASE_SECONDS) {
				return $this->existingResult($existing, $requestHash);
			}
			// A PHP worker may die after claiming the operation but before
			// recording its response. Flag writes are explicit target-state
			// operations, so reclaiming an expired lease and applying the
			// same target again is safe.
			$this->mapper->deleteOperation($existing->getId());
		} catch (DoesNotExistException) {
			// This caller owns the first attempt unless a concurrent insert
			// wins the unique key between this lookup and insert below.
		}

		$record = new ClientOperation();
		$record->setUserId($userId);
		$record->setOperationId($operationId);
		$record->setRequestHash($requestHash);
		$record->setStatus(ClientOperation::STATUS_PENDING);
		$record->setCreatedAt($now);
		$record->setUpdatedAt($now);
		$record->setExpiresAt($now + self::TTL_SECONDS);
		try {
			$record = $this->mapper->insert($record);
		} catch (Throwable $e) {
			try {
				return $this->existingResult(
					$this->mapper->find($userId, $operationId),
					$requestHash,
				);
			} catch (DoesNotExistException) {
				throw $e;
			}
		}

		try {
			$response = $operation();
		} catch (Throwable $e) {
			// Target-state flag operations are safe to retry. Removing a
			// failed attempt prevents a caught server error from leaving the
			// browser blocked behind a stale pending record.
			$this->mapper->deleteOperation($record->getId());
			throw $e;
		}

		$this->mapper->complete(
			$record->getId(),
			json_encode($response, JSON_THROW_ON_ERROR),
			$now,
			$now + self::TTL_SECONDS,
		);
		return [
			'state' => ClientOperation::STATUS_COMPLETE,
			'response' => $response,
		];
	}

	/**
	 * @return array{state: 'complete'|'pending', response?: array}
	 * @throws JsonException
	 */
	private function existingResult(ClientOperation $existing, string $requestHash): array {
		if (!hash_equals($existing->getRequestHash(), $requestHash)) {
			throw new ClientException('Operation id was already used for a different request');
		}
		if ($existing->getStatus() !== ClientOperation::STATUS_COMPLETE) {
			return ['state' => ClientOperation::STATUS_PENDING];
		}

		$payload = $existing->getResponsePayload();
		return [
			'state' => ClientOperation::STATUS_COMPLETE,
			'response' => $payload === null
				? []
				: json_decode($payload, true, flags: JSON_THROW_ON_ERROR),
		];
	}
}
