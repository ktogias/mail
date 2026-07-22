<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Db;

use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $value)
 * @method string getEffectiveUserId()
 * @method void setEffectiveUserId(string $value)
 * @method int getAccountId()
 * @method void setAccountId(int $value)
 * @method int getMailboxId()
 * @method void setMailboxId(int $value)
 * @method string getJobKey()
 * @method void setJobKey(string $value)
 * @method string getMailboxGeneration()
 * @method void setMailboxGeneration(string $value)
 * @method string getFilter()
 * @method void setFilter(string $value)
 * @method string getSortOrder()
 * @method void setSortOrder(string $value)
 * @method string getView()
 * @method void setView(string $value)
 * @method string getStatus()
 * @method void setStatus(string $value)
 * @method int|null getCursorAt()
 * @method void setCursorAt(int|null $value)
 * @method int|null getCursorId()
 * @method void setCursorId(int|null $value)
 * @method int getNextEnd()
 * @method void setNextEnd(int $value)
 * @method int getSearchedThrough()
 * @method void setSearchedThrough(int $value)
 * @method int getPageLimit()
 * @method void setPageLimit(int $value)
 * @method bool getPrioritySplit()
 * @method void setPrioritySplit(bool $value)
 * @method int getResultCount()
 * @method void setResultCount(int $value)
 * @method int getChunksDone()
 * @method void setChunksDone(int $value)
 * @method string|null getResultPayload()
 * @method void setResultPayload(string|null $value)
 * @method bool getCancelRequested()
 * @method void setCancelRequested(bool $value)
 * @method bool getExhausted()
 * @method void setExhausted(bool $value)
 * @method string|null getErrorCode()
 * @method void setErrorCode(string|null $value)
 * @method int getCreatedAt()
 * @method void setCreatedAt(int $value)
 * @method int getUpdatedAt()
 * @method void setUpdatedAt(int $value)
 * @method int getExpiresAt()
 * @method void setExpiresAt(int $value)
 */
class SearchJob extends Entity {
	public const STATUS_QUEUED = 'queued';
	public const STATUS_RUNNING = 'running';
	public const STATUS_COMPLETE = 'complete';
	public const STATUS_CANCELLED = 'cancelled';
	public const STATUS_FAILED = 'failed';

	protected $userId;
	protected $effectiveUserId;
	protected $accountId;
	protected $mailboxId;
	protected $jobKey;
	protected $mailboxGeneration;
	protected $filter;
	protected $sortOrder;
	protected $view;
	protected $status;
	protected $cursorAt;
	protected $cursorId;
	protected $nextEnd;
	protected $searchedThrough;
	protected $pageLimit;
	protected $prioritySplit;
	protected $resultCount;
	protected $chunksDone;
	protected $resultPayload;
	protected $cancelRequested;
	protected $exhausted;
	protected $errorCode;
	protected $createdAt;
	protected $updatedAt;
	protected $expiresAt;

	public function __construct() {
		foreach (['accountId', 'mailboxId', 'cursorAt', 'cursorId', 'nextEnd', 'searchedThrough', 'pageLimit', 'resultCount', 'chunksDone', 'createdAt', 'updatedAt', 'expiresAt'] as $field) {
			$this->addType($field, 'integer');
		}
		$this->addType('cancelRequested', 'boolean');
		$this->addType('exhausted', 'boolean');
		$this->addType('prioritySplit', 'boolean');
	}
}
