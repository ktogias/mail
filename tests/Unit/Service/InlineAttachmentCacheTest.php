<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Attachment;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Service\InlineAttachmentCache;
use OCP\ICacheFactory;
use OCP\IMemcache;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class InlineAttachmentCacheTest extends TestCase {
	private IMailManager&MockObject $mailManager;
	private ICacheFactory&MockObject $cacheFactory;
	private LoggerInterface&MockObject $logger;
	private Account&MockObject $account;
	private Mailbox $mailbox;
	private Message $message;

	protected function setUp(): void {
		parent::setUp();

		$this->mailManager = $this->createMock(IMailManager::class);
		$this->cacheFactory = $this->createMock(ICacheFactory::class);
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->account = $this->createMock(Account::class);
		$this->account->method('getId')->willReturn(17);
		$this->mailbox = new Mailbox();
		$this->message = new Message();
	}

	public function testLoadsEligibleInlineImagesOnceAndServesSiblingFromBundle(): void {
		$values = [
			'message_123' => [
				'inlineAttachments' => [
					['id' => '2.2', 'mime' => 'image/png', 'size' => 5],
					['id' => '2.3', 'mime' => 'image/jpeg', 'size' => 6],
				],
			],
		];
		$cache = $this->createStatefulMemcache($values);
		$this->cacheFactory->expects(self::exactly(2))
			->method('createDistributed')
			->with('mail_account_17')
			->willReturn($cache);
		$this->mailManager->expects(self::once())
			->method('getMailAttachments')
			->with(
				$this->account,
				$this->mailbox,
				$this->message,
				['2.2', '2.3'],
			)
			->willReturn([
				new Attachment('2.2', 'first.png', 'image/png', 'first', 5, 'first', 'inline'),
				new Attachment('2.3', 'second.jpg', 'image/jpeg', 'second', 6, 'second', 'inline'),
			]);
		$service = $this->newService();

		$first = $service->get($this->account, $this->mailbox, $this->message, 123, '2.2');
		$second = $service->get($this->account, $this->mailbox, $this->message, 123, '2.3');

		self::assertSame('first', $first?->getContent());
		self::assertSame('second', $second?->getContent());
		self::assertArrayHasKey('inline_attachment_bundle_123', $values);
		self::assertArrayNotHasKey('inline_attachment_bundle_lock_123', $values);
		self::assertSame(3600, InlineAttachmentCache::getBrowserCacheTtl());
	}

	public function testReturnsEveryEligiblePartInOneBrowserFacingBundle(): void {
		$values = [
			'message_123' => [
				'inlineAttachments' => [
					['id' => '2.2', 'mime' => 'image/png', 'size' => 5],
					['id' => '2.3', 'mime' => 'image/jpeg', 'size' => 6],
				],
			],
		];
		$cache = $this->createStatefulMemcache($values);
		$this->cacheFactory->expects(self::once())
			->method('createDistributed')
			->with('mail_account_17')
			->willReturn($cache);
		$this->mailManager->expects(self::once())
			->method('getMailAttachments')
			->with(
				$this->account,
				$this->mailbox,
				$this->message,
				['2.2', '2.3'],
			)
			->willReturn([
				new Attachment('2.2', 'first.png', 'image/png', 'first', 5, 'first', 'inline'),
				new Attachment('2.3', 'second.jpg', 'image/jpeg', 'second', 6, 'second', 'inline'),
			]);
		$service = $this->newService();

		$bundle = $service->getBundle(
			$this->account,
			$this->mailbox,
			$this->message,
			123,
		);

		self::assertSame(['2.2', '2.3'], array_keys($bundle));
		self::assertSame('first', $bundle['2.2']->getContent());
		self::assertSame('second', $bundle['2.3']->getContent());
	}

	public function testCandidatePolicyCapsCountAndTotalDeclaredBytes(): void {
		$service = $this->newService();
		$attachments = [
			['id' => 'first', 'mime' => 'image/png', 'size' => 64 * 1024],
			['id' => 'second', 'mime' => 'image/jpeg', 'size' => 64 * 1024],
			['id' => 'third', 'mime' => 'image/gif', 'size' => 64 * 1024],
			['id' => 'fourth', 'mime' => 'image/webp', 'size' => 64 * 1024],
			['id' => 'over-total', 'mime' => 'image/png', 'size' => 1],
			['id' => 'not-an-image', 'mime' => 'application/pdf', 'size' => 10],
		];

		$candidateIds = $service->getCandidateIds($attachments);

		self::assertSame(['first', 'second', 'third', 'fourth'], $candidateIds);
	}

	public function testIneligiblePartsDoNotStartAnImapBatch(): void {
		$values = [
			'message_123' => [
				'inlineAttachments' => [
					['id' => 'large', 'mime' => 'image/png', 'size' => 64 * 1024 + 1],
					['id' => 'pdf', 'mime' => 'application/pdf', 'size' => 100],
					['id' => 'unknown', 'mime' => 'image/png', 'size' => 0],
				],
			],
		];
		$cache = $this->createStatefulMemcache($values);
		$this->cacheFactory->method('createDistributed')->willReturn($cache);
		$this->mailManager->expects(self::never())->method('getMailAttachments');
		$service = $this->newService();

		self::assertNull($service->get($this->account, $this->mailbox, $this->message, 123, 'large'));
		self::assertNull($service->get($this->account, $this->mailbox, $this->message, 123, 'pdf'));
		self::assertNull($service->get($this->account, $this->mailbox, $this->message, 123, 'unknown'));
	}

	public function testActualContentSizeIsCheckedBeforeCaching(): void {
		$values = [
			'message_123' => [
				'inlineAttachments' => [
					['id' => '2.2', 'mime' => 'image/png', 'size' => 5],
				],
			],
		];
		$cache = $this->createStatefulMemcache($values);
		$this->cacheFactory->method('createDistributed')->willReturn($cache);
		$this->mailManager->expects(self::once())
			->method('getMailAttachments')
			->willReturn([
				new Attachment(
					'2.2',
					'too-large.png',
					'image/png',
					str_repeat('x', 64 * 1024 + 1),
					64 * 1024 + 1,
					'large',
					'inline',
				),
			]);
		$service = $this->newService();

		self::assertNull($service->get($this->account, $this->mailbox, $this->message, 123, '2.2'));
		self::assertSame([], $values['inline_attachment_bundle_123']);
	}

	public function testExistingBundleAvoidsImap(): void {
		$values = [
			'message_123' => [
				'inlineAttachments' => [
					['id' => '2.2', 'mime' => 'image/png', 'size' => 5],
				],
			],
			'inline_attachment_bundle_123' => [
				'2.2' => [
					'name' => 'cached.png',
					'type' => 'image/png',
					'content' => 'cache',
					'size' => 5,
					'contentId' => 'cached',
					'disposition' => 'inline',
				],
			],
		];
		$cache = $this->createStatefulMemcache($values);
		$this->cacheFactory->method('createDistributed')->willReturn($cache);
		$this->mailManager->expects(self::never())->method('getMailAttachments');
		$service = $this->newService();

		$attachment = $service->get(
			$this->account,
			$this->mailbox,
			$this->message,
			123,
			'2.2',
		);

		self::assertSame('cache', $attachment?->getContent());
		self::assertSame('cached.png', $attachment?->getName());
	}

	/**
	 * @param array<string, mixed> $values
	 */
	private function createStatefulMemcache(array &$values): IMemcache&MockObject {
		$cache = $this->createMock(IMemcache::class);
		$cache->method('get')
			->willReturnCallback(static function (string $key) use (&$values): mixed {
				return $values[$key] ?? null;
			});
		$cache->method('set')
			->willReturnCallback(static function (string $key, mixed $value) use (&$values): bool {
				$values[$key] = $value;
				return true;
			});
		$cache->method('add')
			->willReturnCallback(static function (string $key, mixed $value) use (&$values): bool {
				if (array_key_exists($key, $values)) {
					return false;
				}
				$values[$key] = $value;
				return true;
			});
		$cache->method('remove')
			->willReturnCallback(static function (string $key) use (&$values): bool {
				if (!array_key_exists($key, $values)) {
					return false;
				}
				unset($values[$key]);
				return true;
			});

		return $cache;
	}

	private function newService(): InlineAttachmentCache {
		return new InlineAttachmentCache(
			$this->mailManager,
			$this->cacheFactory,
			$this->logger,
		);
	}
}
