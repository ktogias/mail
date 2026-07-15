<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2017 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Tests\Unit\Service\Attachment;

use ChristophWurst\Nextcloud\Testing\TestCase;
use Horde_Imap_Client_Socket;
use OC\Files\Node\File;
use OCA\Files_Sharing\SharedStorage;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Db\LocalAttachment;
use OCA\Mail\Db\LocalAttachmentMapper;
use OCA\Mail\Db\LocalMessage;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Exception\SmimeDecryptException;
use OCA\Mail\Exception\UploadException;
use OCA\Mail\IMAP\MessageMapper;
use OCA\Mail\Model\IMAPMessage;
use OCA\Mail\Service\Attachment\AttachmentService;
use OCA\Mail\Service\Attachment\AttachmentStorage;
use OCA\Mail\Service\Attachment\UploadedFile;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Files\Folder;
use OCP\Files\IMimeTypeDetector;
use OCP\Files\NotPermittedException;
use OCP\ICache;
use OCP\ICacheFactory;
use OCP\IURLGenerator;
use OCP\Share\IAttributes;
use OCP\Share\IShare;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class AttachmentServiceTest extends TestCase {
	private LocalAttachmentMapper&MockObject $mapper;
	private AttachmentStorage&MockObject $storage;
	private IMailManager&MockObject $mailManager;
	private MessageMapper&MockObject $messageMapper;
	private Folder&MockObject $userFolder;
	private ICache&MockObject $cache;
	private ICacheFactory&MockObject $cacheFactory;
	private IURLGenerator&MockObject $urlGenerator;
	private IMimeTypeDetector&MockObject $mimeTypeDetector;
	private LoggerInterface&MockObject $logger;
	private ITimeFactory&MockObject $timeFactory;
	private AttachmentService $service;

	protected function setUp(): void {
		parent::setUp();

		$this->mapper = $this->createMock(LocalAttachmentMapper::class);
		$this->storage = $this->createMock(AttachmentStorage::class);
		$this->mailManager = $this->createMock(IMailManager::class);
		$this->messageMapper = $this->createMock(MessageMapper::class);
		$this->userFolder = $this->createMock(Folder::class);
		$this->cache = $this->createMock(ICache::class);
		$this->cacheFactory = $this->createMock(ICacheFactory::class);
		$this->cacheFactory->method('createDistributed')->willReturn($this->cache);
		$this->urlGenerator = $this->createMock(IURLGenerator::class);
		$this->mimeTypeDetector = $this->createMock(IMimeTypeDetector::class);
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->timeFactory = $this->createMock(ITimeFactory::class);
		$this->timeFactory->method('getTime')->willReturn(123456);

		$this->service = new AttachmentService(
			$this->userFolder,
			$this->mapper,
			$this->storage,
			$this->mailManager,
			$this->messageMapper,
			$this->cacheFactory,
			$this->urlGenerator,
			$this->mimeTypeDetector,
			$this->logger,
			$this->timeFactory,
		);
	}

	public function testAddFileWithUploadException() {
		$userId = 'jan';
		$uploadedFile = $this->createMock(UploadedFile::class);
		$uploadedFile->expects($this->once())
			->method('getFileName')
			->willReturn('cat.jpg');
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'createdAt' => 123456,
			'disposition' => LocalAttachment::DISPOSITION_ATTACHMENT,
		]);
		$persistedAttachment = LocalAttachment::fromParams([
			'id' => 123,
			'userId' => $userId,
			'fileName' => 'cat.jpg',
		]);

		$this->mapper->expects($this->once())
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturn($persistedAttachment);
		$this->storage->expects($this->once())
			->method('save')
			->with($this->equalTo($userId), $this->equalTo(123), $this->equalTo($uploadedFile))
			->willThrowException(new UploadException());
		$this->mapper->expects($this->once())
			->method('delete')
			->with($this->equalTo($persistedAttachment));
		$this->expectException(UploadException::class);

		$this->service->addFile($userId, $uploadedFile);
	}

	public function testAddFile() {
		$userId = 'jan';
		$uploadedFile = $this->createMock(UploadedFile::class);
		$uploadedFile->expects($this->once())
			->method('getFileName')
			->willReturn('cat.jpg');
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'createdAt' => 123456,
			'disposition' => LocalAttachment::DISPOSITION_ATTACHMENT,
		]);
		$persistedAttachment = LocalAttachment::fromParams([
			'id' => 123,
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'disposition' => LocalAttachment::DISPOSITION_ATTACHMENT,
		]);

		$this->mapper->expects($this->once())
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturn($persistedAttachment);
		$this->storage->expects($this->once())
			->method('save')
			->with($this->equalTo($userId), $this->equalTo(123), $this->equalTo($uploadedFile));

		$this->service->addFile($userId, $uploadedFile);
	}

	public function testAddFileFromStringWithUploadException() {
		$userId = 'jan';
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'image/jpg',
			'contentId' => null,
			'disposition' => null,
			'createdAt' => 123456,
		]);
		$persistedAttachment = LocalAttachment::fromParams([
			'id' => 123,
			'userId' => $userId,
			'mimeType' => 'image/jpg',
			'fileName' => 'cat.jpg',
		]);

		$this->mapper->expects($this->once())
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturn($persistedAttachment);
		$this->storage->expects($this->once())
			->method('saveContent')
			->with($this->equalTo($userId), $this->equalTo(123), $this->equalTo('Lorem ipsum dolor sit amet'))
			->willThrowException(new NotPermittedException());
		$this->mapper->expects($this->once())
			->method('delete')
			->with($this->equalTo($persistedAttachment));
		$this->expectException(UploadException::class);

		$this->service->addFileFromString($userId, 'cat.jpg', 'image/jpg', 'Lorem ipsum dolor sit amet', null, null);
	}

	public function testAddFileFromString() {
		$userId = 'jan';
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'image/jpg',
			'createdAt' => 123456,
		]);
		$persistedAttachment = LocalAttachment::fromParams([
			'id' => 123,
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'image/jpg',
		]);

		$this->mapper->expects($this->once())
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturn($persistedAttachment);
		$this->storage->expects($this->once())
			->method('saveContent')
			->with($this->equalTo($userId), $this->equalTo(123), $this->equalTo('Lorem ipsum dolor sit amet'));

		$this->service->addFileFromString(
			$userId,
			'cat.jpg',
			'image/jpg',
			'Lorem ipsum dolor sit amet',
			null,
			null,
		);
	}

	public function testDeleteAttachment(): void {
		$userId = 'linus';

		$this->mapper->expects(self::once())
			->method('find')
			->with($userId, '1')
			->willReturn(new LocalAttachment());
		$this->storage->expects(self::once())
			->method('delete')
			->with($userId, 1);

		$this->service->deleteAttachment($userId, 1);
	}

	public function testDeleteAttachmentNotFound(): void {
		$userId = 'linus';

		$this->mapper->expects(self::once())
			->method('find')
			->with($userId, '1')
			->willThrowException(new DoesNotExistException(''));
		$this->storage->expects(self::once())
			->method('delete')
			->with($userId, 1);

		$this->service->deleteAttachment($userId, 1);
	}

	public function testDeleteLocalMessageAttachment() : void {
		$userId = 'linus';
		$attachment = new LocalAttachment();
		$attachment->setId(22);
		$attachments = [$attachment];

		$this->mapper->expects(self::once())
			->method('findByLocalMessageId')
			->with($userId, '10')
			->willReturn($attachments);
		$this->mapper->expects(self::once())
			->method('deleteForLocalMessage')
			->with($userId, '10');
		$this->storage->expects(self::once())
			->method('delete')
			->with($userId, $attachment->getId());

		$this->service->deleteLocalMessageAttachments($userId, 10);
	}

	public function testSaveLocalMessageAttachment(): void {
		$userId = 'linus';
		$attachmentIds = [1,2,3];
		$messageId = 100;

		$this->mapper->expects(self::once())
			->method('saveLocalMessageAttachments')
			->with($userId, $messageId, $attachmentIds);
		$this->mapper->expects(self::once())
			->method('findByLocalMessageId')
			->with($userId, $messageId)
			->willReturn([$this->createMock(LocalAttachment::class)]);

		$this->service->saveLocalMessageAttachments($userId, $messageId, $attachmentIds);
	}

	public function testSaveLocalMessageAttachmentNoAttachmentIds(): void {
		$userId = 'linus';
		$attachmentIds = [];
		$messageId = 100;

		$this->mapper->expects(self::never())
			->method('saveLocalMessageAttachments');
		$this->mapper->expects(self::never())
			->method('findByLocalMessageId');

		$this->service->saveLocalMessageAttachments($userId, $messageId, $attachmentIds);
	}

	public function testhandleLocalMessageAttachment(): void {
		$account = $this->createStub(Account::class);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$attachments = [
			[
				'type' => 'local',
				'id' => 1
			]
		];
		$result = $this->service->handleAttachments($account, $attachments, $client, 1);
		$this->assertEquals([1], $result);
	}

	public function testHandleAttachmentsForwardedMessageAttachment(): void {
		$userId = 'linus';
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
			'createdAt' => 123456,
			'disposition' => 'attachment'
		]);
		$persistedAttachment = LocalAttachment::fromParams([
			'id' => 123,
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		]);
		$account = $this->createConfiguredMock(Account::class, [
			'getUserId' => $userId
		]);
		$message = new Message();
		$message->setUid(123);
		$message->setMailboxId(1);
		$mailbox = new Mailbox();
		$mailbox->setName('INBOX');
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$attachments = [
			'type' => 'message',
			'id' => 123,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		];

		$this->mailManager->expects(self::once())
			->method('getMessage')
			->with($account->getUserId(), 123)
			->willReturn($message);
		$this->mailManager->expects(self::once())
			->method('getMailbox')
			->with($account->getUserId())
			->willReturn($mailbox);
		$this->messageMapper->expects(self::once())
			->method('getFullText')
			->with($client, $mailbox->getName(), $message->getUid(), $userId)
			->willReturn('Lorem ipsum dolor sit amet');
		$this->mapper->expects($this->once())
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturn($persistedAttachment);
		$this->storage->expects($this->once())
			->method('saveContent')
			->with($this->equalTo($userId), $this->equalTo(123), $this->equalTo('Lorem ipsum dolor sit amet'));
		$this->service->handleAttachments($account, [$attachments], $client, 1);
	}

	/**
	 * Same redundant-refetch issue as handleForwardedAttachment(), applied
	 * to forwarding a whole other message: a second autosave of the same
	 * draft, forwarding the same message, must be a cache hit rather than a
	 * second live IMAP getFullText() round-trip.
	 */
	public function testHandleAttachmentsForwardedMessageAttachmentReusesCachedLocalCopyOnSecondAutosave(): void {
		$userId = 'linus';
		$localMessageId = 42;
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
			'createdAt' => 123456,
			'disposition' => 'attachment'
		]);
		$persistedAttachment = LocalAttachment::fromParams([
			'id' => 123,
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		]);
		$account = $this->createConfiguredMock(Account::class, [
			'getUserId' => $userId
		]);
		$message = new Message();
		$message->setUid(123);
		$message->setMailboxId(1);
		$mailbox = new Mailbox();
		$mailbox->setName('INBOX');
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$attachmentPayload = [
			'type' => 'message',
			'id' => 123,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		];

		$store = [];
		$this->cache->method('get')->willReturnCallback(function ($key) use (&$store) {
			return $store[$key] ?? null;
		});
		$this->cache->method('set')->willReturnCallback(function ($key, $value) use (&$store) {
			$store[$key] = $value;
			return true;
		});

		$this->mailManager->expects(self::once())
			->method('getMessage')
			->with($account->getUserId(), 123)
			->willReturn($message);
		$this->mailManager->expects(self::once())
			->method('getMailbox')
			->with($account->getUserId())
			->willReturn($mailbox);
		$this->messageMapper->expects(self::once())
			->method('getFullText')
			->with($client, $mailbox->getName(), $message->getUid(), $userId)
			->willReturn('Lorem ipsum dolor sit amet');
		// insert() is mocked, so it can't reproduce QBMapper's real
		// behavior of mutating the passed entity in place to assign its
		// id -- addFileFromString() returns that same entity instance
		// (not insert()'s return value), so the mock must mutate it too,
		// or getId() would stay null here.
		$this->mapper->expects(self::once())
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturnCallback(function (LocalAttachment $a) {
				$a->setId(123);
				return $a;
			});
		$this->storage->expects(self::once())
			->method('saveContent')
			->with($this->equalTo($userId), $this->equalTo(123), $this->equalTo('Lorem ipsum dolor sit amet'));
		$this->mapper->method('find')
			->with($userId, 123)
			->willReturn($persistedAttachment);

		$first = $this->service->handleAttachments($account, [$attachmentPayload], $client, $localMessageId);
		$second = $this->service->handleAttachments($account, [$attachmentPayload], $client, $localMessageId);

		$this->assertEquals([123], $first);
		$this->assertEquals([123], $second);
	}

	public function testHandleAttachmentsForwardedAttachment(): void {
		$userId = 'linus';
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
			'contentId' => null,
			'disposition' => 'attachment',
			'createdAt' => 123456,
		]);
		$persistedAttachment = LocalAttachment::fromParams([
			'id' => 123,
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		]);
		$account = $this->createConfiguredMock(Account::class, [
			'getUserId' => $userId
		]);

		$mailbox = new Mailbox();
		$mailbox->setId(9);
		$mailbox->setName('INBOX');
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$attachments = [
			'type' => 'message-attachment',
			'mailboxId' => $mailbox->getId(),
			'uid' => 999,
			'id' => '2',
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		];
		$imapAttachment = new \OCA\Mail\Attachment(
			'2',
			'cat.jpg',
			'text/plain',
			'Lorem ipsum dolor sit amet',
			strlen('Lorem ipsum dolor sit amet'),
			null,
			'attachment',
		);

		$this->mailManager->expects(self::once())
			->method('getMailbox')
			->with($account->getUserId(), $mailbox->getId())
			->willReturn($mailbox);
		$this->messageMapper->expects(self::once())
			->method('getAttachment')
			->with($client, $mailbox->getName(), 999, '2', $userId)
			->willReturn($imapAttachment);
		$this->mapper->expects($this->once())
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturn($persistedAttachment);
		$this->storage->expects($this->once())
			->method('saveContent')
			->with($this->equalTo($userId), $this->equalTo(123), $this->equalTo('Lorem ipsum dolor sit amet'));

		$this->service->handleAttachments($account, [$attachments], $client, 1);
	}

	/**
	 * Confirmed live: a reply carrying 19 forwarded/inline attachments made
	 * every draft autosave re-fetch every single one of them over a fresh
	 * IMAP round-trip, even though the previous autosave had already fetched
	 * the exact same attachments moments earlier -- each autosave took
	 * 28-64s as a result. The second (and every later) autosave of the same
	 * draft, referencing the same original attachment, must be a cache hit:
	 * no IMAP round-trip, no new local copy, the same id reused.
	 */
	public function testHandleAttachmentsForwardedAttachmentReusesCachedLocalCopyOnSecondAutosave(): void {
		$userId = 'linus';
		$localMessageId = 42;
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
			'contentId' => null,
			'disposition' => 'attachment',
			'createdAt' => 123456,
		]);
		$persistedAttachment = LocalAttachment::fromParams([
			'id' => 123,
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		]);
		$account = $this->createConfiguredMock(Account::class, [
			'getUserId' => $userId
		]);
		$mailbox = new Mailbox();
		$mailbox->setId(9);
		$mailbox->setName('INBOX');
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$attachmentPayload = [
			'type' => 'message-attachment',
			'mailboxId' => $mailbox->getId(),
			'uid' => 999,
			'id' => '2',
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		];
		$imapAttachment = new \OCA\Mail\Attachment(
			'2',
			'cat.jpg',
			'text/plain',
			'Lorem ipsum dolor sit amet',
			strlen('Lorem ipsum dolor sit amet'),
			null,
			'attachment',
		);

		// A tiny fake backing store so the cache genuinely remembers what
		// was set between the two handleAttachments() calls below -- an
		// always-null mock cache would never exercise the reuse path this
		// test exists to prove.
		$store = [];
		$this->cache->method('get')->willReturnCallback(function ($key) use (&$store) {
			return $store[$key] ?? null;
		});
		$this->cache->method('set')->willReturnCallback(function ($key, $value) use (&$store) {
			$store[$key] = $value;
			return true;
		});

		$this->mailManager->expects(self::once())
			->method('getMailbox')
			->with($account->getUserId(), $mailbox->getId())
			->willReturn($mailbox);
		$this->messageMapper->expects(self::once())
			->method('getAttachment')
			->with($client, $mailbox->getName(), 999, '2', $userId)
			->willReturn($imapAttachment);
		// insert() is mocked, so it can't reproduce QBMapper's real
		// behavior of mutating the passed entity in place to assign its
		// id -- addFileFromString() returns that same entity instance
		// (not insert()'s return value), so the mock must mutate it too,
		// or getId() would stay null here.
		$this->mapper->expects(self::once())
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturnCallback(function (LocalAttachment $a) {
				$a->setId(123);
				return $a;
			});
		$this->storage->expects(self::once())
			->method('saveContent')
			->with($this->equalTo($userId), $this->equalTo(123), $this->equalTo('Lorem ipsum dolor sit amet'));
		$this->mapper->method('find')
			->with($userId, 123)
			->willReturn($persistedAttachment);

		$first = $this->service->handleAttachments($account, [$attachmentPayload], $client, $localMessageId);
		$second = $this->service->handleAttachments($account, [$attachmentPayload], $client, $localMessageId);

		$this->assertEquals([123], $first);
		$this->assertEquals([123], $second);
	}

	/**
	 * oc_mail_attachments.local_message_id is single-owner: reusing the same
	 * local copy across two different drafts would silently steal it from
	 * whichever draft "loses". Two drafts referencing the same original
	 * attachment must each get their own independent local copy.
	 */
	public function testHandleAttachmentsForwardedAttachmentDoesNotShareCacheAcrossDifferentDrafts(): void {
		$userId = 'linus';
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
			'contentId' => null,
			'disposition' => 'attachment',
			'createdAt' => 123456,
		]);
		$account = $this->createConfiguredMock(Account::class, [
			'getUserId' => $userId
		]);
		$mailbox = new Mailbox();
		$mailbox->setId(9);
		$mailbox->setName('INBOX');
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$attachmentPayload = [
			'type' => 'message-attachment',
			'mailboxId' => $mailbox->getId(),
			'uid' => 999,
			'id' => '2',
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		];
		$imapAttachment = new \OCA\Mail\Attachment(
			'2',
			'cat.jpg',
			'text/plain',
			'Lorem ipsum dolor sit amet',
			strlen('Lorem ipsum dolor sit amet'),
			null,
			'attachment',
		);

		$store = [];
		$this->cache->method('get')->willReturnCallback(function ($key) use (&$store) {
			return $store[$key] ?? null;
		});
		$this->cache->method('set')->willReturnCallback(function ($key, $value) use (&$store) {
			$store[$key] = $value;
			return true;
		});

		$this->mailManager->method('getMailbox')->willReturn($mailbox);
		$this->messageMapper->expects(self::exactly(2))
			->method('getAttachment')
			->willReturn($imapAttachment);
		// insert() is mocked, so it can't reproduce QBMapper's real
		// behavior of mutating the passed entity in place to assign its
		// id -- addFileFromString() returns that same entity instance
		// (not insert()'s return value), so the mock must mutate it too,
		// assigning a different id per call the same way two independent
		// real inserts would.
		$idsToAssign = [123, 456];
		$insertCallCount = 0;
		$this->mapper->expects(self::exactly(2))
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturnCallback(function (LocalAttachment $a) use ($idsToAssign, &$insertCallCount) {
				$a->setId($idsToAssign[$insertCallCount]);
				$insertCallCount++;
				return $a;
			});
		$this->storage->expects(self::exactly(2))->method('saveContent');

		$forDraft42 = $this->service->handleAttachments($account, [$attachmentPayload], $client, 42);
		$forDraft43 = $this->service->handleAttachments($account, [$attachmentPayload], $client, 43);

		$this->assertEquals([123], $forDraft42);
		$this->assertEquals([456], $forDraft43);
	}

	/**
	 * A cache entry can outlive the row it points at (e.g. the referenced
	 * local attachment got deleted independently between two autosaves). A
	 * stale hit must fall back to a fresh IMAP fetch, not surface a broken
	 * reference or skip attaching the file entirely.
	 */
	public function testHandleAttachmentsForwardedAttachmentRefetchesIfCachedLocalCopyWasDeleted(): void {
		$userId = 'linus';
		$localMessageId = 42;
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
			'contentId' => null,
			'disposition' => 'attachment',
			'createdAt' => 123456,
		]);
		$account = $this->createConfiguredMock(Account::class, [
			'getUserId' => $userId
		]);
		$mailbox = new Mailbox();
		$mailbox->setId(9);
		$mailbox->setName('INBOX');
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$attachmentPayload = [
			'type' => 'message-attachment',
			'mailboxId' => $mailbox->getId(),
			'uid' => 999,
			'id' => '2',
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		];
		$imapAttachment = new \OCA\Mail\Attachment(
			'2',
			'cat.jpg',
			'text/plain',
			'Lorem ipsum dolor sit amet',
			strlen('Lorem ipsum dolor sit amet'),
			null,
			'attachment',
		);

		$store = [];
		$this->cache->method('get')->willReturnCallback(function ($key) use (&$store) {
			return $store[$key] ?? null;
		});
		$this->cache->method('set')->willReturnCallback(function ($key, $value) use (&$store) {
			$store[$key] = $value;
			return true;
		});

		$this->mailManager->method('getMailbox')->willReturn($mailbox);
		$this->messageMapper->expects(self::exactly(2))
			->method('getAttachment')
			->willReturn($imapAttachment);
		// insert() is mocked, so it can't reproduce QBMapper's real
		// behavior of mutating the passed entity in place to assign its
		// id -- addFileFromString() returns that same entity instance
		// (not insert()'s return value), so the mock must mutate it too.
		$idsToAssign = [123, 456];
		$insertCallCount = 0;
		$this->mapper->expects(self::exactly(2))
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturnCallback(function (LocalAttachment $a) use ($idsToAssign, &$insertCallCount) {
				$a->setId($idsToAssign[$insertCallCount]);
				$insertCallCount++;
				return $a;
			});
		$this->storage->expects(self::exactly(2))->method('saveContent');
		// The cached copy (id 123) was deleted independently between the
		// two autosaves -- looking it up must fail, forcing a fresh fetch.
		$this->mapper->method('find')
			->with($userId, 123)
			->willThrowException(new DoesNotExistException('gone'));

		$first = $this->service->handleAttachments($account, [$attachmentPayload], $client, $localMessageId);
		$second = $this->service->handleAttachments($account, [$attachmentPayload], $client, $localMessageId);

		$this->assertEquals([123], $first);
		$this->assertEquals([456], $second);
	}

	public function testHandleAttachmentsForwardedInlineAttachmentPreservesContentId(): void {
		$userId = 'linus';
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'logo.png',
			'mimeType' => 'image/png',
			'contentId' => 'img001@example.com',
			'disposition' => 'inline',
			'createdAt' => 123456,
		]);
		$persistedAttachment = LocalAttachment::fromParams([
			'id' => 456,
			'userId' => $userId,
			'fileName' => 'logo.png',
			'mimeType' => 'image/png',
		]);
		$account = $this->createConfiguredMock(Account::class, [
			'getUserId' => $userId
		]);

		$mailbox = new Mailbox();
		$mailbox->setId(9);
		$mailbox->setName('INBOX');
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$attachments = [
			'type' => 'message-attachment-inline',
			'mailboxId' => $mailbox->getId(),
			'uid' => 999,
			'id' => '3',
			'fileName' => 'logo.png',
			'mimeType' => 'image/png',
		];
		$imapAttachment = new \OCA\Mail\Attachment(
			'3',
			'logo.png',
			'image/png',
			'fake png content',
			strlen('fake png content'),
			'img001@example.com',
			'inline',
		);

		$this->mailManager->expects(self::once())
			->method('getMailbox')
			->with($account->getUserId(), $mailbox->getId())
			->willReturn($mailbox);
		$this->messageMapper->expects(self::once())
			->method('getAttachment')
			->with($client, $mailbox->getName(), 999, '3', $userId)
			->willReturn($imapAttachment);
		$this->mapper->expects($this->once())
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturn($persistedAttachment);
		$this->storage->expects($this->once())
			->method('saveContent')
			->with($this->equalTo($userId), $this->equalTo(456), $this->equalTo('fake png content'));

		$this->service->handleAttachments($account, [$attachments], $client, 1);
	}

	public function testHandleAttachmentsCloudAttachmentNoDownloadPermission(): void {
		$userId = 'linus';
		$storage = $this->createMock(SharedStorage::class);
		$storage->expects(self::once())
			->method('instanceOfStorage')
			->with(SharedStorage::class)
			->willReturn(true);
		$share = $this->createMock(IShare::class);
		$attributes = $this->createMock(IAttributes::class);
		$attributes->expects(self::once())
			->method('getAttribute')
			->with('permissions', 'download')
			->willReturn(false);
		$share->expects(self::once())
			->method('getAttributes')
			->willReturn($attributes);
		$storage->expects(self::once())
			->method('getShare')
			->willReturn($share);

		$file = $this->createConfiguredMock(File::class, [
			'getName' => 'cat.jpg',
			'getMimeType' => 'text/plain',
			'getContent' => 'Lorem ipsum dolor sit amet',
			'getStorage' => $storage
		]);
		$account = $this->createConfiguredMock(Account::class, [
			'getUserId' => $userId
		]);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$attachments = [
			'type' => 'cloud',
			'messageId' => 999,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		];
		$this->userFolder->expects(self::once())
			->method('nodeExists')
			->with('cat.jpg')
			->willReturn(true);
		$this->userFolder->expects(self::once())
			->method('get')
			->with('cat.jpg')
			->willReturn($file);

		$result = $this->service->handleAttachments($account, [$attachments], $client, 1);
		$this->assertEquals([], $result);

	}

	public function testHandleAttachmentsCloudAttachment(): void {
		$userId = 'linus';
		$file = $this->createConfiguredMock(File::class, [
			'getName' => 'cat.jpg',
			'getMimeType' => 'text/plain',
			'getContent' => 'Lorem ipsum dolor sit amet',
			'getStorage' => $this->createMock(SharedStorage::class)
		]);
		$account = $this->createConfiguredMock(Account::class, [
			'getUserId' => $userId
		]);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$attachment = LocalAttachment::fromParams([
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
			'createdAt' => 123456,
			'disposition' => 'attachment'
		]);
		$persistedAttachment = LocalAttachment::fromParams([
			'id' => 123,
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		]);
		$attachments = [
			'type' => 'cloud',
			'messageId' => 999,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		];

		$this->userFolder->expects(self::once())
			->method('nodeExists')
			->with('cat.jpg')
			->willReturn(true);
		$this->userFolder->expects(self::once())
			->method('get')
			->with('cat.jpg')
			->willReturn($file);
		$this->mapper->expects($this->once())
			->method('insert')
			->with($this->equalTo($attachment))
			->willReturn($persistedAttachment);
		$this->storage->expects($this->once())
			->method('saveContent')
			->with($this->equalTo($userId), $this->equalTo(123), $this->equalTo('Lorem ipsum dolor sit amet'));

		$this->service->handleAttachments($account, [$attachments], $client, 1);
	}

	public function testUpdateLocalMessageAttachments(): void {
		$userId = 'linus';
		$message = new LocalMessage();
		$message->setId(100);
		$a1 = new LocalAttachment();
		$a1->setId(4);
		$a2 = new LocalAttachment();
		$a2->setId(5);
		$attachmentIds = [4,5];
		$this->mapper->expects(self::once())
			->method('saveLocalMessageAttachments')
			->with($userId, $message->getId(), $attachmentIds);
		$this->mapper->expects(self::once())
			->method('findByLocalMessageId')
			->with($userId, $message->getId())
			->willReturn([$a1, $a2]);
		$this->service->updateLocalMessageAttachments($userId, $message, $attachmentIds);
	}

	public function testUpdateLocalMessageAttachmentsNoAttachments(): void {
		$userId = 'linus';
		$message = new LocalMessage();
		$message->setId(100);
		$attachmentIds = [];
		$attachment = LocalAttachment::fromParams([
			'id' => 5678,
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		]);
		$this->mapper->expects(self::once())
			->method('findByLocalMessageId')
			->with($userId, $message->getId())
			->willReturn([$attachment]);
		$this->mapper->expects(self::once())
			->method('deleteForLocalMessage')
			->with($userId, $message->getId());
		$this->storage->expects(self::once())
			->method('delete')
			->with($userId, 5678);
		$this->service->updateLocalMessageAttachments($userId, $message, $attachmentIds);
	}

	public function testGetAttachmentNamesCacheHit(): void {
		// Arrange
		$account = $this->createConfiguredMock(Account::class, ['getUserId' => 'user1', 'getId' => 1]);
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$message = new Message();
		$message->setUid(3);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$cached = [['id' => '1.2', 'fileName' => 'file.pdf', 'mime' => 'application/pdf', 'downloadUrl' => 'http://example.test/dl', 'mimeUrl' => 'http://example.test/mime']];
		$this->cache->expects(self::once())->method('get')->willReturn($cached);
		$this->mailManager->expects(self::never())->method('getImapMessage');

		// Act
		$result = $this->service->getAttachmentNames($account, $mailbox, $message, $client);

		// Assert
		$this->assertSame($cached, $result);
	}

	public function testGetAttachmentNamesEarlyExitNoAttachments(): void {
		// Arrange
		$account = $this->createConfiguredMock(Account::class, ['getUserId' => 'user1', 'getId' => 1]);
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$message = new Message();
		$message->setUid(3);
		$message->setStructureAnalyzed(true);
		$message->setFlagAttachments(false);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$this->cache->expects(self::never())->method('get');
		$this->mailManager->expects(self::never())->method('getImapMessage');

		// Act
		$result = $this->service->getAttachmentNames($account, $mailbox, $message, $client);

		// Assert
		$this->assertSame([], $result);
	}

	public function testGetAttachmentNamesCacheHitEmptyArray(): void {
		// Arrange
		$account = $this->createConfiguredMock(Account::class, ['getUserId' => 'user1', 'getId' => 1]);
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$message = new Message();
		$message->setUid(3);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$this->cache->expects(self::once())->method('get')->willReturn([]);
		$this->mailManager->expects(self::never())->method('getImapMessage');

		// Act
		$result = $this->service->getAttachmentNames($account, $mailbox, $message, $client);

		// Assert
		$this->assertSame([], $result);
	}

	public function testGetAttachmentNamesCacheMissWithAttachments(): void {
		// Arrange
		$account = $this->createConfiguredMock(Account::class, ['getUserId' => 'user1', 'getId' => 1]);
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$message = new Message();
		$message->setUid(3);
		$message->setId(99);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$imapMessage = $this->createMock(IMAPMessage::class);
		$this->cache->expects(self::once())->method('get')->willReturn(null);
		$this->mailManager->expects(self::once())
			->method('getImapMessage')
			->with($client, $account, $mailbox, 3, true)
			->willReturn($imapMessage);
		$imapMessage->expects(self::once())
			->method('getAttachments')
			->willReturn([['id' => '1.2', 'fileName' => 'file.pdf', 'mime' => 'application/pdf']]);
		$this->urlGenerator->method('linkToRouteAbsolute')->willReturn('http://example.test/dl');
		$this->mimeTypeDetector->method('mimeTypeIcon')->willReturn('http://example.test/mime');
		$this->cache->expects(self::once())->method('set');

		// Act
		$result = $this->service->getAttachmentNames($account, $mailbox, $message, $client);

		// Assert
		$this->assertCount(1, $result);
		$this->assertSame('1.2', $result[0]['id']);
		$this->assertSame('file.pdf', $result[0]['fileName']);
	}

	public function testGetAttachmentNamesCacheMissNoAttachments(): void {
		// Arrange
		$account = $this->createConfiguredMock(Account::class, ['getUserId' => 'user1', 'getId' => 1]);
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$message = new Message();
		$message->setUid(3);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$imapMessage = $this->createMock(IMAPMessage::class);
		$this->cache->expects(self::once())->method('get')->willReturn(null);
		$this->mailManager->expects(self::once())->method('getImapMessage')->willReturn($imapMessage);
		$imapMessage->expects(self::once())->method('getAttachments')->willReturn([]);
		$this->cache->expects(self::once())->method('set')->with(self::anything(), []);

		// Act
		$result = $this->service->getAttachmentNames($account, $mailbox, $message, $client);

		// Assert
		$this->assertSame([], $result);
	}

	public function testGetAttachmentNamesSmimeDecryptException(): void {
		// Arrange
		$account = $this->createConfiguredMock(Account::class, ['getUserId' => 'user1', 'getId' => 1]);
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$message = new Message();
		$message->setUid(3);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$this->cache->expects(self::once())->method('get')->willReturn(null);
		$this->mailManager->expects(self::once())
			->method('getImapMessage')
			->willThrowException(new SmimeDecryptException());
		$this->logger->expects(self::once())->method('debug');
		$this->cache->expects(self::once())->method('set')->with(self::anything(), []);

		// Act
		$result = $this->service->getAttachmentNames($account, $mailbox, $message, $client);

		// Assert
		$this->assertSame([], $result);
	}

	public function testGetAttachmentNamesServiceException(): void {
		// Arrange
		$account = $this->createConfiguredMock(Account::class, ['getUserId' => 'user1', 'getId' => 1]);
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$message = new Message();
		$message->setUid(3);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$this->cache->expects(self::once())->method('get')->willReturn(null);
		$this->mailManager->expects(self::once())
			->method('getImapMessage')
			->willThrowException(new ServiceException());
		$this->logger->expects(self::once())->method('warning');
		$this->cache->expects(self::once())->method('set')->with(self::anything(), []);

		// Act
		$result = $this->service->getAttachmentNames($account, $mailbox, $message, $client);

		// Assert
		$this->assertSame([], $result);
	}

	public function testUpdateLocalMessageAttachmentsDiffAttachments(): void {
		$userId = 'linus';
		$message = new LocalMessage();
		$message->setId(100);
		$newAttachmentIds = [3, 4];
		$a1 = LocalAttachment::fromParams([
			'id' => 2,
			'userId' => $userId,
			'fileName' => 'cat.jpg',
			'mimeType' => 'text/plain',
		]);
		$a2 = LocalAttachment::fromParams([
			'id' => 3,
			'userId' => $userId,
			'fileName' => 'dog.jpg',
			'mimeType' => 'text/plain',
		]);
		$message->setAttachments([$a1, $a2]);

		$this->mapper->expects(self::once())
			->method('saveLocalMessageAttachments')
			->with($userId, $message->getId(), [ 1 => 4]);
		$this->mapper->expects(self::once())
			->method('findByIds')
			->with($userId, [2])
			->willReturn([$a1]);
		$this->mapper->expects(self::once())
			->method('delete')
			->with($a1);
		$this->storage->expects(self::once())
			->method('delete')
			->with($userId, 2);
		$this->service->updateLocalMessageAttachments($userId, $message, $newAttachmentIds);
	}
}
