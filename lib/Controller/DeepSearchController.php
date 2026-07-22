<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Controller;

use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\DelegationService;
use OCA\Mail\Service\Search\DeepSearchService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\OpenAPI;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use function max;
use function min;
use function preg_match;
use function trim;

#[OpenAPI(scope: OpenAPI::SCOPE_IGNORE)]
class DeepSearchController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private ?string $userId,
		private DelegationService $delegationService,
		private IMailManager $mailManager,
		private AccountService $accountService,
		private DeepSearchService $deepSearch,
	) {
		parent::__construct($appName, $request);
	}

	/**
	 * Queue or coalesce one background page below the supplied composite
	 * cursor.  Explicit date-bounded and structural-only searches stay on the
	 * ordinary synchronous path; this endpoint is only for free-text deep work.
	 *
	 * @NoAdminRequired
	 */
	public function create(
		int $mailboxId,
		string $filter,
		int $cursor,
		?int $cursorId = null,
		string $sort = IMailSearch::ORDER_NEWEST_FIRST,
		string $view = IMailSearch::VIEW_THREADED,
		int $limit = 20,
		bool $prioritySplit = false,
	): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$filter = trim($filter);
		if ($cursor <= 0
			|| $sort !== IMailSearch::ORDER_NEWEST_FIRST
			|| !preg_match('/(?:^|\s)(?:to|from|cc|bcc|subject|body):(?=\S)/i', $filter)
			|| preg_match('/(?:^|\s)(?:start|end):/i', $filter)) {
			return new JSONResponse([
				'error' => 'unsupported_search',
			], Http::STATUS_BAD_REQUEST);
		}

		$view = $view === IMailSearch::VIEW_SINGLETON
			? IMailSearch::VIEW_SINGLETON
			: IMailSearch::VIEW_THREADED;
		$limit = min(100, max(1, $limit));

		try {
			$effectiveUserId = $this->delegationService->resolveMailboxUserId($mailboxId, $this->userId);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $mailboxId);
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$job = $this->deepSearch->start(
			$this->userId,
			$effectiveUserId,
			$account,
			$mailbox,
			$filter,
			$sort,
			$view,
			$cursor,
			$cursorId,
			$limit,
			$prioritySplit,
		);
		$status = $job->getStatus() === \OCA\Mail\Db\SearchJob::STATUS_COMPLETE
			? Http::STATUS_OK
			: Http::STATUS_ACCEPTED;
		return new JSONResponse($this->deepSearch->serialize($job), $status);
	}

	/** @NoAdminRequired */
	public function show(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$job = $this->deepSearch->getForUser($id, $this->userId);
		} catch (DoesNotExistException) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		return new JSONResponse($this->deepSearch->serialize($job));
	}

	/** @NoAdminRequired */
	public function destroy(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$this->deepSearch->getForUser($id, $this->userId);
		} catch (DoesNotExistException) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		$this->deepSearch->cancel($id, $this->userId);
		return new JSONResponse([], Http::STATUS_NO_CONTENT);
	}
}
