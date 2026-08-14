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
	 * Advance one search backwards through history and return what it found.
	 *
	 * Stateless: the response carries a continuation token and the server
	 * keeps nothing. A client that stops asking ends the search, which is why
	 * there is no cancel endpoint and nothing to reap. Explicit date-bounded
	 * and structural-only searches stay on the ordinary synchronous path;
	 * this is only for free-text work.
	 *
	 * @NoAdminRequired
	 */
	public function search(
		int $mailboxId,
		string $filter,
		int $cursor,
		?int $cursorId = null,
		string $sort = IMailSearch::ORDER_NEWEST_FIRST,
		string $view = IMailSearch::VIEW_THREADED,
		int $limit = 20,
		bool $prioritySplit = false,
		?int $nextEnd = null,
		string $mode = DeepSearchService::MODE_HEADERS,
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
		if ($mode !== DeepSearchService::MODE_HEADERS && $mode !== DeepSearchService::MODE_BODY) {
			return new JSONResponse(['error' => 'unsupported_mode'], Http::STATUS_BAD_REQUEST);
		}
		// A body-mode request with nothing to search bodies for would open an
		// IMAP connection to answer a question identical to the headers
		// stream's. Refuse it rather than pay for it.
		if ($mode === DeepSearchService::MODE_BODY && !DeepSearchService::hasBodyTerms($filter)) {
			return new JSONResponse(['error' => 'no_body_terms'], Http::STATUS_BAD_REQUEST);
		}
		// The continuation token is a plain timestamp from a previous
		// response. It cannot widen access -- the mailbox is authorised
		// below on every request, exactly as on the first one -- but it must
		// not walk forwards or off the end of time.
		if ($nextEnd !== null && ($nextEnd <= 0 || $nextEnd >= $cursor)) {
			return new JSONResponse(['error' => 'invalid_continuation'], Http::STATUS_BAD_REQUEST);
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

		return new JSONResponse($this->deepSearch->search(
			$account,
			$mailbox,
			$effectiveUserId,
			$filter,
			$sort,
			$view,
			$cursor,
			$cursorId,
			$limit,
			$prioritySplit,
			$nextEnd,
			$mode,
		));
	}
}
