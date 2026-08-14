<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Controller;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Controller\DeepSearchController;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\DelegationService;
use OCA\Mail\Service\Search\DeepSearchService;
use OCP\AppFramework\Http;
use OCP\IRequest;

class DeepSearchControllerTest extends TestCase {
	private IMailManager $mailManager;
	private AccountService $accountService;
	private DelegationService $delegationService;
	private DeepSearchService $deepSearch;
	private DeepSearchController $controller;

	protected function setUp(): void {
		parent::setUp();
		$this->mailManager = $this->createMock(IMailManager::class);
		$this->accountService = $this->createMock(AccountService::class);
		$this->delegationService = $this->createMock(DelegationService::class);
		$this->deepSearch = $this->createMock(DeepSearchService::class);
		$this->controller = $this->controllerFor('alice');
	}

	public function testSearchAuthorizesScopeAndDelegatesTheWholeRequest(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(23);
		$mailbox->setAccountId(7);
		$account = $this->createMock(Account::class);
		$this->delegationService->expects(self::once())
			->method('resolveMailboxUserId')
			->with(23, 'alice')
			->willReturn('owner');
		$this->mailManager->method('getMailbox')->with('owner', 23)->willReturn($mailbox);
		$this->accountService->method('find')->with('owner', 7)->willReturn($account);
		$this->deepSearch->expects(self::once())
			->method('search')
			->with(
				$account, $mailbox, 'owner', 'subject:needle',
				IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED,
				1_700_000_000, 991, 20, true, null, DeepSearchService::MODE_HEADERS,
			)
			->willReturn(['results' => [], 'exhausted' => true, 'nextEnd' => null]);

		$response = $this->controller->search(
			23, 'subject:needle', 1_700_000_000, 991,
			IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED, 20, true,
		);

		self::assertSame(Http::STATUS_OK, $response->getStatus());
	}

	/** @dataProvider unsupportedSearchProvider */
	public function testSearchRejectsUnboundedOrNonTextWork(string $filter, int $cursor, string $sort): void {
		$this->deepSearch->expects(self::never())->method('search');

		$response = $this->controller->search(23, $filter, $cursor, null, $sort);

		self::assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
	}

	public function unsupportedSearchProvider(): array {
		return [
			'structural only' => ['is:unread', 1_700_000_000, IMailSearch::ORDER_NEWEST_FIRST],
			'explicit date range' => ['subject:x start:1', 1_700_000_000, IMailSearch::ORDER_NEWEST_FIRST],
			'oldest-first' => ['subject:x', 1_700_000_000, IMailSearch::ORDER_OLDEST_FIRST],
			'invalid cursor' => ['subject:x', 0, IMailSearch::ORDER_NEWEST_FIRST],
		];
	}

	/**
	 * A body-mode request with nothing to search bodies for would open an IMAP
	 * connection -- ~2.7 s against Gmail -- to answer a question identical to
	 * the headers stream's.
	 */
	public function testBodyModeWithoutBodyTermsIsRefused(): void {
		$this->deepSearch->expects(self::never())->method('search');

		$response = $this->controller->search(
			23, 'subject:needle', 1_700_000_000, null,
			IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED, 20, false,
			null, DeepSearchService::MODE_BODY,
		);

		self::assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
	}

	public function testAnUnknownModeIsRefused(): void {
		$this->deepSearch->expects(self::never())->method('search');

		$response = $this->controller->search(
			23, 'subject:needle', 1_700_000_000, null,
			IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED, 20, false,
			null, 'everything',
		);

		self::assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
	}

	/**
	 * The continuation token is client-supplied. It cannot widen access -- the
	 * mailbox is authorised on every request -- but a token at or above the
	 * cursor would walk forwards or stand still, and a non-positive one would
	 * run off the end of time.
	 * @dataProvider badContinuationProvider
	 */
	public function testAnImpossibleContinuationIsRefused(int $nextEnd): void {
		$this->deepSearch->expects(self::never())->method('search');

		$response = $this->controller->search(
			23, 'subject:needle', 1_700_000_000, null,
			IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED, 20, false,
			$nextEnd,
		);

		self::assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
	}

	public function badContinuationProvider(): array {
		return [
			'at the cursor' => [1_700_000_000],
			'above the cursor' => [1_800_000_000],
			'zero' => [0],
			'negative' => [-1],
		];
	}

	public function testAnonymousRequestsAreRejected(): void {
		$controller = $this->controllerFor(null);

		self::assertSame(Http::STATUS_UNAUTHORIZED, $controller->search(23, 'subject:x', 1)->getStatus());
	}

	private function controllerFor(?string $userId): DeepSearchController {
		return new DeepSearchController(
			'mail',
			$this->createMock(IRequest::class),
			$userId,
			$this->delegationService,
			$this->mailManager,
			$this->accountService,
			$this->deepSearch,
		);
	}
}
