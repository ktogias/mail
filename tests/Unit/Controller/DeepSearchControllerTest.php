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
use OCA\Mail\Db\SearchJob;
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

	public function testCreateAuthorizesScopeAndQueuesOnlyBoundedTextSearch(): void {
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
		$job = new SearchJob();
		$job->setId(41);
		$job->setStatus(SearchJob::STATUS_QUEUED);
		$this->deepSearch->expects(self::once())
			->method('start')
			->with(
				'alice', 'owner', $account, $mailbox, 'subject:needle',
				IMailSearch::ORDER_NEWEST_FIRST, IMailSearch::VIEW_THREADED,
				1_700_000_000, 991, 20, true,
			)
			->willReturn($job);
		$this->deepSearch->method('serialize')->with($job)->willReturn(['id' => 41, 'status' => 'queued']);

		$response = $this->controller->create(
			23,
			'subject:needle',
			1_700_000_000,
			991,
			IMailSearch::ORDER_NEWEST_FIRST,
			IMailSearch::VIEW_THREADED,
			20,
			true,
		);

		self::assertSame(Http::STATUS_ACCEPTED, $response->getStatus());
		self::assertSame(['id' => 41, 'status' => 'queued'], $response->getData());
	}

	/** @dataProvider unsupportedSearchProvider */
	public function testCreateRejectsUnboundedOrNonTextWork(string $filter, int $cursor, string $sort): void {
		$this->deepSearch->expects(self::never())->method('start');

		$response = $this->controller->create(23, $filter, $cursor, null, $sort);

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

	public function testShowAndCancelCannotCrossUserBoundary(): void {
		$this->deepSearch->expects(self::exactly(2))
			->method('getForUser')
			->with(41, 'alice')
			->willThrowException(new \OCP\AppFramework\Db\DoesNotExistException('missing'));
		$this->deepSearch->expects(self::never())->method('cancel');

		self::assertSame(Http::STATUS_NOT_FOUND, $this->controller->show(41)->getStatus());
		self::assertSame(Http::STATUS_NOT_FOUND, $this->controller->destroy(41)->getStatus());
	}

	public function testAnonymousRequestsAreRejected(): void {
		$controller = $this->controllerFor(null);

		self::assertSame(Http::STATUS_UNAUTHORIZED, $controller->create(23, 'subject:x', 1)->getStatus());
		self::assertSame(Http::STATUS_UNAUTHORIZED, $controller->show(41)->getStatus());
		self::assertSame(Http::STATUS_UNAUTHORIZED, $controller->destroy(41)->getStatus());
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
