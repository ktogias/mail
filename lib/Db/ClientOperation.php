<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $value)
 * @method string getOperationId()
 * @method void setOperationId(string $value)
 * @method string getRequestHash()
 * @method void setRequestHash(string $value)
 * @method string getStatus()
 * @method void setStatus(string $value)
 * @method string|null getResponsePayload()
 * @method void setResponsePayload(string|null $value)
 * @method int getCreatedAt()
 * @method void setCreatedAt(int $value)
 * @method int getUpdatedAt()
 * @method void setUpdatedAt(int $value)
 * @method int getExpiresAt()
 * @method void setExpiresAt(int $value)
 */
class ClientOperation extends Entity {
	public const STATUS_PENDING = 'pending';
	public const STATUS_COMPLETE = 'complete';

	protected $userId;
	protected $operationId;
	protected $requestHash;
	protected $status;
	protected $responsePayload;
	protected $createdAt;
	protected $updatedAt;
	protected $expiresAt;

	public function __construct() {
		foreach (['createdAt', 'updatedAt', 'expiresAt'] as $field) {
			$this->addType($field, 'integer');
		}
	}
}
