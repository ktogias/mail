<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2016-2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-FileCopyrightText: 2015-2016 ownCloud, Inc.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Tests\Unit\Controller;

use ChristophWurst\Nextcloud\Testing\TestCase;
use Horde_Imap_Client_Socket;
use OC\AppFramework\Http\Request;
use OC\Memcache\NullCache;
use OC\Security\CSP\ContentSecurityPolicyNonceManager;
use OCA\Mail\Account;
use OCA\Mail\Attachment;
use OCA\Mail\Contracts\IDkimService;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Contracts\IMailTransmission;
use OCA\Mail\Contracts\ITrustedSenderService;
use OCA\Mail\Contracts\IUserPreferences;
use OCA\Mail\Controller\MessagesController;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message as DbMessage;
use OCA\Mail\Db\Tag;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\MessageSourceUnavailableException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Http\AttachmentDownloadResponse;
use OCA\Mail\Http\HtmlResponse;
use OCA\Mail\Http\TrapError;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\Model\IMAPMessage;
use OCA\Mail\Model\Message;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\AiIntegrations\AiIntegrationsService;
use OCA\Mail\Service\DelegationService;
use OCA\Mail\Service\InlineAttachmentCache;
use OCA\Mail\Service\ItineraryService;
use OCA\Mail\Service\MailManager;
use OCA\Mail\Service\SmimeService;
use OCA\Mail\Service\SnoozeService;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\ZipResponse;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Files\Folder;
use OCP\Files\IMimeTypeDetector;
use OCP\ICache;
use OCP\ICacheFactory;
use OCP\IL10N;
use OCP\IRequest;
use OCP\IURLGenerator;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;
use ReflectionMethod;
use ReflectionObject;

class MessagesControllerTest extends TestCase {
	/** @var string */
	private $appName;

	/** @var MockObject|IRequest */
	private $request;

	/** @var MockObject|AccountService */
	private $accountService;

	/** @var MockObject|MailManager */
	private $mailManager;

	/** @var MockObject|IMailSearch */
	private $mailSearch;

	/** @var ItineraryService|MockObject */
	private $itineraryService;

	/** @var string */
	private $userId;

	/** @var MockObject|Folder */
	private $userFolder;

	/** @var MockObject|LoggerInterface */
	private $logger;

	/** @var MockObject|IL10N */
	private $l10n;

	/** @var MessagesController */
	private $controller;

	/** @var MockObject|Account */
	private $account;

	/** @var MockObject|Message */
	private $message;

	/** @var MockObject|Attachment */
	private $attachment;

	/** @var MockObject|IMimeTypeDetector */
	private $mimeTypeDetector;

	/** @var MockObject|IURLGenerator */
	private $urlGenerator;

	/** @var MockObject|ContentSecurityPolicyNonceManager */
	private $nonceManager;

	/** @var MockObject|ITrustedSenderService */
	private $trustedSenderService;

	/** @var MockObject|IMailTransmission */
	private $mailTransmission;

	/** @var ITimeFactory */
	private $oldFactory;

	/** @var MockObject|SmimeService */
	private $smimeService;

	/** @var MockObject|IMAPClientFactory */
	private $clientFactory;
	private IDkimService $dkimService;

	/** @var MockObject|IUserPreferences */
	private $userPreferences;
	private SnoozeService $snoozeService;

	/** @var MockObject|AiIntegrationsService */
	private $aiIntegrationsService;

	private ICacheFactory&MockObject $cacheFactory;

	private DelegationService|MockObject $delegationService;
	private InlineAttachmentCache|MockObject $inlineAttachmentCache;

	protected function setUp(): void {
		parent::setUp();

		$this->appName = 'mail';
		$this->request = $this->getMockBuilder(IRequest::class)->getMock();
		$this->accountService = $this->createMock(AccountService::class);
		$this->mailManager = $this->createMock(IMailManager::class);
		$this->mailSearch = $this->createMock(IMailSearch::class);
		$this->itineraryService = $this->createMock(ItineraryService::class);
		$this->userId = 'john';
		$this->userFolder = $this->createMock(Folder::class);
		$this->request = $this->createMock(Request::class);
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->l10n = $this->createMock(IL10N::class);
		$this->mimeTypeDetector = $this->createMock(IMimeTypeDetector::class);
		$this->urlGenerator = $this->createMock(IURLGenerator::class);
		$this->nonceManager = $this->createMock(ContentSecurityPolicyNonceManager::class);
		$this->trustedSenderService = $this->createMock(ITrustedSenderService::class);
		$this->mailTransmission = $this->createMock(IMailTransmission::class);
		$this->smimeService = $this->createMock(SmimeService::class);
		$this->clientFactory = $this->createMock(IMAPClientFactory::class);
		$this->dkimService = $this->createMock(IDkimService::class);
		$this->userPreferences = $this->createMock(IUserPreferences::class);
		$this->snoozeService = $this->createMock(SnoozeService::class);
		$this->aiIntegrationsService = $this->createMock(AiIntegrationsService::class);
		$this->cacheFactory = $this->createMock(ICacheFactory::class);

		$this->cacheFactory->method('createDistributed')
			->willReturn(new NullCache());

		$this->delegationService = $this->createMock(DelegationService::class);
		$this->delegationService->method('resolveMessageUserId')->willReturn($this->userId);
		$this->delegationService->method('resolveMailboxUserId')->willReturn($this->userId);
		$this->inlineAttachmentCache = $this->createMock(InlineAttachmentCache::class);

		$timeFactory = $this->createMocK(ITimeFactory::class);
		$timeFactory->expects($this->any())
			->method('getTime')
			->willReturn(10000);
		$this->oldFactory = \OC::$server->offsetGet(ITimeFactory::class);
		\OC::$server->registerService(ITimeFactory::class, fn () => $timeFactory);

		$this->controller = new MessagesController(
			$this->appName,
			$this->request,
			$this->accountService,
			$this->mailManager,
			$this->mailSearch,
			$this->itineraryService,
			$this->userId,
			$this->userFolder,
			$this->logger,
			$this->l10n,
			$this->mimeTypeDetector,
			$this->urlGenerator,
			$this->nonceManager,
			$this->trustedSenderService,
			$this->mailTransmission,
			$this->smimeService,
			$this->clientFactory,
			$this->dkimService,
			$this->userPreferences,
			$this->snoozeService,
			$this->aiIntegrationsService,
			$this->cacheFactory,
			$this->delegationService,
			$this->inlineAttachmentCache,
		);

		$this->account = $this->createMock(Account::class);
		$this->message = $this->createMock(IMAPMessage::class);
		$this->attachment = $this->createMock(Attachment::class);
	}

	protected function tearDown(): void {
		parent::tearDown();

		\OC::$server->offsetUnset(ITimeFactory::class);
		\OC::$server->offsetSet(ITimeFactory::class, $this->oldFactory);
	}

	public function testGetHtmlBody(): void {
		$accountId = 17;
		$mailboxId = 13;
		$folderId = 'testfolder';
		$messageId = 4321;
		$this->account
			->method('getId')
			->willReturn($accountId);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$message = new \OCA\Mail\Db\Message();
		$message->setMailboxId($mailboxId);
		$message->setUid(123);
		$mailbox->setAccountId($accountId);
		$mailbox->setName($folderId);
		$this->mailManager->expects($this->exactly(2))
			->method('getMessage')
			->with($this->userId, $messageId)
			->willReturn($message);
		$this->mailManager->expects($this->exactly(2))
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->exactly(2))
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$imapMessage = $this->createStub(IMAPMessage::class);
		$imapMessage->method('getFullMessage')->willReturn([
			'body' => '',
			'inlineAttachments' => [],
		]);
		$this->mailManager->expects($this->exactly(2))
			->method('getImapMessage')
			->with($client, $this->account, $mailbox, 123, true)
			->willReturn($imapMessage);
		$this->clientFactory->expects($this->exactly(2))
			->method('getClient')
			->with($this->account)
			->willReturn($client);

		$expectedPlainResponse = HtmlResponse::plain('');
		$expectedPlainResponse->cacheFor(3600);

		$nonce = 'abc123';
		$relativeScriptUrl = '/script.js';
		$scriptUrl = 'next.cloud/script.js';
		$this->nonceManager->expects($this->once())
			->method('getNonce')
			->willReturn($nonce);
		$this->urlGenerator->expects($this->once())
			->method('linkTo')
			->with('mail', 'js/htmlresponse.js')
			->willReturn($relativeScriptUrl);
		$this->urlGenerator->expects($this->once())
			->method('getAbsoluteURL')
			->with($relativeScriptUrl)
			->willReturn($scriptUrl);
		$expectedRichResponse = HtmlResponse::withResizer('', $nonce, $scriptUrl);
		$expectedRichResponse->cacheFor(3600);

		$plainPolicy = new ContentSecurityPolicy();
		$plainPolicy->disallowScriptDomain('\'self\'');
		$plainPolicy->disallowConnectDomain('\'self\'');
		$plainPolicy->disallowFontDomain('\'self\'');
		$plainPolicy->disallowMediaDomain('\'self\'');
		$expectedPlainResponse->setContentSecurityPolicy($plainPolicy);
		$expectedPlainResponse->cacheFor(60 * 60, false, true);
		$richPolicy = new ContentSecurityPolicy();
		$richPolicy->disallowScriptDomain('\'self\'');
		$richPolicy->disallowFontDomain('\'self\'');
		$richPolicy->disallowMediaDomain('\'self\'');
		$expectedRichResponse->setContentSecurityPolicy($richPolicy);
		$expectedRichResponse->cacheFor(60 * 60, false, true);

		$actualPlainResponse = $this->controller->getHtmlBody($messageId, true);
		$actualRichResponse = $this->controller->getHtmlBody($messageId, false);

		$this->assertEquals($expectedPlainResponse, $actualPlainResponse);
		$this->assertEquals($expectedRichResponse, $actualRichResponse);
	}

	/**
	 * setUp() wires every test's controller to a NullCache (always misses,
	 * set() is a no-op) so every other test's IMAP-call-count expectations
	 * stay accurate. The caching tests below need a real, inspectable
	 * ICache instead -- rebuilds the controller with the exact same mocks
	 * setUp() already configured, just swapping the cache.
	 */
	private function rebuildControllerWithCache(ICache $cache): void {
		$cacheFactory = $this->createMock(ICacheFactory::class);
		$cacheFactory->method('createDistributed')->willReturn($cache);

		$this->controller = new MessagesController(
			$this->appName,
			$this->request,
			$this->accountService,
			$this->mailManager,
			$this->mailSearch,
			$this->itineraryService,
			$this->userId,
			$this->userFolder,
			$this->logger,
			$this->l10n,
			$this->mimeTypeDetector,
			$this->urlGenerator,
			$this->nonceManager,
			$this->trustedSenderService,
			$this->mailTransmission,
			$this->smimeService,
			$this->clientFactory,
			$this->dkimService,
			$this->userPreferences,
			$this->snoozeService,
			$this->aiIntegrationsService,
			$cacheFactory,
			$this->delegationService,
			$this->inlineAttachmentCache,
		);
	}

	/**
	 * Confirmed live: every open of a message -- the first time or the
	 * fiftieth -- previously cost its own full live IMAP fetch, because
	 * getBody() populated a cache (for getHtmlBody()'s benefit) but never
	 * consulted it itself. The same message reloaded slowly 7 times
	 * within 7 minutes in one observed window.
	 */
	public function testGetBodyReturnsTheCachedFullMessageWithoutTouchingImapOnAHit(): void {
		$accountId = 17;
		$mailboxId = 13;
		$messageId = 4321;
		$this->account->method('getId')->willReturn($accountId);
		$mailbox = new Mailbox();
		$mailbox->setAccountId($accountId);
		$message = new DbMessage();
		$message->setMailboxId($mailboxId);
		$message->setUid(123);
		$this->mailManager->method('getMessage')->with($this->userId, $messageId)->willReturn($message);
		$this->mailManager->method('getMailbox')->with($this->userId, $mailboxId)->willReturn($mailbox);
		$this->accountService->method('find')->with($this->userId, $accountId)->willReturn($this->account);

		$cachedJson = [
			'uid' => 123,
			'subject' => 'Cached subject',
			'body' => '<p>cached html</p>',
			'attachments' => [],
			'inlineAttachments' => [],
			'flags' => [],
			'hasHtmlBody' => true,
			'smimeIsEncrypted' => false,
			'smimeIsSigned' => false,
			'smimeSignatureValid' => false,
		];
		$cache = $this->createMock(ICache::class);
		$cache->method('get')->with("message_$messageId")->willReturn($cachedJson);
		$cache->expects($this->never())->method('set');
		$this->rebuildControllerWithCache($cache);

		$this->clientFactory->expects($this->never())->method('getClient');
		$this->mailManager->expects($this->never())->method('getImapMessage');

		$response = $this->controller->getBody($messageId);

		$this->assertSame('Cached subject', $response->getData()['subject']);
		$this->assertSame('<p>cached html</p>', $response->getData()['body']);
	}

	public function testGetBodyFetchesLiveAndPopulatesTheCacheOnAMiss(): void {
		$accountId = 17;
		$mailboxId = 13;
		$messageId = 4321;
		$this->account->method('getId')->willReturn($accountId);
		$mailbox = new Mailbox();
		$mailbox->setAccountId($accountId);
		$message = new DbMessage();
		$message->setMailboxId($mailboxId);
		$message->setUid(123);
		$this->mailManager->method('getMessage')->with($this->userId, $messageId)->willReturn($message);
		$this->mailManager->method('getMailbox')->with($this->userId, $mailboxId)->willReturn($mailbox);
		$this->accountService->method('find')->with($this->userId, $accountId)->willReturn($this->account);

		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->with($this->account)->willReturn($client);
		$imapMessage = $this->createMock(IMAPMessage::class);
		$imapMessage->method('hasHtmlMessage')->willReturn(true);
		$imapMessage->method('isEncrypted')->willReturn(false);
		$imapMessage->method('isSigned')->willReturn(false);
		$fullMessage = [
			'uid' => 123,
			'subject' => 'Live subject',
			'body' => '<p>live html</p>',
			'attachments' => [],
			'inlineAttachments' => [],
			'flags' => [],
			'hasHtmlBody' => true,
		];
		$imapMessage->method('getFullMessage')->with($messageId)->willReturn($fullMessage);
		$this->mailManager->method('getImapMessage')
			->with($client, $this->account, $mailbox, 123, true)
			->willReturn($imapMessage);

		// getBody() also stamps the IMAP-derived S/MIME flags onto $json
		// before caching it (see MessagesController::getBody()) -- the
		// cached value is $fullMessage plus those.
		$expectedCached = $fullMessage + [
			'smimeIsEncrypted' => false,
			'smimeIsSigned' => false,
			'smimeSignatureValid' => false,
		];
		$cache = $this->createMock(ICache::class);
		$cache->method('get')->with("message_$messageId")->willReturn(null);
		$cache->expects($this->once())
			->method('set')
			->with("message_$messageId", $expectedCached, 24 * 60 * 60);
		$this->rebuildControllerWithCache($cache);

		$response = $this->controller->getBody($messageId);

		$this->assertSame('Live subject', $response->getData()['subject']);
	}

	public function testGetBodyCachesAPlainTextOnlyMessage(): void {
		$accountId = 17;
		$mailboxId = 13;
		$messageId = 4321;
		$this->account->method('getId')->willReturn($accountId);
		$mailbox = new Mailbox();
		$mailbox->setAccountId($accountId);
		$message = new DbMessage();
		$message->setMailboxId($mailboxId);
		$message->setUid(123);
		$this->mailManager->method('getMessage')->with($this->userId, $messageId)->willReturn($message);
		$this->mailManager->method('getMailbox')->with($this->userId, $mailboxId)->willReturn($mailbox);
		$this->accountService->method('find')->with($this->userId, $accountId)->willReturn($this->account);

		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->with($this->account)->willReturn($client);
		$imapMessage = $this->createMock(IMAPMessage::class);
		// Plain-text-only message. Upstream gated the cache write on
		// hasHtmlMessage(), and this test used to pin that as "unchanged" --
		// it was characterising inherited behaviour, not protecting a
		// decision. The gate is gone: it bought nothing and cost a fresh IMAP
		// login every single time such a message was opened, which is the
		// exact currency Gmail throttles on. Safe because getHtmlBody()
		// serves $cached['body'] on a hit and computes the identical
		// $fullMessage['body'] on a miss.
		$imapMessage->method('hasHtmlMessage')->willReturn(false);
		$imapMessage->method('getFullMessage')->willReturn([
			'uid' => 123,
			'body' => 'plain text',
			'attachments' => [],
			'inlineAttachments' => [],
		]);
		$this->mailManager->method('getImapMessage')->willReturn($imapMessage);

		$cache = $this->createMock(ICache::class);
		$cache->method('get')->willReturn(null);
		$cache->expects($this->once())->method('set');
		$this->rebuildControllerWithCache($cache);

		$this->controller->getBody($messageId);
	}

	public function testGetHtmlBodyReadsFromTheSharedCachePopulatedByGetBody(): void {
		$accountId = 17;
		$mailboxId = 13;
		$messageId = 4321;
		$this->account->method('getId')->willReturn($accountId);
		$mailbox = new Mailbox();
		$mailbox->setAccountId($accountId);
		$message = new DbMessage();
		$message->setMailboxId($mailboxId);
		$message->setUid(123);
		$this->mailManager->method('getMessage')->with($this->userId, $messageId)->willReturn($message);
		$this->mailManager->method('getMailbox')->with($this->userId, $mailboxId)->willReturn($mailbox);
		$this->accountService->method('find')->with($this->userId, $accountId)->willReturn($this->account);

		$cache = $this->createMock(ICache::class);
		$cache->method('get')->with("message_$messageId")->willReturn([
			'body' => '<p>from getBody\'s own cache</p>',
			'hasHtmlBody' => true,
		]);
		$this->rebuildControllerWithCache($cache);

		$this->clientFactory->expects($this->never())->method('getClient');
		$this->mailManager->expects($this->never())->method('getImapMessage');

		$response = $this->controller->getHtmlBody($messageId, true);

		$this->assertStringContainsString('from getBody\'s own cache', $response->render());
	}

	public function testGetHtmlBodyDefersEligibleCachedInlineImagesToOneBundle(): void {
		$accountId = 17;
		$mailboxId = 13;
		$messageId = 4321;
		$attachmentId = '2.2';
		$attachmentUrl = "https://next.cloud/apps/mail/api/messages/$messageId/attachment/$attachmentId";
		$bundleUrl = "https://next.cloud/apps/mail/api/messages/$messageId/attachments/inline";
		$this->account->method('getId')->willReturn($accountId);
		$mailbox = new Mailbox();
		$mailbox->setAccountId($accountId);
		$message = new DbMessage();
		$message->setMailboxId($mailboxId);
		$message->setUid(123);
		$this->mailManager->method('getMessage')->with($this->userId, $messageId)->willReturn($message);
		$this->mailManager->method('getMailbox')->with($this->userId, $mailboxId)->willReturn($mailbox);
		$this->accountService->method('find')->with($this->userId, $accountId)->willReturn($this->account);
		$this->inlineAttachmentCache->expects(self::once())
			->method('getCandidateIds')
			->with([
				['id' => $attachmentId, 'mime' => 'image/png', 'size' => 5],
			])
			->willReturn([$attachmentId]);
		$this->urlGenerator->method('linkToRouteAbsolute')
			->willReturnCallback(static function (string $route, array $params) use (
				$messageId,
				$attachmentId,
				$attachmentUrl,
				$bundleUrl,
			): string {
				if ($route === 'mail.messages.getInlineAttachments') {
					self::assertSame(['id' => $messageId], $params);
					return $bundleUrl;
				}
				self::assertSame('mail.messages.downloadAttachment', $route);
				self::assertSame([
					'id' => $messageId,
					'attachmentId' => $attachmentId,
				], $params);
				return $attachmentUrl;
			});
		$this->nonceManager->method('getNonce')->willReturn('nonce');
		$this->urlGenerator->method('linkTo')->willReturn('/htmlresponse.js');
		$this->urlGenerator->method('getAbsoluteURL')->willReturn('https://next.cloud/htmlresponse.js');

		$cache = $this->createMock(ICache::class);
		$cache->method('get')->with("message_$messageId")->willReturn([
			'body' => '<p>cached</p><img src="' . $attachmentUrl . '">',
			'inlineAttachments' => [
				['id' => $attachmentId, 'mime' => 'image/png', 'size' => 5],
			],
			'hasHtmlBody' => true,
		]);
		$this->rebuildControllerWithCache($cache);

		$response = $this->controller->getHtmlBody($messageId, false);
		$rendered = $response->render();

		self::assertStringNotContainsString('src="' . $attachmentUrl . '"', $rendered);
		self::assertStringContainsString('data-mail-inline-id="' . $attachmentId . '"', $rendered);
		self::assertStringContainsString('data-mail-inline-bundle="' . $bundleUrl . '"', $rendered);
		self::assertStringContainsString('data-mail-inline-fallback="' . $attachmentUrl . '"', $rendered);
	}

	public function testGetInlineAttachmentsReturnsOnePrivateBoundedBundle(): void {
		$accountId = 17;
		$mailboxId = 987;
		$messageId = 123;
		$message = new DbMessage();
		$message->setMailboxId($mailboxId);
		$mailbox = new Mailbox();
		$mailbox->setAccountId($accountId);
		$this->mailManager->method('getMessage')->with($this->userId, $messageId)->willReturn($message);
		$this->mailManager->method('getMailbox')->with($this->userId, $mailboxId)->willReturn($mailbox);
		$this->accountService->method('find')->with($this->userId, $accountId)->willReturn($this->account);
		$this->inlineAttachmentCache->expects(self::once())
			->method('getBundle')
			->with($this->account, $mailbox, $message, $messageId)
			->willReturn([
				'2.2' => new Attachment('2.2', 'first.png', 'image/png', 'first', 5, 'first', 'inline'),
				'2.3' => new Attachment('2.3', 'second.jpg', 'image/jpeg', 'second', 6, 'second', 'inline'),
			]);

		$response = $this->controller->getInlineAttachments($messageId);

		self::assertSame([
			'parts' => [
				'2.2' => ['mime' => 'image/png', 'content' => base64_encode('first')],
				'2.3' => ['mime' => 'image/jpeg', 'content' => base64_encode('second')],
			],
		], $response->getData());
		self::assertSame('2', $response->getHeaders()['X-Mail-Inline-Part-Count']);
		self::assertStringContainsString('private', $response->getHeaders()['Cache-Control']);
		self::assertStringContainsString('max-age=3600', $response->getHeaders()['Cache-Control']);
	}

	public function testDownloadAttachment() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$uid = 321;
		$attachmentId = '3';

		// Attachment data
		$contents = 'abcdef';
		$name = 'cat.jpg';
		$type = 'image/jpg';
		$this->account->method('getId')->willReturn($accountId);
		$message = new \OCA\Mail\Db\Message();
		$message->setMailboxId($mailboxId);
		$message->setUid($uid);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->mailManager->expects($this->once())
			->method('getMailAttachment')
			->with($this->account, $mailbox, $message, $attachmentId)
			->will($this->returnValue($this->attachment));
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$this->attachment->expects($this->once())
			->method('getContent')
			->will($this->returnValue($contents));
		$this->attachment->expects($this->any())
			->method('getName')
			->will($this->returnValue($name));
		$this->attachment->expects($this->once())
			->method('getType')
			->will($this->returnValue($type));

		$expected = new AttachmentDownloadResponse($contents, $name, $type);
		$response = $this->controller->downloadAttachment(
			$id,
			$attachmentId
		);

		$this->assertEquals($expected, $response);
	}

	public function testDownloadCachedInlineAttachmentGetsPrivateBrowserCache(): void {
		$accountId = 17;
		$mailboxId = 987;
		$messageId = 123;
		$uid = 321;
		$attachmentId = '2.2';
		$message = new DbMessage();
		$message->setMailboxId($mailboxId);
		$message->setUid($uid);
		$mailbox = new Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects(self::once())
			->method('getMessage')
			->with($this->userId, $messageId)
			->willReturn($message);
		$this->mailManager->expects(self::once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects(self::once())
			->method('find')
			->with($this->userId, $accountId)
			->willReturn($this->account);
		$attachment = new Attachment(
			$attachmentId,
			'first.png',
			'image/png',
			'first',
			5,
			'first',
			'inline',
		);
		$this->inlineAttachmentCache->expects(self::once())
			->method('get')
			->with(
				$this->account,
				$mailbox,
				$message,
				$messageId,
				$attachmentId,
			)
			->willReturn($attachment);
		$this->mailManager->expects(self::never())->method('getMailAttachment');

		$response = $this->controller->downloadAttachment($messageId, $attachmentId);

		self::assertSame('first', $response->render());
		self::assertStringContainsString('private', $response->getHeaders()['Cache-Control']);
		self::assertStringContainsString('max-age=3600', $response->getHeaders()['Cache-Control']);
	}

	public function testDownloadAttachmentFallsBackWhenInlineCacheDoesNotCoverPart(): void {
		$accountId = 17;
		$mailboxId = 987;
		$messageId = 123;
		$attachmentId = '2.2';
		$message = new DbMessage();
		$message->setMailboxId($mailboxId);
		$mailbox = new Mailbox();
		$mailbox->setAccountId($accountId);
		$this->mailManager->method('getMessage')->willReturn($message);
		$this->mailManager->method('getMailbox')->willReturn($mailbox);
		$this->account->method('getId')->willReturn(42);
		$this->accountService->method('find')->willReturn($this->account);
		$this->inlineAttachmentCache->expects(self::once())
			->method('get')
			->with($this->account, $mailbox, $message, $messageId, $attachmentId)
			->willReturn(null);
		$this->mailManager->expects(self::once())
			->method('getMailAttachment')
			->with($this->account, $mailbox, $message, $attachmentId)
			->willReturn(new Attachment(
				$attachmentId,
				'large.png',
				'image/png',
				'large',
				5,
				null,
				'inline',
			));

		$response = $this->controller->downloadAttachment($messageId, $attachmentId);

		self::assertSame('large', $response->render());
		self::assertStringNotContainsString(
			'max-age=3600',
			$response->getHeaders()['Cache-Control'],
		);
	}

	public function testSaveSingleAttachment() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$uid = 321;
		$attachmentId = '2.2';
		$targetPath = 'Downloads';
		$message = new \OCA\Mail\Db\Message();
		$message->setMailboxId($mailboxId);
		$message->setUid($uid);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$this->mailManager->expects($this->once())
			->method('getMailAttachment')
			->with($this->account, $mailbox, $message, $attachmentId)
			->will($this->returnValue($this->attachment));
		$this->attachment->expects($this->once())
			->method('getName')
			->with()
			->will($this->returnValue('cat.jpg'));
		$folderNode = $this->createStub(Folder::class);
		$this->userFolder->expects($this->once())
			->method('get')
			->with('Downloads')
			->willReturn($folderNode);
		$this->userFolder->expects($this->exactly(2))
			->method('nodeExists')
			->withConsecutive(['Downloads'], ['Downloads/cat.jpg'])
			->willReturnOnConsecutiveCalls(true, false);
		$file = $this->getMockBuilder('\OCP\Files\File')
			->disableOriginalConstructor()
			->getMock();
		$this->userFolder->expects($this->once())
			->method('newFile')
			->with('Downloads/cat.jpg')
			->will($this->returnValue($file));
		$file->expects($this->once())
			->method('putContent')
			->with('abcdefg');
		$this->attachment->expects($this->once())
			->method('getContent')
			->will($this->returnValue('abcdefg'));

		$expected = new JSONResponse();
		$response = $this->controller->saveAttachment(
			$id,
			$attachmentId,
			$targetPath
		);

		$this->assertEquals($expected, $response);
	}

	public function testSaveAllAttachments() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$uid = 321;
		$attachmentId = '0';
		$targetPath = 'Downloads';
		$message = new \OCA\Mail\Db\Message();
		$message->setMailboxId($mailboxId);
		$message->setUid($uid);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));

		$this->mailManager->expects($this->once())
			->method('getMailAttachments')
			->with($this->account, $mailbox, $message)
			->will($this->returnValue([$this->attachment]));
		$this->attachment->expects($this->once())
			->method('getName')
			->with()
			->will($this->returnValue('cat.jpg'));
		$folderNode = $this->createStub(Folder::class);
		$this->userFolder->expects($this->once())
			->method('get')
			->with('Downloads')
			->willReturn($folderNode);
		$this->userFolder->expects($this->exactly(2))
			->method('nodeExists')
			->withConsecutive(['Downloads'], ['Downloads/cat.jpg'])
			->willReturnOnConsecutiveCalls(true, false);
		$file = $this->getMockBuilder('\OCP\Files\File')
			->disableOriginalConstructor()
			->getMock();
		$this->userFolder->expects($this->once())
			->method('newFile')
			->with('Downloads/cat.jpg')
			->will($this->returnValue($file));
		$file->expects($this->once())
			->method('putContent')
			->with('abcdefg');
		$this->attachment->expects($this->once())
			->method('getContent')
			->will($this->returnValue('abcdefg'));

		$expected = new JSONResponse();
		$response = $this->controller->saveAttachment(
			$id,
			$attachmentId,
			$targetPath
		);

		$this->assertEquals($expected, $response);
	}

	public function testSaveAttachmentTargetPathNotFound(): void {
		$this->userFolder->expects($this->once())
			->method('nodeExists')
			->with('NoSuchFolder')
			->willReturn(false);

		$response = $this->controller->saveAttachment(123, '1', 'NoSuchFolder');

		$this->assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
	}

	public function testSaveAttachmentTargetPathIsFile(): void {
		$fileNode = $this->getMockBuilder('\OCP\Files\File')
			->disableOriginalConstructor()
			->getMock();
		$this->userFolder->expects($this->once())
			->method('nodeExists')
			->with('some/file.txt')
			->willReturn(true);
		$this->userFolder->expects($this->once())
			->method('get')
			->with('some/file.txt')
			->willReturn($fileNode);

		$response = $this->controller->saveAttachment(123, '1', 'some/file.txt');

		$this->assertSame(Http::STATUS_BAD_REQUEST, $response->getStatus());
	}

	public function testDownloadAttachments() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$uid = 321;
		$message = new \OCA\Mail\Db\Message();
		$message->setMailboxId($mailboxId);
		$message->setUid($uid);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
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

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));

		//
		$this->mailManager->expects($this->once())
			->method('getMailAttachments')
			->with($this->account, $mailbox, $message)
			->willReturn($attachments);
		// build our zip
		$response = $this->controller->downloadAttachments(
			$id
		);

		$this->assertInstanceOf(ZipResponse::class, $response);

		$zip = new ZipResponse($this->request, 'attachments');
		foreach ($attachments as $attachment) {
			$fileName = $attachment->getName();
			$fh = fopen('php://temp', 'r+');
			fputs($fh, $attachment->getContent());
			$size = $attachment->getSize();
			rewind($fh);
			$zip->addResource($fh, $fileName, $size);
		}

		// Reflection is needed to get private properties
		$refZip = new ReflectionObject($zip);
		$prop = $refZip->getProperty('resources');
		$zipValues = $prop->getValue($zip);
		$refResponse = new ReflectionObject($response);
		$prop = $refResponse->getProperty('resources');
		$responseValues = $prop->getValue($zip);

		$this->assertTrue(is_resource($zipValues[0]['resource']));
		$this->assertTrue(is_resource($responseValues[0]['resource']));

		// ZipResponse will write fopen id into the array
		// so assert equals needs to have these values unset before comparison
		unset($zipValues[0]['resource']);
		unset($responseValues[0]['resource']);

		$this->assertEquals($zipValues, $responseValues);
	}

	public function testDownloadAttachmentsDoesNotReturnAnEmptyZip(): void {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$message = new DbMessage();
		$message->setMailboxId($mailboxId);
		$message->setUid(321);
		$mailbox = new Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);

		$this->mailManager->expects(self::once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects(self::once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects(self::once())
			->method('find')
			->with($this->userId, $accountId)
			->willReturn($this->account);
		$this->mailManager->expects(self::once())
			->method('getMailAttachments')
			->with($this->account, $mailbox, $message)
			->willReturn([]);
		$this->l10n->expects(self::once())
			->method('t')
			->with('This message has no downloadable attachments')
			->willReturn('This message has no downloadable attachments');

		$response = $this->controller->downloadAttachments($id);

		self::assertInstanceOf(JSONResponse::class, $response);
		self::assertSame(Http::STATUS_NOT_FOUND, $response->getStatus());
		self::assertSame([
			'message' => 'This message has no downloadable attachments',
		], $response->getData());
	}

	public function testDownloadAttachmentsNoAccountError() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$uid = 321;
		$message = new \OCA\Mail\Db\Message();
		$message->setMailboxId($mailboxId);
		$message->setUid($uid);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->willThrowException(new ClientException());

		// test our json error response
		$this->expectException(ClientException::class);
		$response = $this->controller->downloadAttachments(
			$id
		);

		$this->assertInstanceOf(JSONResponse::class, $response);
	}

	public function testDownloadAttachmentsNoMailboxError() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$uid = 321;
		$message = new \OCA\Mail\Db\Message();
		$message->setMailboxId($mailboxId);
		$message->setUid($uid);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->willThrowException(new ClientException());

		// test our json error response
		$this->expectException(ClientException::class);
		$response = $this->controller->downloadAttachments(
			$id
		);

		$this->assertInstanceOf(JSONResponse::class, $response);
	}

	public function testDownloadAttachmentsNoMessageError() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$uid = 321;
		$message = new \OCA\Mail\Db\Message();
		$message->setMailboxId($mailboxId);
		$message->setUid($uid);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->willThrowException(new ServiceException());
		// test our json error response
		$this->expectException(ServiceException::class);
		$response = $this->controller->downloadAttachments(
			$id
		);

		$this->assertInstanceOf(JSONResponse::class, $response);
	}

	public function testSetFlagsUnseen() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$flags = [
			'seen' => false
		];
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->exactly(2))
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$this->mailManager->expects($this->once())
			->method('flagMessage')
			->with($this->account, 'INBOX', 444, 'seen', false);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId updated flags on message <$id> with [seen=false] on behalf of $this->userId");

		// setFlags() re-fetches the message after persisting the flag
		// change, so its response can tell the frontend whether the
		// message's thread still has any other unseen message -- it can't
		// know that from the optimistic client-side update alone.
		$expected = new JSONResponse(['hasUnseenInThread' => false]);
		$response = $this->controller->setFlags(
			$id,
			$flags
		);

		$this->assertEquals($expected, $response);
	}

	public function testSetFlagsSeenReturnsHasUnseenInThreadFromTheRefetchedMessage() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$flags = [
			'seen' => true,
		];
		$beforeChange = new \OCA\Mail\Db\Message();
		$beforeChange->setUid(444);
		$beforeChange->setMailboxId($mailboxId);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);

		// Marking this message read doesn't mean the rest of its thread is
		// -- the re-fetch after the change is what tells us that, not the
		// message object we already had before the change.
		$afterChange = new \OCA\Mail\Db\Message();
		$afterChange->setUid(444);
		$afterChange->setMailboxId($mailboxId);
		$afterChange->setHasUnseenInThread(true);

		$this->mailManager->expects($this->exactly(2))
			->method('getMessage')
			->with($this->userId, $id)
			->willReturnOnConsecutiveCalls($beforeChange, $afterChange);
		$this->mailManager->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->willReturn($this->account);
		$this->mailManager->expects($this->once())
			->method('flagMessage')
			->with($this->account, 'INBOX', 444, 'seen', true);

		$response = $this->controller->setFlags($id, $flags);

		$this->assertEquals(new JSONResponse(['hasUnseenInThread' => true]), $response);
	}

	public function testSetFlagsBatchGroupsMessagesIntoOneMailboxWrite(): void {
		$accountId = 17;
		$mailboxId = 987;
		$this->account->method('getId')->willReturn($accountId);
		$first = new \OCA\Mail\Db\Message();
		$first->setUid(441);
		$first->setMailboxId($mailboxId);
		$first->setHasUnseenInThread(false);
		$second = new \OCA\Mail\Db\Message();
		$second->setUid(442);
		$second->setMailboxId($mailboxId);
		$second->setHasUnseenInThread(true);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->method('getMessage')
			->willReturnMap([
				[$this->userId, 123, $first],
				[$this->userId, 124, $second],
			]);
		$this->mailManager->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->method('find')
			->willReturn($this->account);
		$this->mailManager->expects($this->once())
			->method('flagMessages')
			->with($this->account, 'INBOX', [441, 442], ['seen' => true]);

		$response = $this->controller->setFlagsBatch([123, 124], ['seen' => true]);

		$this->assertEquals(new JSONResponse([
			'messages' => [
				'123' => ['hasUnseenInThread' => false],
				'124' => ['hasUnseenInThread' => true],
			],
		]), $response);
	}

	public function testSetFlagsBatchSkipsAPurgedMessageInsteadOfFailingTheWholeBatch(): void {
		// Confirmed live on 2026-07-29: "Message 1597153 does not exist" from a
		// mark-on-open batch. One id that had been purged since the browser
		// read the list aborted the entire request, so opening a six-message
		// thread marked NONE of it read and showed a red "Could not update
		// read status" -- for the five messages that were sitting right there
		// and perfectly writable.
		$accountId = 17;
		$mailboxId = 987;
		$this->account->method('getId')->willReturn($accountId);
		$survivor = new \OCA\Mail\Db\Message();
		$survivor->setUid(441);
		$survivor->setMailboxId($mailboxId);
		$survivor->setHasUnseenInThread(false);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->method('getMessage')
			->willReturnCallback(static function ($userId, $id) use ($survivor) {
				if ($id === 1597153) {
					throw new DoesNotExistException('gone');
				}
				return $survivor;
			});
		$this->mailManager->method('getMailbox')->willReturn($mailbox);
		$this->account->method('getId')->willReturn(42);
		$this->accountService->method('find')->willReturn($this->account);
		// The survivor is still written, and the missing id contributes no UID.
		$this->mailManager->expects($this->once())
			->method('flagMessages')
			->with($this->account, 'INBOX', [441], ['seen' => true]);

		$response = $this->controller->setFlagsBatch([123, 1597153], ['seen' => true]);

		// Only the survivor is reported. The browser reads a missing entry as
		// "no authoritative value" and keeps its optimistic state, which is
		// exactly right for a message that no longer exists.
		$this->assertEquals(new JSONResponse([
			'messages' => [
				'123' => ['hasUnseenInThread' => false],
			],
		]), $response);
	}

	public function testSetFlagsBatchOfNothingButPurgedMessagesIsNotAFailure(): void {
		// "Gone" is not a failure for a flag write, the same way it is not for
		// a delete: there is no message left to carry the flag, so the intent
		// is already satisfied. Reporting an error would put a red toast on
		// screen for something the user cannot act on and need not know about.
		$this->mailManager->method('getMessage')
			->willThrowException(new DoesNotExistException('gone'));
		$this->mailManager->expects($this->never())->method('flagMessages');

		$response = $this->controller->setFlagsBatch([1597153], ['seen' => true]);

		$this->assertEquals(new JSONResponse(['messages' => []]), $response);
	}

	public function testSetFlagsBatchToleratesAMessageVanishingBeforeItCanBeReported(): void {
		// The window between the IMAP STORE and reading the rows back. The
		// write already happened, so this is a reporting gap, not a failure --
		// it used to escape as an uncaught DoesNotExistException, i.e. a 500
		// for an operation that had in fact succeeded.
		$accountId = 17;
		$mailboxId = 987;
		$this->account->method('getId')->willReturn($accountId);
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(441);
		$message->setMailboxId($mailboxId);
		$message->setHasUnseenInThread(false);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setId($mailboxId);
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$calls = 0;
		$this->mailManager->method('getMessage')
			->willReturnCallback(static function ($userId, $id) use ($message, &$calls) {
				$calls++;
				if ($calls > 1) {
					// Resolved fine; gone by the time its row is read back.
					throw new DoesNotExistException('vanished');
				}
				return $message;
			});
		$this->mailManager->method('getMailbox')->willReturn($mailbox);
		$this->account->method('getId')->willReturn(42);
		$this->accountService->method('find')->willReturn($this->account);
		$this->mailManager->expects($this->once())->method('flagMessages');

		$response = $this->controller->setFlagsBatch([123], ['seen' => true]);

		$this->assertEquals(new JSONResponse(['messages' => []]), $response);
	}

	public function testSetTagFailing() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 1;
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$message->setMessageId('<jhfjkhdsjkfhdsjkhfjkdsh@test.com>');
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->willThrowException(new DoesNotExistException(''));
		$this->mailManager->expects($this->never())
			->method('getTagByImapLabel');
		$this->mailManager->expects($this->never())
			->method('tagMessage');

		$this->controller->setTag($id, Tag::LABEL_IMPORTANT);
	}

	public function testSetTagNotFound() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 1;
		$imapLabel = '$label6';
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$message->setMessageId('<jhfjkhdsjkfhdsjkhfjkdsh@test.com>');
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$this->mailManager->expects($this->once())
			->method('getTagByImapLabel')
			->with($imapLabel, $this->userId)
			->willThrowException(new ClientException('Computer says no'));
		$this->mailManager->expects($this->never())
			->method('tagMessage');

		$this->controller->setTag($id, $imapLabel);
	}

	public function testSetTag() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 1;
		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$message->setMessageId('<jhfjkhdsjkfhdsjkhfjkdsh@test.com>');
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$this->mailManager->expects($this->once())
			->method('getTagByImapLabel')
			->with($tag->getImapLabel(), $this->userId)
			->willReturn($tag);
		$this->mailManager->expects($this->once())
			->method('tagMessage')
			->with($this->account, $mailbox->getName(), $message, $tag, true);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId added tag <{$tag->getImapLabel()}> on message <$id> on behalf of $this->userId");

		$this->controller->setTag($id, $tag->getImapLabel());
	}

	public function testRemoveTagFailing() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 1;
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$message->setMessageId('<jhfjkhdsjkfhdsjkhfjkdsh@test.com>');
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->willThrowException(new DoesNotExistException(''));
		$this->mailManager->expects($this->never())
			->method('getTagByImapLabel');
		$this->mailManager->expects($this->never())
			->method('tagMessage');

		$this->controller->removeTag($id, Tag::LABEL_IMPORTANT);
	}

	public function testRemoveTagNotFound() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 1;
		$imapLabel = '$label6';
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$message->setMessageId('<jhfjkhdsjkfhdsjkhfjkdsh@test.com>');
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$this->mailManager->expects($this->once())
			->method('getTagByImapLabel')
			->with($imapLabel, $this->userId)
			->willThrowException(new ClientException('Computer says no'));
		$this->mailManager->expects($this->never())
			->method('tagMessage');

		$this->controller->removeTag($id, $imapLabel);
	}

	public function testRemoveTag() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 1;
		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$message->setMessageId('<jhfjkhdsjkfhdsjkhfjkdsh@test.com>');
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$this->mailManager->expects($this->once())
			->method('getTagByImapLabel')
			->with($tag->getImapLabel(), $this->userId)
			->willReturn($tag);
		$this->mailManager->expects($this->once())
			->method('tagMessage')
			->with($this->account, $mailbox->getName(), $message, $tag, false);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId removed tag <{$tag->getImapLabel()}> on message <$id> on behalf of $this->userId");

		$this->controller->removeTag($id, $tag->getImapLabel());
	}

	public function testSetFlagsFlagged() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$flags = [
			'flagged' => true
		];
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->exactly(2))
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$this->mailManager->expects($this->once())
			->method('flagMessage')
			->with($this->account, 'INBOX', 444, 'flagged', true);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId updated flags on message <$id> with [flagged=true] on behalf of $this->userId");

		$expected = new JSONResponse(['hasUnseenInThread' => false]);
		$response = $this->controller->setFlags(
			$id,
			$flags
		);

		$this->assertEquals($expected, $response);
	}

	public function testDestroy() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$this->mailManager->expects($this->once())
			->method('deleteMessage')
			->with($this->account, 'INBOX', 444);
		$this->delegationService->expects($this->once())
			->method('logDelegatedAction')
			->with($this->userId, $this->userId, "$this->userId deleted message <$id> on behalf of $this->userId");

		$expected = new JSONResponse();
		$result = $this->controller->destroy($id);

		$this->assertEquals($expected, $result);
	}

	public function testDestroyWithAccountNotFound() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->throwException(new DoesNotExistException('')));

		$expected = new JSONResponse([], Http::STATUS_FORBIDDEN);

		$this->assertEquals($expected, $this->controller->destroy($id));
	}

	public function testDestroyWithFolderOrMessageNotFound() {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$this->mailManager->expects($this->once())
			->method('deleteMessage')
			->with($this->account, 'INBOX', 444)
			->willThrowException(new ServiceException());
		$this->expectException(ServiceException::class);

		$this->controller->destroy($id);
	}

	public function testGetThread(): void {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$message->setThreadRootId('<marlon@slimehunter.com>');
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->willReturn($this->account);
		$this->mailManager->expects($this->once())
			->method('getThread')
			->with($this->account, $message->getThreadRootId());

		$this->controller->getThread($id);
	}

	public function testGetThreadNoThreadRootId(): void {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->willReturn($this->account);
		$this->mailManager->expects($this->never())
			->method('getThread');

		$this->controller->getThread($id);
	}

	public function testGetThreadThreadRootIdEmptyString(): void {
		$accountId = 17;
		$mailboxId = 987;
		$id = 123;
		$message = new \OCA\Mail\Db\Message();
		$message->setUid(444);
		$message->setMailboxId($mailboxId);
		$message->setMessageId('<123@cde.com>');
		$message->setThreadRootId('');
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setName('INBOX');
		$mailbox->setAccountId($accountId);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, $id)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->willReturn($this->account);
		$this->mailManager->expects($this->once())
			->method('getThread');

		$this->controller->getThread($id);
	}

	public function testExport() {
		$accountId = 17;
		$mailboxId = 13;
		$folderId = 'testfolder';
		$messageId = 4321;
		$this->account
			->method('getId')
			->willReturn($accountId);
		$mailbox = new \OCA\Mail\Db\Mailbox();
		$message = new \OCA\Mail\Db\Message();
		$message->setMailboxId($mailboxId);
		$message->setUid(123);
		$message->setSubject('core/master has new results');
		$mailbox->setAccountId($accountId);
		$mailbox->setName($folderId);
		$this->mailManager->expects($this->exactly(1))
			->method('getMessage')
			->with($this->userId, $messageId)
			->willReturn($message);
		$this->mailManager->expects($this->exactly(1))
			->method('getMailbox')
			->with($this->userId, $mailboxId)
			->willReturn($mailbox);
		$this->accountService->expects($this->exactly(1))
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($accountId))
			->will($this->returnValue($this->account));
		$source = file_get_contents(__DIR__ . '/../../data/mail-message-123.txt');
		$client = $this->createStub(Horde_Imap_Client_Socket::class);
		$this->mailManager->expects($this->exactly(1))
			->method('getSource')
			->with($client, $this->account, $folderId, 123)
			->willReturn($source);
		$this->clientFactory->expects($this->once())
			->method('getClient')
			->willReturn($client);

		$expectedResponse = new AttachmentDownloadResponse(
			$source,
			'core/master has new results.eml',
			'message/rfc822'
		);
		$actualResponse = $this->controller->export($messageId);

		$this->assertEquals($expectedResponse, $actualResponse);
	}

	public function testGetDkim() {
		$mailAccount = new MailAccount();
		$mailAccount->setId(100);
		$mailAccount->setUserId($this->userId);
		$account = new Account($mailAccount);

		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setId(4);
		$mailbox->setAccountId($account->getId());
		$mailbox->setName('FooBar');

		$message = new \OCA\Mail\Db\Message();
		$message->setId(4448);
		$message->setMailboxId($mailbox->getId());
		$message->setUid(123);
		$message->setSubject('core/master has new results');

		$this->mailManager->expects($this->exactly(1))
			->method('getMessage')
			->with($this->userId, $message->getId())
			->willReturn($message);
		$this->mailManager->expects($this->exactly(1))
			->method('getMailbox')
			->with($this->userId, $mailbox->getId())
			->willReturn($mailbox);
		$this->accountService->expects($this->exactly(1))
			->method('find')
			->with($this->equalTo($this->userId), $this->equalTo($account->getId()))
			->will($this->returnValue($account));
		$this->dkimService->expects($this->exactly(1))
			->method('validate')
			->with($account, $mailbox, $message->getUid())
			->willReturn(true);

		$actualResponse = $this->controller->getDkim($message->getId());

		$this->assertInstanceOf(JSONResponse::class, $actualResponse);
		$this->assertEquals(['valid' => true], $actualResponse->getData());
	}

	public function testGetDkimReportsAVanishedMessageAsUnknownRatherThanAFailure(): void {
		// A message that has been moved or deleted since the cached copy was
		// written is an ORDINARY outcome, not a fault. It used to escape as an
		// uncaught ServiceException, which #[TrapError] turned into a 500 and
		// logged at ERROR level -- noise in the one place that should hold only
		// real problems. Confirmed live 2026-07-29:
		// "Could not fetch message source for uid 264986".
		//
		// 404 specifically: fetchMessageDkim() in the client already reads that
		// as "no DKIM information" and returns undefined, so the badge simply
		// does not render and the message body is unaffected.
		[$account, $mailbox, $message] = $this->buildDkimFixture();

		$this->dkimService->expects($this->once())
			->method('validate')
			->willThrowException(MessageSourceUnavailableException::forUid($message->getUid()));

		$actualResponse = $this->controller->getDkim($message->getId());

		$this->assertInstanceOf(JSONResponse::class, $actualResponse);
		$this->assertEquals(Http::STATUS_NOT_FOUND, $actualResponse->getStatus());
	}

	public function testGetDkimStillLetsARealFailureSurface(): void {
		// The other half, and the reason this is a distinct exception rather
		// than a catch on ServiceException: a broken IMAP connection must stay
		// an error. Swallowing everything as "unknown" would have made the
		// logs quiet in exactly the case where they should not be.
		[$account, $mailbox, $message] = $this->buildDkimFixture();

		$this->dkimService->expects($this->once())
			->method('validate')
			->willThrowException(new ServiceException('IMAP is down'));

		$this->expectException(ServiceException::class);
		$this->controller->getDkim($message->getId());
	}

	/** @return array{0: Account, 1: \OCA\Mail\Db\Mailbox, 2: \OCA\Mail\Db\Message} */
	private function buildDkimFixture(): array {
		$mailAccount = new MailAccount();
		$mailAccount->setId(100);
		$mailAccount->setUserId($this->userId);
		$account = new Account($mailAccount);

		$mailbox = new \OCA\Mail\Db\Mailbox();
		$mailbox->setId(4);
		$mailbox->setAccountId($account->getId());
		$mailbox->setName('FooBar');

		$message = new \OCA\Mail\Db\Message();
		$message->setId(4448);
		$message->setMailboxId($mailbox->getId());
		$message->setUid(264986);

		$this->mailManager->method('getMessage')->willReturn($message);
		$this->mailManager->method('getMailbox')->willReturn($mailbox);
		$this->accountService->method('find')->willReturn($account);

		return [$account, $mailbox, $message];
	}

	public function testGetDkimTrapsCapacityErrors(): void {
		$method = new ReflectionMethod(MessagesController::class, 'getDkim');

		self::assertCount(1, $method->getAttributes(TrapError::class));
	}

	public static function provideCacheBusterData(): array {
		return [
			[null, false],
			['', false],
			['abcdef123', true],
		];
	}

	/** @dataProvider provideCacheBusterData */
	public function testIndexCacheBuster(?string $cacheBuster, bool $expectCaching): void {
		$mailbox = new Mailbox();
		$mailbox->setAccountId(100);
		$this->mailManager->expects(self::once())
			->method('getMailbox')
			->with($this->userId, 100)
			->willReturn($mailbox);
		$mailAccount = new MailAccount();
		$account = new Account($mailAccount);
		$this->accountService->expects(self::once())
			->method('find')
			->with($this->userId, 100)
			->willReturn($account);

		$this->userPreferences->expects(self::once())
			->method('getPreference')
			->with($this->userId, 'sort-order', 'newest')
			->willReturnArgument(2);

		$messages = [
			new DbMessage(),
			new DbMessage(),
		];
		$this->mailSearch->expects(self::once())
			->method('findMessages')
			->with(
				$account,
				$mailbox,
				'DESC',
				null,
				null,
				20,
				$this->userId,
				'threaded',
				false,
				null,
			)->willReturn($messages);

		$actualResponse = $this->controller->index(100, null, null, 20, null, $cacheBuster);

		$cacheForHeader = $actualResponse->getHeaders()['Cache-Control'] ?? null;
		$this->assertNotNull($cacheForHeader);
		if ($expectCaching) {
			$this->assertEquals('private, max-age=604800, immutable', $cacheForHeader);
		} else {
			$this->assertEquals('no-cache, no-store, must-revalidate', $cacheForHeader);
		}
	}

	public function testNeedsTranslationNoUser() {
		$controller = new MessagesController(
			$this->appName,
			$this->request,
			$this->accountService,
			$this->mailManager,
			$this->mailSearch,
			$this->itineraryService,
			null,
			$this->userFolder,
			$this->logger,
			$this->l10n,
			$this->mimeTypeDetector,
			$this->urlGenerator,
			$this->nonceManager,
			$this->trustedSenderService,
			$this->mailTransmission,
			$this->smimeService,
			$this->clientFactory,
			$this->dkimService,
			$this->userPreferences,
			$this->snoozeService,
			$this->aiIntegrationsService,
			$this->cacheFactory,
			$this->delegationService,
			$this->inlineAttachmentCache,
		);

		$actualResponse = $controller->needsTranslation(100);
		$expectedResponse = new JSONResponse([], Http::STATUS_FORBIDDEN);
		$this->assertEquals($expectedResponse, $actualResponse);
	}
	public function testNeedsTranslationNoMessage() {
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willThrowException(new DoesNotExistException(''));
		$actualResponse = $this->controller->needsTranslation(100);
		$expectedResponse = new JSONResponse([], Http::STATUS_FORBIDDEN);
		$this->assertEquals($expectedResponse, $actualResponse);
	}
	public function testNeedsTranslationNoBackend() {
		$message = new \OCA\Mail\Db\Message();
		$message->setId(100);
		$message->setMailboxId(1);
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		$mailbox->setAccountId(1);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method(('getMailbox'))
			->with($this->userId, $message->getMailboxId())
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->userId, $mailbox->getAccountId())
			->willReturn(new Account(new MailAccount()));
		$this->aiIntegrationsService->expects($this->once())
			->method('isLlmProcessingEnabled')
			->willReturn(false);
		$actualResponse = $this->controller->needsTranslation(100);
		$expectedResponse = new JSONResponse([], Http::STATUS_NOT_IMPLEMENTED);
		$expectedResponse->cacheFor(60 * 60 * 24, false, true);
		$this->assertEquals($expectedResponse, $actualResponse);

	}

	public function testNeedsTranslationNull() {
		$message = new \OCA\Mail\Db\Message();
		$message->setId(100);
		$message->setMailboxId(1);
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		$mailbox->setAccountId(1);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method(('getMailbox'))
			->with($this->userId, $message->getMailboxId())
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->userId, $mailbox->getAccountId())
			->willReturn(new Account(new MailAccount()));
		$this->aiIntegrationsService->expects($this->once())
			->method('isLlmProcessingEnabled')
			->willReturn(true);
		$this->aiIntegrationsService->expects($this->once())
			->method('requiresTranslation')
			->willReturn(null);
		$actualResponse = $this->controller->needsTranslation(100);
		$expectedResponse = new JSONResponse(['requiresTranslation' => false]);
		$expectedResponse->cacheFor(60 * 60 * 24, false, true);
		$this->assertEquals($expectedResponse, $actualResponse);
	}

	public function testNeedsTranslation() {
		$message = new \OCA\Mail\Db\Message();
		$message->setId(100);
		$message->setMailboxId(1);
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		$mailbox->setAccountId(1);
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willReturn($message);
		$this->mailManager->expects($this->once())
			->method(('getMailbox'))
			->with($this->userId, $message->getMailboxId())
			->willReturn($mailbox);
		$this->accountService->expects($this->once())
			->method('find')
			->with($this->userId, $mailbox->getAccountId())
			->willReturn(new Account(new MailAccount()));
		$this->aiIntegrationsService->expects($this->once())
			->method('isLlmProcessingEnabled')
			->willReturn(true);
		$this->aiIntegrationsService->expects($this->once())
			->method('requiresTranslation')
			->willReturn(true);
		$actualResponse = $this->controller->needsTranslation(100);
		$expectedResponse = new JSONResponse(['requiresTranslation' => true]);
		$expectedResponse->cacheFor(60 * 60 * 24, false, true);
		$this->assertEquals($expectedResponse, $actualResponse);
	}

	public static function provideLimitData(): array {
		return [
			'20' => [20, 20],
			'500' => [500, 100],
			'null' => [null, 1],
		];
	}

	/** @dataProvider provideLimitData */
	public function testRestrictLimit(?int $limit, int $expectedLimit): void {
		$mailbox = new Mailbox();
		$mailbox->setAccountId(100);
		$this->mailManager->expects(self::once())
			->method('getMailbox')
			->with($this->userId, 100)
			->willReturn($mailbox);
		$mailAccount = new MailAccount();
		$account = new Account($mailAccount);
		$this->accountService->expects(self::once())
			->method('find')
			->with($this->userId, 100)
			->willReturn($account);
		$this->userPreferences->expects(self::once())
			->method('getPreference')
			->with($this->userId, 'sort-order', 'newest')
			->willReturnArgument(2);
		$this->mailSearch->expects(self::once())
			->method('findMessages')
			->with(
				$account,
				$mailbox,
				'DESC',
				null,
				null,
				$expectedLimit,
				$this->userId,
				'threaded',
				false,
			)->willReturn([]);

		$this->controller->index(100, null, null, $limit);
	}

	public function testSmartReplyNoUser(): void {
		$controller = new MessagesController(
			$this->appName,
			$this->request,
			$this->accountService,
			$this->mailManager,
			$this->mailSearch,
			$this->itineraryService,
			null,
			$this->userFolder,
			$this->logger,
			$this->l10n,
			$this->mimeTypeDetector,
			$this->urlGenerator,
			$this->nonceManager,
			$this->trustedSenderService,
			$this->mailTransmission,
			$this->smimeService,
			$this->clientFactory,
			$this->dkimService,
			$this->userPreferences,
			$this->snoozeService,
			$this->aiIntegrationsService,
			$this->cacheFactory,
			$this->delegationService,
			$this->inlineAttachmentCache,
		);

		$actualResponse = $controller->smartReply(100);
		$expectedResponse = new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		$this->assertEquals($expectedResponse, $actualResponse);
	}

	public function testSmartReplyNoMessage(): void {
		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willThrowException(new DoesNotExistException(''));

		$actualResponse = $this->controller->smartReply(100);
		$expectedResponse = new JSONResponse([], Http::STATUS_FORBIDDEN);
		$this->assertEquals($expectedResponse, $actualResponse);
	}

	public function testSmartReplyNoMailbox(): void {
		$message = new \OCA\Mail\Db\Message();
		$message->setId(100);
		$message->setMailboxId(1);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willReturn($message);

		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $message->getMailboxId())
			->willThrowException(new DoesNotExistException(''));

		$actualResponse = $this->controller->smartReply(100);
		$expectedResponse = new JSONResponse([], Http::STATUS_FORBIDDEN);
		$this->assertEquals($expectedResponse, $actualResponse);
	}

	public function testSmartReplyNoAccount(): void {
		$message = new \OCA\Mail\Db\Message();
		$message->setId(100);
		$message->setMailboxId(1);
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		$mailbox->setAccountId(1);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willReturn($message);

		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $message->getMailboxId())
			->willReturn($mailbox);

		$this->accountService->expects($this->once())
			->method('find')
			->with($this->userId, $mailbox->getAccountId())
			->willThrowException(new DoesNotExistException(''));

		$actualResponse = $this->controller->smartReply(100);
		$expectedResponse = new JSONResponse([], Http::STATUS_FORBIDDEN);
		$this->assertEquals($expectedResponse, $actualResponse);
	}

	public function testSmartReplyServiceException(): void {
		$message = new \OCA\Mail\Db\Message();
		$message->setId(100);
		$message->setMailboxId(1);
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		$mailbox->setAccountId(1);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willReturn($message);

		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $message->getMailboxId())
			->willReturn($mailbox);

		$this->accountService->expects($this->once())
			->method('find')
			->with($this->userId, $mailbox->getAccountId())
			->willReturn(new Account(new MailAccount()));

		$this->aiIntegrationsService->expects($this->once())
			->method('getSmartReply')
			->with($this->anything(), $this->anything(), $this->anything(), $this->userId)
			->willThrowException(new ServiceException('AI service error'));

		$this->logger->expects($this->once())
			->method('error');

		$actualResponse = $this->controller->smartReply(100);
		$expectedResponse = new JSONResponse([], Http::STATUS_NO_CONTENT);
		$this->assertEquals($expectedResponse, $actualResponse);
	}

	public function testSmartReplySuccessful(): void {
		$message = new \OCA\Mail\Db\Message();
		$message->setId(100);
		$message->setMailboxId(1);
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		$mailbox->setAccountId(1);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willReturn($message);

		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $message->getMailboxId())
			->willReturn($mailbox);

		$this->accountService->expects($this->once())
			->method('find')
			->with($this->userId, $mailbox->getAccountId())
			->willReturn(new Account(new MailAccount()));

		$replies = ['reply1' => 'OK thanks', 'reply2' => 'Sounds good'];
		$this->aiIntegrationsService->expects($this->once())
			->method('getSmartReply')
			->with($this->anything(), $this->anything(), $this->anything(), $this->userId)
			->willReturn($replies);

		$actualResponse = $this->controller->smartReply(100);
		$expectedResponse = new JSONResponse(array_values($replies));
		$this->assertEquals($expectedResponse, $actualResponse);
	}

	public function testSmartReplyEmptyReplies(): void {
		$message = new \OCA\Mail\Db\Message();
		$message->setId(100);
		$message->setMailboxId(1);
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		$mailbox->setAccountId(1);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willReturn($message);

		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $message->getMailboxId())
			->willReturn($mailbox);

		$this->accountService->expects($this->once())
			->method('find')
			->with($this->userId, $mailbox->getAccountId())
			->willReturn(new Account(new MailAccount()));

		$this->aiIntegrationsService->expects($this->once())
			->method('getSmartReply')
			->with($this->anything(), $this->anything(), $this->anything(), $this->userId)
			->willReturn([]);

		$actualResponse = $this->controller->smartReply(100);
		$expectedResponse = new JSONResponse([]);
		$this->assertEquals($expectedResponse, $actualResponse);
	}

	public function testSmartReplyWithCachedInvalidJson(): void {
		// This test verifies that when getSmartReply() encounters corrupted cache
		// (which would cause json_decode to fail), it throws ServiceException
		// and the controller properly handles it by returning NO_CONTENT.
		// This prevents the TypeError: array_values(): Argument #1 ($array) must be of type array, null given

		$message = new \OCA\Mail\Db\Message();
		$message->setId(100);
		$message->setMailboxId(1);
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		$mailbox->setAccountId(1);

		$this->mailManager->expects($this->once())
			->method('getMessage')
			->with($this->userId, 100)
			->willReturn($message);

		$this->mailManager->expects($this->once())
			->method('getMailbox')
			->with($this->userId, $message->getMailboxId())
			->willReturn($mailbox);

		$this->accountService->expects($this->once())
			->method('find')
			->with($this->userId, $mailbox->getAccountId())
			->willReturn(new Account(new MailAccount()));

		// Simulate the AI service throwing ServiceException due to corrupted cache
		$this->aiIntegrationsService->expects($this->once())
			->method('getSmartReply')
			->with($this->anything(), $this->anything(), $this->anything(), $this->userId)
			->willThrowException(new ServiceException('Failed to decode smart replies JSON output'));

		$this->logger->expects($this->once())
			->method('error');

		$actualResponse = $this->controller->smartReply(100);
		$expectedResponse = new JSONResponse([], Http::STATUS_NO_CONTENT);
		$this->assertEquals($expectedResponse, $actualResponse);
	}


	/**
	 * @param int[] $ids
	 */
	private function stubMessagesInOneMailbox(array $ids): void {
		$mailbox = new Mailbox();
		$mailbox->setId(77);
		$mailbox->setAccountId(42);

		$this->mailManager->method('getMessage')
			->willReturnCallback(function (string $uid, int $id) {
				$message = new DbMessage();
				$message->setId($id);
				$message->setUid($id + 1000);
				$message->setMailboxId(77);
				return $message;
			});
		$this->mailManager->method('getMailbox')->willReturn($mailbox);
		$this->account->method('getId')->willReturn(42);
		$this->accountService->method('find')->willReturn($this->account);

		$imapMessage = $this->createStub(IMAPMessage::class);
		$imapMessage->method('getFullMessage')->willReturn([
			'body' => 'x',
			'attachments' => [],
			'inlineAttachments' => [],
		]);
		$this->mailManager->method('getImapMessage')->willReturn($imapMessage);
	}

	public function testPrefetchOpensOneConnectionForTheWholeBatch(): void {
		// THE contract. The endpoint exists for exactly one reason: Gmail
		// throttles on login rate, and a per-message client means a login per
		// message. If a refactor ever moves getClient() inside the loop this
		// test is what says so -- the bodies would still be fetched and every
		// other assertion here would still pass.
		$cache = $this->createMock(ICache::class);
		$this->rebuildControllerWithCache($cache);
		$controller = $this->controller;
		$this->stubMessagesInOneMailbox([1, 2, 3, 4, 5]);
		$cache->method('get')->willReturn(null);
		$cache->expects($this->exactly(5))->method('set');

		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->expects($this->once())
			->method('getClient')
			->willReturn($client);
		$client->expects($this->once())->method('logout');

		$response = $controller->prefetchBodies([1, 2, 3, 4, 5]);

		$this->assertSame(['cached' => 5, 'skipped' => 0], $response->getData());
	}

	public function testPrefetchIsCappedSoTheBrowserCannotHoldAWorker(): void {
		$cache = $this->createMock(ICache::class);
		$this->rebuildControllerWithCache($cache);
		$controller = $this->controller;
		$this->stubMessagesInOneMailbox(range(1, 25));
		$cache->method('get')->willReturn(null);
		// Ten, not twenty-five: the list comes from the browser.
		$cache->expects($this->exactly(10))->method('set');

		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($client);

		$response = $controller->prefetchBodies(range(1, 25));

		$this->assertSame(10, $response->getData()['cached']);
	}

	public function testPrefetchOpensNoConnectionWhenEverythingIsCached(): void {
		// Prefetching the same page twice -- which the client will do, because
		// it prefetches on list load AND as the user moves -- must be free.
		$cache = $this->createMock(ICache::class);
		$this->rebuildControllerWithCache($cache);
		$controller = $this->controller;
		$this->stubMessagesInOneMailbox([1, 2]);
		$cache->method('get')->willReturn(['body' => 'already here']);
		$cache->expects($this->never())->method('set');

		$this->clientFactory->expects($this->never())->method('getClient');

		$response = $controller->prefetchBodies([1, 2]);

		$this->assertSame(['cached' => 0, 'skipped' => 0], $response->getData());
	}

	public function testOneUnfetchableMessageDoesNotCostTheRestTheirConnection(): void {
		$cache = $this->createMock(ICache::class);
		$this->rebuildControllerWithCache($cache);
		$controller = $this->controller;
		$mailbox = new Mailbox();
		$mailbox->setId(77);
		$mailbox->setAccountId(42);
		$this->mailManager->method('getMessage')
			->willReturnCallback(function (string $uid, int $id) {
				$message = new DbMessage();
				$message->setId($id);
				$message->setUid($id + 1000);
				$message->setMailboxId(77);
				return $message;
			});
		$this->mailManager->method('getMailbox')->willReturn($mailbox);
		$this->account->method('getId')->willReturn(42);
		$this->accountService->method('find')->willReturn($this->account);
		$cache->method('get')->willReturn(null);

		$good = $this->createStub(IMAPMessage::class);
		$good->method('getFullMessage')->willReturn(['body' => 'x', 'attachments' => [], 'inlineAttachments' => []]);
		$this->mailManager->method('getImapMessage')
			->willReturnCallback(function ($client, $account, $mailbox, int $uid) use ($good) {
				if ($uid === 1002) {
					throw new ServiceException('gone');
				}
				return $good;
			});

		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->clientFactory->method('getClient')->willReturn($client);
		// The connection is still closed even though a fetch threw.
		$client->expects($this->once())->method('logout');
		$cache->expects($this->exactly(2))->method('set');

		$response = $controller->prefetchBodies([1, 2, 3]);

		$this->assertSame(['cached' => 2, 'skipped' => 1], $response->getData());
	}
}
