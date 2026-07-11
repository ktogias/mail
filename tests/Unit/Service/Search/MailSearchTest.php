<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\Search;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\IMAP\PreviewEnhancer;
use OCA\Mail\IMAP\Search\Provider;
use OCA\Mail\Service\Search\FilterStringParser;
use OCA\Mail\Service\Search\Flag;
use OCA\Mail\Service\Search\MailSearch;
use OCA\Mail\Service\Search\SearchQuery;
use OCP\AppFramework\Utility\ITimeFactory;
use PHPUnit\Framework\MockObject\MockObject;

class MailSearchTest extends TestCase {
	/** @var FilterStringParser|MockObject */
	private $filterStringParser;

	/** @var MailSearch */
	private $search;

	/** @var Provider|MockObject */
	private $imapSearchProvider;

	/** @var PreviewEnhancer|MockObject */
	private $previewEnhancer;

	/** @var MessageMapper|MockObject */
	private $messageMapper;

	/** @var ITimeFactory|MockObject */
	private $timeFactory;

	protected function setUp(): void {
		parent::setUp();

		$this->filterStringParser = $this->createMock(FilterStringParser::class);
		$this->imapSearchProvider = $this->createMock(Provider::class);
		$this->messageMapper = $this->createMock(MessageMapper::class);
		$this->previewEnhancer = $this->createMock(PreviewEnhancer::class);
		$this->timeFactory = $this->createMock(ITimeFactory::class);

		$this->search = new MailSearch(
			$this->filterStringParser,
			$this->imapSearchProvider,
			$this->messageMapper,
			$this->previewEnhancer,
			$this->timeFactory
		);
	}

	/**
	 * Confirmed live: a 773k-message mailbox needing ~155 batches to
	 * finish its initial sync showed "Could not open folder" for hours,
	 * even though whatever a batch had already persisted sat right there
	 * in the DB, perfectly readable. findMessages() only ever reads from
	 * the local DB (aside from an unrelated body-text-search path), so a
	 * mailbox that isn't FULLY cached yet must still serve whatever is
	 * already cached instead of refusing outright.
	 */
	public function testFindMessagesServesAPartiallyCachedMailboxInsteadOfThrowing() {
		$account = $this->createMock(Account::class);
		$account->expects($this->once())
			->method('getUserId')
			->willReturn('admin');
		$mailbox = new Mailbox();
		$mailbox->setSyncNewToken('abc');
		$mailbox->setSyncChangedToken('def');
		// syncVanishedToken deliberately left unset -- isCached() is false,
		// same shape as a mailbox still mid-initial-sync.
		$this->assertFalse($mailbox->isCached());

		$messages = $this->search->findMessages(
			$account,
			$mailbox,
			'DESC',
			null,
			null,
			null,
			null,
			null
		);

		$this->assertEmpty($messages);
	}

	public function testFindMessagesIgnoresLock() {
		$account = $this->createMock(Account::class);
		$account->expects($this->once())
			->method('getUserId')
			->willReturn('admin');
		$mailbox = new Mailbox();
		$mailbox->setSyncNewToken('abc');
		$mailbox->setSyncChangedToken('def');
		$mailbox->setSyncVanishedToken('ghi');
		// A concurrent sync attempt is (or recently was) holding a lock on
		// this mailbox -- findMessages() only reads already-cached
		// messages, so it must not be blocked by it, whether the lock is
		// stale or genuinely still fresh.
		$mailbox->setSyncNewLock(123);

		$messages = $this->search->findMessages(
			$account,
			$mailbox,
			'DESC',
			null,
			null,
			null,
			null,
			null,
		);

		$this->assertEmpty($messages);
	}

	public function testNoFindMessages() {
		$account = $this->createMock(Account::class);
		$account->expects($this->once())
			->method('getUserId')
			->willReturn('admin');
		$mailbox = new Mailbox();
		$mailbox->setSyncNewToken('abc');
		$mailbox->setSyncChangedToken('def');
		$mailbox->setSyncVanishedToken('ghi');

		$messages = $this->search->findMessages(
			$account,
			$mailbox,
			'DESC',
			null,
			null,
			null,
			null,
			null
		);

		$this->assertEmpty($messages);
	}

	public function testFindFlagsLocally() {
		$account = $this->createMock(Account::class);
		$account->expects($this->once())
			->method('getUserId')
			->willReturn('admin');
		$mailbox = new Mailbox();
		$mailbox->setSyncNewToken('abc');
		$mailbox->setSyncChangedToken('def');
		$mailbox->setSyncVanishedToken('ghi');
		$query = new SearchQuery();
		$query->addFlag(Flag::is(Flag::SEEN));
		$this->filterStringParser->expects($this->once())
			->method('parse')
			->with('my search')
			->willReturn($query);
		$this->messageMapper->expects($this->once())
			->method('findByIds')
			->willReturn([
				$this->createMock(Message::class),
				$this->createMock(Message::class),
			]);
		$this->imapSearchProvider->expects($this->never())
			->method('findMatches');
		$this->previewEnhancer->expects($this->once())
			->method('process')
			->willReturnArgument(2);

		$messages = $this->search->findMessages(
			$account,
			$mailbox,
			'DESC',
			'my search',
			null,
			null,
			null,
			null
		);

		$this->assertCount(2, $messages);
	}

	public function testFindText() {
		$account = $this->createMock(Account::class);
		$account->expects($this->once())
			->method('getUserId')
			->willReturn('admin');
		$mailbox = new Mailbox();
		$mailbox->setSyncNewToken('abc');
		$mailbox->setSyncChangedToken('def');
		$mailbox->setSyncVanishedToken('ghi');
		$query = new SearchQuery();
		$query->addBody('my');
		$query->addBody('search');
		$this->filterStringParser->expects($this->once())
			->method('parse')
			->with('my search')
			->willReturn($query);
		$this->imapSearchProvider->expects($this->once())
			->method('findMatches')
			->with($account, $mailbox, $query)
			->willReturn([2, 3]);
		$this->messageMapper->expects($this->once())
			->method('findByIds')
			->willReturn([
				$this->createMock(Message::class),
				$this->createMock(Message::class),
			]);
		$this->previewEnhancer->expects($this->once())
			->method('process')
			->willReturnArgument(2);

		$messages = $this->search->findMessages(
			$account,
			$mailbox,
			'DESC',
			'my search',
			null,
			null,
			null,
			null
		);

		$this->assertCount(2, $messages);
	}
}
