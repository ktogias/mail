<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2017 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Tests\Unit\Service;

use ChristophWurst\Nextcloud\Testing\TestCase;
use Horde_Imap_Client_Socket;
use OCA\Mail\Account;
use OCA\Mail\Attachment;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Events\MessageFlaggedEvent;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper as DbMessageMapper;
use OCA\Mail\Db\MessageTagsMapper;
use OCA\Mail\Db\Tag;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Db\ThreadMapper;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Folder;
use OCA\Mail\IMAP\FolderMapper;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\ImapFlag;
use OCA\Mail\IMAP\ImapWorkClass;
use OCA\Mail\IMAP\MailboxSync;
use OCA\Mail\IMAP\MessageMapper as ImapMessageMapper;
use OCA\Mail\Service\MailManager;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\EventDispatcher\IEventDispatcher;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class MailManagerTest extends TestCase {
	/** @var IMAPClientFactory|MockObject */
	private $imapClientFactory;

	/** @var MailboxMapper|MockObject */
	private $mailboxMapper;

	/** @var MailboxSync|MockObject */
	private $mailboxSync;

	/** @var FolderMapper|MockObject */
	private $folderMapper;

	/** @var ImapMessageMapper|MockObject */
	private $imapMessageMapper;

	/** @var DbMessageMapper|MockObject */
	private $dbMessageMapper;

	/** @var IEventDispatcher|MockObject */
	private $eventDispatcher;

	/** @var MailManager */
	private $manager;

	/** @var MockObject|LoggerInterface */
	private $logger;

	/** @var MockObject|TagMapper */
	private $tagMapper;

	/** @var MessageTagsMapper|MockObject */
	private $messageTagsMapper;

	/** @var ThreadMapper|MockObject */
	private $threadMapper;

	protected function setUp(): void {
		parent::setUp();

		$this->imapClientFactory = $this->createMock(IMAPClientFactory::class);
		$this->mailboxMapper = $this->createMock(MailboxMapper::class);
		$this->folderMapper = $this->createMock(FolderMapper::class);
		$this->imapMessageMapper = $this->createMock(ImapMessageMapper::class);
		$this->dbMessageMapper = $this->createMock(DbMessageMapper::class);
		$this->mailboxSync = $this->createMock(MailboxSync::class);
		$this->eventDispatcher = $this->createMock(IEventDispatcher::class);
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->tagMapper = $this->createMock(TagMapper::class);
		$this->messageTagsMapper = $this->createMock(MessageTagsMapper::class);
		$this->threadMapper = $this->createMock(ThreadMapper::class);

		$this->manager = new MailManager(
			$this->imapClientFactory,
			$this->mailboxMapper,
			$this->mailboxSync,
			$this->folderMapper,
			$this->imapMessageMapper,
			$this->dbMessageMapper,
			$this->eventDispatcher,
			$this->logger,
			$this->tagMapper,
			$this->messageTagsMapper,
			$this->threadMapper,
			new ImapFlag(),
		);
	}

	public function testGetFolders() {
		/** @var Account|MockObject $account */
		$account = $this->createStub(Account::class);
		$mailboxes = [
			$this->createMock(Mailbox::class),
			$this->createMock(Mailbox::class),
		];
		$this->mailboxSync->expects($this->once())
			->method('sync')
			->with($this->equalTo($account));
		$this->mailboxMapper->expects($this->once())
			->method('findAll')
			->with($this->equalTo($account))
			->willReturn($mailboxes);

		$result = $this->manager->getMailboxes($account);

		$this->assertSame($mailboxes, $result);
	}

	public function testExplicitMailboxRefreshCarriesWorkClassToImapSync(): void {
		$account = $this->createStub(Account::class);
		$this->mailboxSync->expects($this->once())
			->method('sync')
			->with(
				$account,
				$this->logger,
				true,
				null,
				ImapWorkClass::EXPLICIT_HEAVY,
			);
		$this->mailboxMapper->method('findAll')->willReturn([]);

		$this->manager->getMailboxes($account, true, ImapWorkClass::EXPLICIT_HEAVY);
	}

	public function testCreateFolder() {
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$account = $this->createStub(Account::class);
		$this->imapClientFactory->expects($this->once())
			->method('getClient')
			->with($account, true, true)
			->willReturn($client);
		$folder = $this->createStub(Folder::class);
		$this->folderMapper->expects($this->once())
			->method('createFolder')
			->with($this->equalTo($client), $this->equalTo('new'))
			->willReturn($folder);
		$this->folderMapper->expects($this->once())
			->method('fetchFolderAcls')
			->with($this->equalTo([$folder]));
		$this->folderMapper->expects($this->once())
			->method('detectFolderSpecialUse')
			->with($this->equalTo([$folder]));
		$mailbox = new Mailbox();
		$this->mailboxMapper->expects($this->once())
			->method('find')
			->with($account, 'new')
			->willReturn($mailbox);

		$created = $this->manager->createMailbox($account, 'new');

		$this->assertEquals($mailbox, $created);
	}

	public function testDeleteMessageSourceFolderNotFound(): void {
		/** @var Account|MockObject $account */
		$account = $this->createStub(Account::class);
		$this->eventDispatcher->expects($this->never())
			->method('dispatchTyped');
		$this->mailboxMapper->expects($this->once())
			->method('find')
			->with($account, 'INBOX')
			->willThrowException(new DoesNotExistException(''));
		$this->expectException(ServiceException::class);

		$this->manager->deleteMessage(
			$account,
			'INBOX',
			123
		);
	}

	public function testDeleteMessageTrashMailboxNotFound(): void {
		/** @var Account|MockObject $account */
		$account = $this->createMock(Account::class);
		$mailAccount = new MailAccount();
		$mailAccount->setTrashMailboxId(123);
		$mailbox = new Mailbox();
		$mailbox->setName('INBOX');
		$account->method('getMailAccount')->willReturn($mailAccount);
		$this->eventDispatcher->expects($this->once())
			->method('dispatchTyped');
		$this->mailboxMapper->expects($this->once())
			->method('find')
			->with($account, 'INBOX')
			->willReturn($mailbox);
		$this->mailboxMapper->expects($this->once())
			->method('findById')
			->with(123)
			->willThrowException(new DoesNotExistException(''));
		$this->expectException(ServiceException::class);

		$this->manager->deleteMessage(
			$account,
			'INBOX',
			123
		);
	}

	public function testDeleteMessage(): void {
		/** @var Account|MockObject $account */
		$account = $this->createMock(Account::class);
		$mailAccount = new MailAccount();
		$mailAccount->setTrashMailboxId(123);
		$account->method('getMailAccount')->willReturn($mailAccount);
		$inbox = new Mailbox();
		$inbox->setName('INBOX');
		$trash = new Mailbox();
		$trash->setName('Trash');
		$this->eventDispatcher->expects($this->exactly(2))
			->method('dispatchTyped');
		$this->mailboxMapper->expects($this->once())
			->method('find')
			->with($account, 'INBOX')
			->willReturn($inbox);
		$this->mailboxMapper->expects($this->once())
			->method('findById')
			->with(123)
			->willReturn($trash);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$this->imapClientFactory->expects($this->once())
			->method('getClient')
			->willReturn($client);
		$this->imapMessageMapper->expects($this->once())
			->method('moveBatch')
			->with(
				$client,
				'INBOX',
				[123],
				'Trash'
			);

		$this->manager->deleteMessage(
			$account,
			'INBOX',
			123
		);
	}

	public function testExpungeMessage(): void {
		/** @var Account|MockObject $account */
		$account = $this->createMock(Account::class);
		$mailAccount = new MailAccount();
		$mailAccount->setTrashMailboxId(123);
		$account->method('getMailAccount')->willReturn($mailAccount);
		$source = new Mailbox();
		$source->setName('Trash');
		$trash = new Mailbox();
		$trash->setName('Trash');
		$this->eventDispatcher->expects($this->exactly(2))
			->method('dispatchTyped');
		$this->mailboxMapper->expects($this->once())
			->method('find')
			->with($account, 'Trash')
			->willReturn($source);
		$this->mailboxMapper->expects($this->once())
			->method('findById')
			->with(123)
			->willReturn($trash);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$this->imapClientFactory->expects($this->once())
			->method('getClient')
			->willReturn($client);
		$this->imapMessageMapper->expects($this->once())
			->method('expungeBatch')
			->with(
				$client,
				'Trash',
				[123]
			);

		$this->manager->deleteMessage(
			$account,
			'Trash',
			123
		);
	}

	public function testSetCustomFlagNoIMAPCapabilities(): void {
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$account = $this->createStub(Account::class);
		$account->method('getUserId')->willReturn('user');
		$this->tagMapper->method('getTagByImapLabel')
			->willThrowException(new DoesNotExistException('no importance tag'));

		$this->imapClientFactory->expects($this->any())
			->method('getClient')
			->willReturn($client);
		$this->imapMessageMapper->expects($this->never())
			->method('addFlag');
		$this->imapMessageMapper->expects($this->never())
			->method('removeFlag');

		$this->manager->flagMessage($account, 'INBOX', 123, Tag::LABEL_IMPORTANT, true);
		$this->manager->flagMessage($account, 'INBOX', 123, Tag::LABEL_IMPORTANT, false);
	}

	public function testSetCustomFlagWithIMAPCapabilities(): void {
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$account = $this->createStub(Account::class);
		$account->method('getUserId')->willReturn('user');
		$this->tagMapper->method('getTagByImapLabel')
			->willThrowException(new DoesNotExistException('no importance tag'));

		$this->imapClientFactory->expects($this->any())
			->method('getClient')
			->willReturn($client);
		// Importance is dual-written: the legacy $label1 keyword AND the
		// RFC 8457 $important keyword, each checked against server
		// capabilities separately.
		$client->expects($this->exactly(2))
			->method('status')
			->willReturn([ 'permflags' => [ '11' => "\*" ] ]);
		$addedFlags = [];
		$this->imapMessageMapper->expects($this->exactly(2))
			->method('addFlag')
			->willReturnCallback(static function ($client, $mb, $uids, $flag) use (&$addedFlags): void {
				$addedFlags[] = $flag;
			});

		$this->manager->flagMessage($account, 'INBOX', 123, Tag::LABEL_IMPORTANT, true);

		self::assertEquals([Tag::LABEL_IMPORTANT, '$important'], $addedFlags);
	}

	/**
	 * The importance flag write now maintains mail_message_tags itself, so
	 * the browser no longer needs a second HTTP request to the tag endpoint
	 * for the same click.
	 *
	 * That second request was not free: measured live on 2026-07-26, every
	 * mutation costs 2.6-5.6s at 10-16% CPU -- almost entirely IMAP
	 * connect/auth -- and the tag endpoint opened a connection of its own to
	 * rewrite keywords this write had already set correctly.
	 */
	public function testImportanceFlagWriteMaintainsTheTagRowWithoutASecondImapConnection(): void {
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$account = $this->createStub(Account::class);
		$account->method('getUserId')->willReturn('user');
		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);
		$message = new Message();
		$message->setUid(123);
		$message->setMessageId('<abc@example.com>');

		// Exactly one client for the whole operation.
		$this->imapClientFactory->expects($this->once())
			->method('getClient')
			->willReturn($client);
		$client->method('status')->willReturn(['permflags' => ['11' => "\*"]]);
		$this->tagMapper->method('getTagByImapLabel')->willReturn($tag);
		$this->dbMessageMapper->method('findByUids')->willReturn([$message]);

		$this->tagMapper->expects($this->once())
			->method('tagMessage')
			->with($tag, '<abc@example.com>', 'user');
		$this->tagMapper->expects($this->never())
			->method('untagMessage');

		$this->manager->flagMessage($account, 'INBOX', 123, Tag::LABEL_IMPORTANT, true);
	}

	public function testImportanceRemovalUntagsTheMessage(): void {
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$account = $this->createStub(Account::class);
		$account->method('getUserId')->willReturn('user');
		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);
		$message = new Message();
		$message->setUid(123);
		$message->setMessageId('<abc@example.com>');

		$this->imapClientFactory->method('getClient')->willReturn($client);
		$client->method('status')->willReturn(['permflags' => ['11' => "\*"]]);
		$this->tagMapper->method('getTagByImapLabel')->willReturn($tag);
		$this->dbMessageMapper->method('findByUids')->willReturn([$message]);

		$this->tagMapper->expects($this->once())
			->method('untagMessage')
			->with($tag, '<abc@example.com>');

		$this->manager->flagMessage($account, 'INBOX', 123, Tag::LABEL_IMPORTANT, false);
	}

	/**
	 * .134: importance reaches every copy of the message, not only the one the
	 * user acted on. The live case: GitHub delivered two review notifications
	 * twice each into one INBOX, the classifier judged only the second
	 * deliveries important, and the thread view -- which shows one copy per
	 * Message-ID -- offered no important message to unmark while the
	 * conversation sat under Important.
	 */
	public function testImportanceReachesEveryOtherCopyOfTheMessage(): void {
		[$account, $inbox, $label] = $this->importanceFixture();
		$acted = $this->cachedCopy(2076973, 31, 22062);
		$sameInbox = $this->cachedCopy(2077442, 31, 22490);
		$otherFolder = $this->cachedCopy(9001, 40, 7);

		$this->dbMessageMapper->method('findByUids')->willReturnCallback(
			static fn ($mailbox, array $uids) => $uids === [22062] ? [$acted] : [],
		);
		$this->dbMessageMapper->expects($this->once())
			->method('findCopiesByMessageIds')
			->with($account, ['<review/5337787773@github.com>'])
			->willReturn([$acted, $sameInbox, $otherFolder]);
		$this->mailboxMapper->method('findById')->with(40)->willReturn($label);

		$removed = [];
		$this->imapMessageMapper->method('removeFlag')->willReturnCallback(
			static function ($client, Mailbox $mailbox, array $uids, string $flag) use (&$removed): void {
				$removed[] = $mailbox->getId() . ':' . implode(',', $uids) . ':' . $flag;
			},
		);
		$events = [];
		$this->eventDispatcher->method('dispatch')->willReturnCallback(
			static function (string $name, $event) use (&$events): void {
				if ($event instanceof MessageFlaggedEvent) {
					$events[] = $event->getMessage()->getId() . ':' . $event->getFlag() . '=' . ($event->isSet() ? '1' : '0');
				}
			},
		);

		$this->manager->flagMessages($account, 'INBOX', [22062], [Tag::LABEL_IMPORTANT => false]);

		// The copy the user acted on, then each other copy -- grouped per
		// mailbox, both importance keywords each, one connection throughout.
		self::assertSame([
			'31:22062:$label1',
			'31:22062:$important',
			'31:22490:$label1',
			'31:22490:$important',
			'40:7:$label1',
			'40:7:$important',
		], $removed);
		// Every copy's cached row follows in this request, so the thread
		// aggregate is right before any mailbox next syncs.
		self::assertEqualsCanonicalizing([
			'2076973:$label1=0',
			'2077442:$label1=0',
			'9001:$label1=0',
		], $events);
	}

	public function testAnOrdinaryFlagIsNotCarriedToCopies(): void {
		[$account] = $this->importanceFixture();
		$this->dbMessageMapper->method('findByUids')->willReturn([$this->cachedCopy(1, 31, 22062)]);

		// Seen has its own contract (the thread view tidies hidden copies
		// only when a visible one is READ); this path must stay out of it.
		$this->dbMessageMapper->expects($this->never())->method('findCopiesByMessageIds');

		$this->manager->flagMessages($account, 'INBOX', [22062], ['seen' => true]);
	}

	public function testACopyThatCannotBeWrittenDoesNotFailTheUsersOwnWrite(): void {
		[$account, $inbox, $label] = $this->importanceFixture();
		$acted = $this->cachedCopy(2076973, 31, 22062);
		$this->dbMessageMapper->method('findByUids')->willReturn([$acted]);
		$this->dbMessageMapper->method('findCopiesByMessageIds')
			->willReturn([$acted, $this->cachedCopy(9001, 40, 7)]);
		$this->mailboxMapper->method('findById')->willReturn($label);
		$this->imapMessageMapper->method('removeFlag')->willReturnCallback(
			static function ($client, Mailbox $mailbox) : void {
				if ($mailbox->getId() === 40) {
					throw new \Horde_Imap_Client_Exception('mailbox went away');
				}
			},
		);

		$this->logger->expects($this->once())
			->method('warning')
			->with('Could not carry an importance change to every copy of the message');

		$this->manager->flagMessages($account, 'INBOX', [22062], [Tag::LABEL_IMPORTANT => false]);
	}

	/**
	 * @return array{0: Account, 1: Mailbox, 2: Mailbox}
	 */
	private function importanceFixture(): array {
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$client->method('status')->willReturn(['permflags' => ['11' => "\*"]]);
		$this->imapClientFactory->expects($this->once())->method('getClient')->willReturn($client);
		$account = $this->createStub(Account::class);
		$account->method('getUserId')->willReturn('user');
		$account->method('getId')->willReturn(3);
		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);
		$this->tagMapper->method('getTagByImapLabel')->willReturn($tag);

		$inbox = new Mailbox();
		$inbox->setId(31);
		$inbox->setName('INBOX');
		$label = new Mailbox();
		$label->setId(40);
		$label->setName('Label');
		$this->mailboxMapper->method('find')->willReturn($inbox);
		return [$account, $inbox, $label];
	}

	private function cachedCopy(int $id, int $mailboxId, int $uid): Message {
		$message = new Message();
		$message->setId($id);
		$message->setMailboxId($mailboxId);
		$message->setUid($uid);
		$message->setMessageId('<review/5337787773@github.com>');
		return $message;
	}

	/**
	 * An ordinary flag must not touch tags at all.
	 */
	public function testSeenFlagWriteLeavesTagsAlone(): void {
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$account = $this->createStub(Account::class);
		$account->method('getUserId')->willReturn('user');

		$this->imapClientFactory->method('getClient')->willReturn($client);
		$client->method('status')->willReturn(['permflags' => ['11' => "\*"]]);

		$this->tagMapper->expects($this->never())->method('getTagByImapLabel');
		$this->tagMapper->expects($this->never())->method('tagMessage');
		$this->tagMapper->expects($this->never())->method('untagMessage');

		$this->manager->flagMessage($account, 'INBOX', 123, 'seen', true);
	}

	public function testUnsetCustomFlagWithIMAPCapabilities(): void {
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$account = $this->createStub(Account::class);
		$account->method('getUserId')->willReturn('user');
		$this->tagMapper->method('getTagByImapLabel')
			->willThrowException(new DoesNotExistException('no importance tag'));

		$this->imapClientFactory->expects($this->any())
			->method('getClient')
			->willReturn($client);
		$client->expects($this->exactly(2))
			->method('status')
			->willReturn([ 'permflags' => [ '11' => "\*" ] ]);
		$removedFlags = [];
		$this->imapMessageMapper->expects($this->exactly(2))
			->method('removeFlag')
			->willReturnCallback(static function ($client, $mb, $uids, $flag) use (&$removedFlags): void {
				$removedFlags[] = $flag;
			});

		$this->manager->flagMessage($account, 'INBOX', 123, Tag::LABEL_IMPORTANT, false);

		self::assertEquals([Tag::LABEL_IMPORTANT, '$important'], $removedFlags);
	}

	public function testSetNonImportanceCustomFlagWritesOnlyItself(): void {
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$account = $this->createStub(Account::class);

		$this->imapClientFactory->expects($this->any())
			->method('getClient')
			->willReturn($client);
		$client->expects($this->once())
			->method('status')
			->willReturn([ 'permflags' => [ '11' => "\*" ] ]);
		$this->imapMessageMapper->expects($this->once())
			->method('addFlag');

		$this->manager->flagMessage($account, 'INBOX', 123, '$labelwork', true);
	}

	public function testFilterFlagsWithSystemFlags(): void {
		$account = $this->createStub(Account::class);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$flags = [
			'seen' => [\Horde_Imap_Client::FLAG_SEEN],
			'answered' => [\Horde_Imap_Client::FLAG_ANSWERED],
			'flagged' => [\Horde_Imap_Client::FLAG_FLAGGED],
			'deleted' => [\Horde_Imap_Client::FLAG_DELETED],
			'draft' => [\Horde_Imap_Client::FLAG_DRAFT],
			'recent' => [\Horde_Imap_Client::FLAG_RECENT],
		];

		// test all system flags
		foreach ($flags as $k => $flag) {
			$this->assertEquals($this->manager->filterFlags($client, $account, $k, 'INBOX'), $flags[$k]);
		}
	}

	public function testFilterFlagsWithDefinedKeyword() {
		$account = $this->createStub(Account::class);
		$client = $this->createMock(Horde_Imap_Client_Socket::class);

		$client->expects($this->exactly(2))
			->method('status')
			->willReturn(['permflags' => ['\seen', '$junk', '$notjunk']]);

		// test keyword supported
		$this->assertEquals(['$junk'], $this->manager->filterFlags($client, $account, '$junk', 'INBOX'));
		// test keyword unsupported
		$this->assertEquals([], $this->manager->filterFlags($client, $account, '$autojunk', 'INBOX'));
	}

	public function testFilterFlagsWithCustomKeyword() {
		$account = $this->createStub(Account::class);
		$client = $this->createMock(Horde_Imap_Client_Socket::class);

		$client->expects($this->exactly(2))
			->method('status')
			->willReturnOnConsecutiveCalls(
				['permflags' => ['\seen', '$junk', '$notjunk', '\*']],
				['permflags' => ['\seen', '$junk', '$notjunk']],
			);

		// test custom keyword supported
		$this->assertEquals([Tag::LABEL_IMPORTANT], $this->manager->filterFlags($client, $account, Tag::LABEL_IMPORTANT, 'INBOX'));
		// test custom keyword unsupported
		$this->assertEquals([], $this->manager->filterFlags($client, $account, Tag::LABEL_IMPORTANT, 'INBOX'));
	}

	public function testFilterFlagsNoCapabilities() {
		$account = $this->createStub(Account::class);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);

		$this->assertEquals([], $this->manager->filterFlags($client, $account, Tag::LABEL_IMPORTANT, 'INBOX'));
	}

	public function testIsPermflagsEnabledTrue(): void {
		$account = $this->createStub(Account::class);
		$client = $this->createMock(Horde_Imap_Client_Socket::class);

		$client->expects($this->once())
			->method('status')
			->willReturn(['permflags' => [ '11' => "\*"] ]);

		$this->assertTrue($this->manager->isPermflagsEnabled($client, $account, 'INBOX'));
	}

	public function testIsPermflagsEnabledFalse(): void {
		$account = $this->createStub(Account::class);
		$client = $this->createMock(Horde_Imap_Client_Socket::class);

		$client->expects($this->once())
			->method('status')
			->willReturn([]);

		$this->assertFalse($this->manager->isPermflagsEnabled($client, $account, 'INBOX'));
	}

	public function testRemoveFlag(): void {
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$account = $this->createStub(Account::class);
		$this->imapClientFactory->expects($this->once())
			->method('getClient')
			->with($account, true, true)
			->willReturn($client);
		$mb = $this->createStub(Mailbox::class);
		$this->mailboxMapper->expects($this->once())
			->method('find')
			->with($account, 'INBOX')
			->willReturn($mb);
		$this->imapMessageMapper->expects($this->never())
			->method('addFlag');
		$this->imapMessageMapper->expects($this->once())
			->method('removeFlag')
			->with($client, $mb, [123], '\\seen');

		$this->manager->flagMessage($account, 'INBOX', 123, 'seen', false);
	}

	public function testTagMessage(): void {
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$account = $this->createMock(Account::class);
		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(123);
		$message->setMessageId('<jhfjkhdsjkfhdsjkhfjkdsh@test.com>');
		$this->imapClientFactory->expects($this->any())
			->method('getClient')
			->willReturn($client);
		$mb = new Mailbox();
		$mb->setName('INBOX');
		$this->mailboxMapper->expects($this->once())
			->method('find')
			->with($account, 'INBOX')
			->willReturn($mb);
		$client->expects($this->once())
			->method('status')
			->willReturn(['permflags' => [ '11' => "\*"] ]);
		$this->imapMessageMapper->expects($this->once())
			->method('addFlag')
			->with($client, $mb, [123], Tag::LABEL_IMPORTANT);
		$account->expects($this->once())
			->method('getUserId')
			->willReturn('test');
		$this->manager->tagMessage($account, 'INBOX', $message, $tag, true);
	}

	public function testUntagMessage(): void {
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$account = $this->createMock(Account::class);
		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(123);
		$message->setMessageId('<jhfjkhdsjkfhdsjkhfjkdsh@test.com>');
		$this->imapClientFactory->expects($this->any())
			->method('getClient')
			->willReturn($client);
		$mb = new Mailbox();
		$mb->setName('INBOX');
		$this->mailboxMapper->expects($this->once())
			->method('find')
			->with($account, 'INBOX')
			->willReturn($mb);
		$client->expects($this->once())
			->method('status')
			->willReturn(['permflags' => [ '11' => "\*"] ]);
		$this->imapMessageMapper->expects($this->once())
			->method('removeFlag')
			->with($client, $mb, [123], Tag::LABEL_IMPORTANT);
		$this->imapMessageMapper->expects($this->never())
			->method('addFlag');
		$account->expects($this->never())
			->method('getUserId')
			->willReturn('test');
		$this->manager->tagMessage($account, 'INBOX', $message, $tag, false);
	}

	public function testTagNoIMAPCapabilities(): void {
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$account = $this->createMock(Account::class);
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(123);
		$message->setMessageId('<jhfjkhdsjkfhdsjkhfjkdsh@test.com>');
		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);

		$this->imapClientFactory->expects($this->any())
			->method('getClient')
			->willReturn($client);
		$mb = new Mailbox();
		$mb->setName('INBOX');
		$this->mailboxMapper->expects($this->once())
			->method('find')
			->with($account, 'INBOX')
			->willReturn($mb);
		$client->expects($this->once())
			->method('status')
			->willReturn([]);
		$this->imapMessageMapper->expects($this->never())
			->method('removeFlag');
		$this->imapMessageMapper->expects($this->never())
			->method('addFlag');
		$account->expects($this->once())
			->method('getUserId')
			->willReturn('test');
		$this->manager->tagMessage($account, 'INBOX', $message, $tag, true);
	}

	public function testGetThread(): void {
		$account = $this->createStub(Account::class);
		$threadRootId = '<some.message.id@localhost>';

		$this->dbMessageMapper->expects($this->once())
			->method('findThread')
			->with($account, $threadRootId);

		$this->manager->getThread($account, $threadRootId);
	}

	public function testGetMailboxLocalMessageCount(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(42);

		$this->dbMessageMapper->expects($this->once())
			->method('countByMailbox')
			->with($mailbox)
			->willReturn(1234);

		$count = $this->manager->getMailboxLocalMessageCount($mailbox);

		$this->assertSame(1234, $count);
	}

	public function testGetMailAttachments(): void {
		$account = $this->createMock(Account::class);
		$account->expects($this->once())
			->method('getUserId')
			->willReturn('user');
		$attachments = [
			new Attachment(
				null,
				'cat.png',
				'image/png',
				'abcdefg',
				7,
				null,
				null,
			),
		];
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$mailbox = new Mailbox();
		$mailbox->setName('Inbox');
		$message = new Message();
		$message->setUid(123);
		$this->imapClientFactory->expects($this->once())
			->method('getClient')
			->with($account, true, false, false, ImapWorkClass::ACTIVE_CONTENT)
			->willReturn($client);
		$this->imapMessageMapper->expects($this->once())
			->method('getAttachments')
			->with(
				$client,
				$mailbox->getName(),
				$message->getUid(),
				'user',
				[],
			)->willReturn($attachments);
		$result = $this->manager->getMailAttachments($account, $mailbox, $message);
		$this->assertEquals($attachments, $result);
	}

	public function testGetMailAttachmentsFetchesExactPartsThroughOneClient(): void {
		$account = $this->createMock(Account::class);
		$account->expects(self::once())
			->method('getUserId')
			->willReturn('user');
		$attachments = [
			new Attachment(
				'2.2',
				'logo.png',
				'image/png',
				'abcdefg',
				7,
				'logo@example.test',
				'inline',
			),
		];
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$mailbox = new Mailbox();
		$mailbox->setName('Inbox');
		$message = new Message();
		$message->setUid(123);
		$this->imapClientFactory->expects(self::once())
			->method('getClient')
			->with($account, true, false, false, ImapWorkClass::ACTIVE_CONTENT)
			->willReturn($client);
		$this->imapMessageMapper->expects(self::once())
			->method('getAttachments')
			->with($client, 'Inbox', 123, 'user', ['2.2', '2.3'])
			->willReturn($attachments);

		$result = $this->manager->getMailAttachments(
			$account,
			$mailbox,
			$message,
			['2.2', '2.3'],
		);

		self::assertSame($attachments, $result);
	}

	public function testGetMailAttachmentWaitsForOrdinaryCapacity(): void {
		$account = $this->createMock(Account::class);
		$account->expects(self::once())
			->method('getUserId')
			->willReturn('user');
		$attachment = new Attachment(
			'2',
			'cat.png',
			'image/png',
			'abcdefg',
			7,
			null,
			'inline',
		);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$mailbox = new Mailbox();
		$mailbox->setName('Inbox');
		$message = new Message();
		$message->setUid(123);

		$this->imapClientFactory->expects(self::once())
			->method('getClient')
			->with($account, true, false, false, ImapWorkClass::ACTIVE_CONTENT)
			->willReturn($client);
		$this->imapMessageMapper->expects(self::once())
			->method('getAttachment')
			->with($client, 'Inbox', 123, '2', 'user')
			->willReturn($attachment);

		self::assertSame(
			$attachment,
			$this->manager->getMailAttachment($account, $mailbox, $message, '2'),
		);
	}

	public function testCreateTag(): void {
		$this->tagMapper->expects($this->once())
			->method('getTagByImapLabel')
			->willThrowException(new DoesNotExistException('Computer says no'));
		$this->tagMapper->expects($this->once())
			->method('insert')
			->willReturnCallback(static fn (Tag $tag) => $tag);

		$tag = $this->manager->createTag('Hello Hello 👋', '#0082c9', 'admin');

		self::assertEquals('admin', $tag->getUserId());
		self::assertEquals('Hello Hello 👋', $tag->getDisplayName());
		self::assertEquals('$hello_hello_&2d3csw-', $tag->getImapLabel());
		self::assertEquals('#0082c9', $tag->getColor());
	}

	public function testCreateTagSameImapLabel(): void {
		$existingTag = new Tag();
		$existingTag->setUserId('admin');
		$existingTag->setDisplayName('Hello Hello Hello 👋');
		$existingTag->setImapLabel('Hello_Hello_&2D3cSw-');
		$existingTag->setColor('#0082c9');

		$this->tagMapper->expects($this->once())
			->method('getTagByImapLabel')
			->willReturn($existingTag);
		$this->tagMapper->expects($this->never())
			->method('insert');

		$tag = $this->manager->createTag('Hello Hello 👋', '#e9322d', 'admin');

		self::assertEquals('admin', $tag->getUserId());
		self::assertEquals('Hello Hello Hello 👋', $tag->getDisplayName());
		self::assertEquals('Hello_Hello_&2D3cSw-', $tag->getImapLabel());
		self::assertEquals('#0082c9', $tag->getColor());
	}

	public function testCreateTagForFollowUp(): void {
		$this->tagMapper->expects(self::once())
			->method('getTagByImapLabel')
			->willThrowException(new DoesNotExistException('Computer says no'));
		$this->tagMapper->expects(self::once())
			->method('insert')
			->willReturnCallback(static function (Tag $tag) {
				self::assertEquals('admin', $tag->getUserId());
				self::assertEquals('Follow up', $tag->getDisplayName());
				self::assertEquals('$follow_up', $tag->getImapLabel());
				self::assertEquals('#d77000', $tag->getColor());
				return $tag;
			});

		$tag = $this->manager->createTag('Follow up', '#d77000', 'admin');

		self::assertEquals('admin', $tag->getUserId());
		self::assertEquals('Follow up', $tag->getDisplayName());
		self::assertEquals('$follow_up', $tag->getImapLabel());
		self::assertEquals('#d77000', $tag->getColor());
	}

	public function testUpdateTag(): void {
		$existingTag = new Tag();
		$existingTag->setId(100);
		$existingTag->setUserId('admin');
		$existingTag->setDisplayName('Hello Hello Hello 👋');
		$existingTag->setImapLabel('Hello_Hello_&2D3cSw-');
		$existingTag->setColor('#0082c9');

		$this->tagMapper->expects($this->once())
			->method('getTagForUser')
			->willReturn($existingTag);
		$this->tagMapper->expects($this->once())
			->method('update')
			->willReturnCallback(static fn (Tag $tag) => $tag);

		$tag = $this->manager->updateTag(100, 'Hello Hello 👋', '#0082c9', 'admin');

		self::assertEquals('admin', $tag->getUserId());
		self::assertEquals('Hello Hello 👋', $tag->getDisplayName());
		self::assertEquals('Hello_Hello_&2D3cSw-', $tag->getImapLabel());
		self::assertEquals('#0082c9', $tag->getColor());
	}

	public function testUpdateTagUnknownTag(): void {
		$this->expectException(ClientException::class);
		$this->expectExceptionMessage('Tag not found');

		$this->tagMapper->expects($this->once())
			->method('getTagForUser')
			->willThrowException(new DoesNotExistException('Computer says no'));
		$this->tagMapper->expects($this->never())
			->method('update');

		$this->manager->updateTag(100, 'Hello Hello 👋', '#0082c9', 'admin');
	}

	public function testMoveInbox(): void {
		$srcMailboxId = 20;
		$dstMailboxId = 80;
		$threadRootId = 'some-thread-root-id-1';
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setTrashMailboxId(80);
		$account = new Account($mailAccount);
		$srcMailbox = new Mailbox();
		$srcMailbox->setId($srcMailboxId);
		$srcMailbox->setAccountId($mailAccount->getId());
		$srcMailbox->setName('INBOX');
		$this->mailboxMapper
			->expects(self::exactly(2))
			->method('find')
			->with($account, $srcMailbox->getName())
			->willReturn($srcMailbox);
		$this->threadMapper
			->expects(self::once())
			->method('findMessageUidsAndMailboxNamesByAccountAndThreadRoot')
			->with($mailAccount, $threadRootId, false)
			->willReturn([
				['messageUid' => 200, 'mailboxName' => 'INBOX'],
				['messageUid' => 300, 'mailboxName' => 'INBOX'],
			]);
		$dstMailbox = new Mailbox();
		$dstMailbox->setId($dstMailboxId);
		$dstMailbox->setAccountId($mailAccount->getId());
		$dstMailbox->setName('Trash');

		$this->imapMessageMapper
			->expects(self::exactly(2))
			->method('move');
		$this->eventDispatcher
			->expects(self::exactly(2))
			->method('dispatch');

		$this->manager->moveThread(
			$account,
			$srcMailbox,
			$account,
			$dstMailbox,
			$threadRootId
		);
	}

	public function testMoveTrash(): void {
		$srcMailboxId = 20;
		$dstMailboxId = 80;
		$threadRootId = 'some-thread-root-id-1';
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setTrashMailboxId($srcMailboxId);
		$account = new Account($mailAccount);
		$srcMailbox = new Mailbox();
		$srcMailbox->setId($srcMailboxId);
		$srcMailbox->setAccountId($mailAccount->getId());
		$srcMailbox->setName('Trash');
		$this->mailboxMapper
			->expects(self::exactly(2))
			->method('find')
			->with($account, $srcMailbox->getName())
			->willReturn($srcMailbox);
		$this->threadMapper
			->expects(self::once())
			->method('findMessageUidsAndMailboxNamesByAccountAndThreadRoot')
			->with($mailAccount, $threadRootId, true)
			->willReturn([
				['messageUid' => 200, 'mailboxName' => 'Trash'],
				['messageUid' => 300, 'mailboxName' => 'Trash'],
			]);
		$dstMailbox = new Mailbox();
		$dstMailbox->setId($dstMailboxId);
		$dstMailbox->setAccountId($mailAccount->getId());
		$dstMailbox->setName('INBOX');

		$this->imapMessageMapper
			->expects(self::exactly(2))
			->method('move');
		$this->eventDispatcher
			->expects(self::exactly(2))
			->method('dispatch');

		$this->manager->moveThread(
			$account,
			$srcMailbox,
			$account,
			$dstMailbox,
			$threadRootId
		);
	}

	public function testDeleteInbox(): void {
		$mailboxId = 20;
		$trashMailboxId = 80;
		$threadRootId = 'some-thread-root-id-1';
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setTrashMailboxId($trashMailboxId);
		$account = new Account($mailAccount);
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId($mailAccount->getId());
		$mailbox->setName('INBOX');
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->imapClientFactory
			->expects(self::once())
			->method('getClient')
			->with($account, true, true)
			->willReturn($client);
		$client
			->expects(self::once())
			->method('logout');
		$this->mailboxMapper
			->expects(self::once())
			->method('find')
			->with($account, $mailbox->getName())
			->willReturn($mailbox);
		$this->threadMapper
			->expects(self::once())
			->method('findMessageUidsAndMailboxNamesByAccountAndThreadRoot')
			->with($mailAccount, $threadRootId, false)
			->willReturn([
				['messageUid' => 200, 'mailboxName' => 'INBOX'],
				['messageUid' => 300, 'mailboxName' => 'INBOX'],
			]);
		$trashMailbox = new Mailbox();
		$trashMailbox->setId($trashMailboxId);
		$trashMailbox->setAccountId($mailAccount->getId());
		$trashMailbox->setName('Trash');
		$this->mailboxMapper
			->expects(self::once())
			->method('findById')
			->with($trashMailbox->getId())
			->willReturn($trashMailbox);
		$this->imapMessageMapper
			->expects(self::once())
			->method('moveBatch')
			->with($client, 'INBOX', [200, 300], 'Trash');
		$this->eventDispatcher
			->expects(self::exactly(4))
			->method('dispatchTyped');

		$this->manager->deleteThread(
			$account,
			$mailbox,
			$threadRootId
		);
	}

	public function testDeleteTrash(): void {
		$mailboxId = 80;
		$threadRootId = 'some-thread-root-id-1';
		$mailAccount = new MailAccount();
		$mailAccount->setId(1);
		$mailAccount->setTrashMailboxId($mailboxId);
		$account = new Account($mailAccount);
		$mailbox = new Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setAccountId($mailAccount->getId());
		$mailbox->setName('Trash');
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->imapClientFactory
			->expects(self::once())
			->method('getClient')
			->with($account, true, true)
			->willReturn($client);
		$client
			->expects(self::once())
			->method('logout');
		$this->mailboxMapper
			->expects(self::once())
			->method('find')
			->with($account, $mailbox->getName())
			->willReturn($mailbox);
		$this->mailboxMapper
			->expects(self::once())
			->method('findById')
			->with($mailbox->getId())
			->willReturn($mailbox);
		$this->threadMapper
			->expects(self::once())
			->method('findMessageUidsAndMailboxNamesByAccountAndThreadRoot')
			->with($mailAccount, $threadRootId, true)
			->willReturn([
				['messageUid' => 200, 'mailboxName' => 'Trash'],
				['messageUid' => 300, 'mailboxName' => 'Trash'],
			]);
		$this->imapMessageMapper
			->expects(self::once())
			->method('expungeBatch')
			->with($client, 'Trash', [200, 300]);
		$this->eventDispatcher
			->expects(self::exactly(4))
			->method('dispatchTyped');

		$this->manager->deleteThread(
			$account,
			$mailbox,
			$threadRootId
		);
	}
}
