<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\PriorityInboxStatsService;

class PriorityInboxStatsServiceTest extends TestCase {
	public function testUsesOnlyAccessibleLocalInboxMailboxes(): void {
		$accountService = $this->createMock(AccountService::class);
		$mailboxMapper = $this->createMock(MailboxMapper::class);
		$messageMapper = $this->createMock(MessageMapper::class);
		$service = new PriorityInboxStatsService($accountService, $mailboxMapper, $messageMapper);

		$owned = $this->createMock(Account::class);
		$delegated = $this->createMock(Account::class);
		$accountService->expects(self::once())
			->method('findByUserId')
			->with('alice')
			->willReturn([$owned]);
		$accountService->expects(self::once())
			->method('findDelegatedAccounts')
			->with('alice')
			->willReturn([$delegated]);

		$ownedInbox = $this->mailbox(11, true, true);
		$ownedArchive = $this->mailbox(12, false, true);
		$delegatedInbox = $this->mailbox(21, true, false);
		$mailboxMapper->expects(self::exactly(2))
			->method('findAll')
			->willReturnMap([
				[$owned, [$ownedInbox, $ownedArchive]],
				[$delegated, [$delegatedInbox]],
			]);

		$sections = [
			'favorite' => ['total' => 1, 'unread' => 1],
			'important' => ['total' => 2, 'unread' => 1],
			'other' => ['total' => 3, 'unread' => 0],
		];
		$messageMapper->expects(self::once())
			->method('getPriorityInboxStats')
			->with([11, 21], true, true)
			->willReturn($sections);

		self::assertSame([
			'sections' => $sections,
			'complete' => false,
		], $service->getStats('alice', true, true));
	}

	private function mailbox(int $id, bool $inbox, bool $cached): Mailbox {
		$mailbox = $this->createMock(Mailbox::class);
		$mailbox->method('getId')->willReturn($id);
		$mailbox->method('isInbox')->willReturn($inbox);
		$mailbox->expects(self::never())->method('isSpecialUse');
		$mailbox->method('isCached')->willReturn($cached);
		return $mailbox;
	}
}
