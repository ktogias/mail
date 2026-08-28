<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\Search;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IUserPreferences;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\IMAP\PreviewEnhancer;
use OCA\Mail\IMAP\Search\Provider;
use OCA\Mail\Service\Search\FilterStringParser;
use OCA\Mail\Service\Search\Flag;
use OCA\Mail\Service\Search\MailSearch;
use OCA\Mail\Service\Search\SearchQuery;
use OCA\Mail\Service\Search\SearchTelemetry;
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

	private SearchTelemetry&MockObject $searchTelemetry;

	private IUserPreferences&MockObject $preferences;

	protected function setUp(): void {
		parent::setUp();

		$this->filterStringParser = $this->createMock(FilterStringParser::class);
		$this->imapSearchProvider = $this->createMock(Provider::class);
		$this->messageMapper = $this->createMock(MessageMapper::class);
		$this->previewEnhancer = $this->createMock(PreviewEnhancer::class);
		$this->timeFactory = $this->createMock(ITimeFactory::class);
		$this->searchTelemetry = $this->createMock(SearchTelemetry::class);
		$this->preferences = $this->createMock(IUserPreferences::class);

		$this->search = new MailSearch(
			$this->filterStringParser,
			$this->imapSearchProvider,
			$this->messageMapper,
			$this->previewEnhancer,
			$this->searchTelemetry,
			$this->preferences,
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
		$this->searchTelemetry->expects($this->once())
			->method('record')
			->with($query, $mailbox, 'DESC', false, null, $this->isType('int'), 2, 'ok');

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

	public function testFindMessagesRequestsAnExactPrioritySplit(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('admin');
		$mailbox = new Mailbox();
		$query = new SearchQuery();
		$query->addSubject('needle');
		$this->filterStringParser->expects($this->once())
			->method('parse')
			->with('subject:needle')
			->willReturn($query);
		$this->messageMapper->expects($this->once())
			->method('findIdsByQuery')
			->with($mailbox, $query, 'DESC', 20, null, false, true)
			->willReturn([]);
		$this->previewEnhancer->expects($this->once())
			->method('process')
			->willReturnArgument(2);

		$messages = $this->search->findMessages(
			$account,
			$mailbox,
			'DESC',
			'subject:needle',
			null,
			20,
			'admin',
			'threaded',
			true,
		);

		self::assertSame([], $messages);
	}

	public function testFindMessagesSetsCompositeCursor(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('admin');
		$mailbox = new Mailbox();
		$query = new SearchQuery();
		$this->filterStringParser->method('parse')->willReturn($query);
		$this->messageMapper->expects($this->once())
			->method('findIdsByQuery')
			->with($mailbox, self::callback(static fn (SearchQuery $actual): bool => $actual->getCursor() === 1700000000 && $actual->getCursorId() === 4321), 'DESC', 20, null, false, false)
			->willReturn([]);
		$this->previewEnhancer->method('process')->willReturnArgument(2);

		$this->search->findMessages($account, $mailbox, 'DESC', null, 1700000000, 20, 'admin', 'threaded', false, 4321);
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
		$account->method('getMailAccount')
			->willReturn($this->accountWithBodySearch(true));
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

	private function accountWithBodySearch(bool $enabled): MailAccount {
		$mailAccount = new MailAccount();
		$mailAccount->setSearchBody($enabled);
		return $mailAccount;
	}

	private function cachedMailbox(): Mailbox {
		$mailbox = new Mailbox();
		$mailbox->setSyncNewToken('abc');
		$mailbox->setSyncChangedToken('def');
		$mailbox->setSyncVanishedToken('ghi');
		return $mailbox;
	}

	/**
	 * The unified and priority inboxes fan one filter string out to every
	 * account, so `body:` now arrives for accounts that never asked for it.
	 * Each account has to decline for itself -- a body search is a
	 * full-mailbox IMAP SEARCH, so honouring it would put seconds on every
	 * account the user deliberately left switched off.
	 */
	public function testFindMessagesSkipsTheBodySearchForAnAccountThatOptedOut(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('admin');
		$account->method('getMailAccount')
			->willReturn($this->accountWithBodySearch(false));
		$mailbox = $this->cachedMailbox();
		$query = new SearchQuery();
		$query->addBody('needle');
		$this->filterStringParser->method('parse')->willReturn($query);
		$this->preferences->method('getPreference')
			->with('admin', 'search-priority-body', 'false')
			->willReturn('false');
		$this->imapSearchProvider->expects($this->never())
			->method('findMatches');
		$this->imapSearchProvider->expects($this->never())
			->method('findAnyMatch');
		$this->messageMapper->expects($this->once())
			->method('findIdsByQuery')
			->with($mailbox, $query, 'DESC', null, null, false, false)
			->willReturn([]);
		$this->messageMapper->method('findByIds')->willReturn([]);
		$this->previewEnhancer->method('process')->willReturnArgument(2);

		$this->search->findMessages($account, $mailbox, 'DESC', 'needle', null, null, null, null);
	}

	/**
	 * The priority inbox's own toggle promises that bodies are searched
	 * there, so it has to outrank an account that says no.
	 */
	public function testFindMessagesSearchesBodiesWhenOnlyThePreferenceIsOn(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('admin');
		$account->method('getMailAccount')
			->willReturn($this->accountWithBodySearch(false));
		$mailbox = $this->cachedMailbox();
		$query = new SearchQuery();
		$query->addBody('needle');
		$this->filterStringParser->method('parse')->willReturn($query);
		$this->preferences->method('getPreference')
			->with('admin', 'search-priority-body', 'false')
			->willReturn('true');
		$this->imapSearchProvider->expects($this->once())
			->method('findMatches')
			->willReturn([7]);
		$this->messageMapper->method('findByIds')->willReturn([]);
		$this->previewEnhancer->method('process')->willReturnArgument(2);

		$this->search->findMessages($account, $mailbox, 'DESC', 'needle', null, null, null, null);
	}

	/**
	 * The two-step body path is the one place a word can lose the messages it
	 * should have matched while everything reports success, so what it
	 * actually resolved has to be recorded -- per word, not in aggregate.
	 */
	public function testTheTwoStepBodyPathRecordsWhatEachWordResolvedTo(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('admin');
		$account->method('getMailAccount')
			->willReturn($this->accountWithBodySearch(true));
		$mailbox = $this->cachedMailbox();
		$query = new SearchQuery();
		$query->addText('ifiroumelioti');
		$query->addText('εκθέματος');
		$query->addBody('ifiroumelioti');
		$query->addBody('εκθέματος');
		$this->filterStringParser->method('parse')->willReturn($query);
		$this->imapSearchProvider->method('findAnyMatch')->willReturn([11, 12, 13]);
		$this->imapSearchProvider->method('findMatchesWithinCandidates')
			->willReturnCallback(static function ($account, $mailbox, string $text) {
				// The reported shape: one word finds nothing in any body.
				return $text === 'εκθέματος' ? [12] : [];
			});
		$this->messageMapper->method('findIdsByQuery')->willReturn([]);
		$this->messageMapper->method('findByIds')->willReturn([]);
		$this->previewEnhancer->method('process')->willReturnArgument(2);

		$this->searchTelemetry->expects($this->once())
			->method('recordBodyResolution')
			->with(
				$mailbox,
				'two_step',
				3,
				// Lengths, never the words themselves.
				[13, 9],
				[0, 1],
				0,
				$this->anything(),
			);

		$this->search->findMessages($account, $mailbox, 'DESC', 'ifiroumelioti εκθέματος', null, null, null, null);
	}

	/**
	 * And the fallback has to say so: past the candidate ceiling the search
	 * stops asking per word and every word shares one combined body result,
	 * which is a different set of failure modes.
	 */
	public function testTheCombinedFallbackIsRecordedAsSuch(): void {
		$account = $this->createMock(Account::class);
		$account->method('getUserId')->willReturn('admin');
		$account->method('getMailAccount')
			->willReturn($this->accountWithBodySearch(true));
		$mailbox = $this->cachedMailbox();
		$query = new SearchQuery();
		$query->addText('needle');
		$query->addBody('needle');
		$this->filterStringParser->method('parse')->willReturn($query);
		// Empty candidate set: nothing to restrict, so the combined search runs.
		$this->imapSearchProvider->method('findAnyMatch')->willReturn([]);
		$this->imapSearchProvider->method('findMatches')->willReturn([7, 8]);
		$this->messageMapper->method('findIdsByQuery')->willReturn([]);
		$this->messageMapper->method('findByIds')->willReturn([]);
		$this->previewEnhancer->method('process')->willReturnArgument(2);

		$this->searchTelemetry->expects($this->once())
			->method('recordBodyResolution')
			->with($mailbox, 'combined_fallback', 0, [6], [], 2, $this->anything());

		$this->search->findMessages($account, $mailbox, 'DESC', 'needle', null, null, null, null);
	}

	/**
	 * Free-text words are ANDed, so an empty list is the same picture
	 * whether one word is a typo or every word is fine and only their
	 * combination is not. Naming the words that match nothing is the
	 * difference between the two.
	 */
	public function testFindUnmatchedTextsNamesOnlyTheWordsThatMatchNothing(): void {
		$mailbox = $this->cachedMailbox();
		$query = new SearchQuery();
		$query->addText('ifiroumelioti');
		$query->addText('εκθέματος');
		$this->filterStringParser->method('parse')->willReturn($query);
		$this->messageMapper->expects($this->exactly(2))
			->method('findIdsByQuery')
			->willReturnCallback(function (Mailbox $mb, SearchQuery $probe, string $order, ?int $limit) {
				// One word per probe, and the probe must be a limit-1
				// existence question, never a page.
				$this->assertCount(1, $probe->getTexts());
				$this->assertSame(1, $limit);
				return $probe->getTexts() === ['ifiroumelioti'] ? [42] : [];
			});

		$unmatched = $this->search->findUnmatchedTexts($mailbox, 'text:ifiroumelioti text:εκθέματος', null);

		$this->assertSame(['εκθέματος'], $unmatched);
	}

	/**
	 * A single word is its own explanation -- the list is empty because
	 * that word matched nothing, which the user can already see -- so the
	 * probe is not worth a query.
	 */
	public function testFindUnmatchedTextsDoesNotProbeASingleWord(): void {
		$query = new SearchQuery();
		$query->addText('ifiroumelioti');
		$this->filterStringParser->method('parse')->willReturn($query);
		$this->messageMapper->expects($this->never())
			->method('findIdsByQuery');

		$this->assertSame([], $this->search->findUnmatchedTexts($this->cachedMailbox(), 'text:ifiroumelioti', null));
	}

	/**
	 * A probe must ask the same question the search asked, minus the one
	 * word -- including the body, which is dropped precisely because
	 * re-running it per word would be a full IMAP SEARCH each time while
	 * the user waits in front of an already-empty list.
	 */
	public function testFindUnmatchedTextsNeverTouchesImap(): void {
		$query = new SearchQuery();
		$query->addText('one');
		$query->addText('two');
		$query->addBody('one');
		$query->addBody('two');
		$this->filterStringParser->method('parse')->willReturn($query);
		$this->imapSearchProvider->expects($this->never())->method('findMatches');
		$this->imapSearchProvider->expects($this->never())->method('findAnyMatch');
		$this->messageMapper->method('findIdsByQuery')
			->willReturnCallback(function (Mailbox $mb, SearchQuery $probe) {
				$this->assertSame([], $probe->getBodies());
				return [];
			});

		$this->assertSame(['one', 'two'], $this->search->findUnmatchedTexts($this->cachedMailbox(), 'one two', null));
	}
}
