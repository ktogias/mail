<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service\Classification;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\Tag;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Service\Classification\ImportanceClassifier;
use OCA\Mail\Service\Classification\NewMessagesClassifier;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class NewMessagesClassifierTest extends TestCase {
	/** @var ImportanceClassifier|MockObject */
	private $classifier;

	/** @var TagMapper|MockObject */
	private $tagMapper;

	/** @var IMailManager|MockObject */
	private $mailManager;

	private NewMessagesClassifier $newMessagesClassifier;

	private Account $account;
	private Mailbox $mailbox;
	private Tag $importantTag;

	protected function setUp(): void {
		parent::setUp();

		$this->classifier = $this->createMock(ImportanceClassifier::class);
		$this->tagMapper = $this->createMock(TagMapper::class);
		$this->mailManager = $this->createMock(IMailManager::class);

		$this->newMessagesClassifier = new NewMessagesClassifier(
			$this->classifier,
			$this->tagMapper,
			$this->createMock(LoggerInterface::class),
			$this->mailManager,
		);

		$mailAccount = new MailAccount();
		$mailAccount->setUserId('user');
		$mailAccount->setClassificationEnabled(true);
		$this->account = new Account($mailAccount);
		$this->mailbox = new Mailbox();
		$this->mailbox->setName('INBOX');
		$this->mailbox->setSpecialUse('[]');
		$this->importantTag = new Tag();
		$this->importantTag->setImapLabel(Tag::LABEL_IMPORTANT);
	}

	private function newMessage(int $uid): Message {
		$message = new Message();
		$message->setUid($uid);
		$message->setMessageId("<$uid@test>");
		$message->setFlagImportant(false);
		$message->setPreviewText('preview');
		return $message;
	}

	public function testFlagsAndTagsEveryPredictedImportantMessage(): void {
		$a = $this->newMessage(1);
		$b = $this->newMessage(2);
		$this->classifier->method('classifyImportance')->willReturn([1 => true, 2 => true]);

		$this->mailManager->expects($this->exactly(2))->method('flagMessage');
		$this->mailManager->expects($this->exactly(2))->method('tagMessage');

		$this->newMessagesClassifier->classifyNewMessages([$a, $b], $this->mailbox, $this->account, $this->importantTag);

		self::assertTrue($a->getFlagImportant());
		self::assertTrue($b->getFlagImportant());
	}

	/**
	 * Regression: a persistence failure for one message used to abort the
	 * whole batch (the catch sat outside the loop) -- every remaining
	 * message stayed unclassified for good, and the failed one was left
	 * permanently half-written (flag without tag; confirmed live).
	 */
	public function testOneMessagesFailureDoesNotAbortTheRestOfTheBatch(): void {
		$a = $this->newMessage(1);
		$b = $this->newMessage(2);
		$this->classifier->method('classifyImportance')->willReturn([1 => true, 2 => true]);

		$this->mailManager->method('flagMessage')
			->willReturnCallback(static function ($account, $mailboxName, $uid): void {
				if ($uid === 1) {
					throw new ServiceException('imap hiccup');
				}
			});
		$taggedUids = [];
		$this->mailManager->method('tagMessage')
			->willReturnCallback(static function ($account, $mailboxName, $message) use (&$taggedUids): void {
				$taggedUids[] = $message->getUid();
			});

		$this->newMessagesClassifier->classifyNewMessages([$a, $b], $this->mailbox, $this->account, $this->importantTag);

		// Message 2 was fully processed despite message 1's failure.
		self::assertEquals([2], $taggedUids);
		self::assertTrue($b->getFlagImportant());
	}

	/**
	 * The tag write is the last step of the trio, so a transient failure
	 * there is the exact signature that used to stick forever (flag and
	 * IMAP keyword written, no tag row). It gets one retry before giving
	 * up to the nightly reconciliation job.
	 */
	public function testTagWriteIsRetriedOnceOnTransientFailure(): void {
		$a = $this->newMessage(1);
		$this->classifier->method('classifyImportance')->willReturn([1 => true]);

		$attempts = 0;
		$this->mailManager->method('tagMessage')
			->willReturnCallback(static function () use (&$attempts): void {
				$attempts++;
				if ($attempts === 1) {
					throw new ServiceException('transient');
				}
			});

		$this->newMessagesClassifier->classifyNewMessages([$a], $this->mailbox, $this->account, $this->importantTag);

		self::assertEquals(2, $attempts);
		self::assertTrue($a->getFlagImportant());
	}

	public function testDoesNothingWhenClassificationIsDisabled(): void {
		$this->account->getMailAccount()->setClassificationEnabled(false);
		$this->classifier->expects($this->never())->method('classifyImportance');

		$result = $this->newMessagesClassifier->classifyNewMessages(
			[$this->newMessage(1)],
			$this->mailbox,
			$this->account,
			$this->importantTag,
		);

		self::assertFalse($result);
	}
}
