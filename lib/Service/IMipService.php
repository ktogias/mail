<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service;

use OCA\Mail\Account;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\MailboxMapper;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Model\IMAPMessage;
use OCA\Mail\Util\ServerVersion;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\Calendar\IManager;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;
use Throwable;
use function array_filter;

class IMipService {
	private IManager $calendarManager;

	public function __construct(
		private AccountService $accountService,
		IManager $manager,
		private LoggerInterface $logger,
		private MailboxMapper $mailboxMapper,
		private MailManager $mailManager,
		private MessageMapper $messageMapper,
		private ServerVersion $serverVersion,
		private IMipAttendeeRewriter $attendeeRewriter,
		private IUserManager $userManager,
	) {
		$this->calendarManager = $manager;
	}

	public function process(): void {
		$messages = $this->messageMapper->findIMipMessagesAscending();
		if ($messages === []) {
			$this->logger->debug('No iMIP messages to process.');
			return;
		}

		// Collect all mailboxes in memory
		// possible perf improvement - make this one IN query
		// and JOIN with accounts table
		// although this might not make much of a difference
		// since there are very few messages to process
		$mailboxIds = array_unique(array_map(static fn (Message $message) => $message->getMailboxId(), $messages));

		$mailboxes = array_map(function (int $mailboxId) {
			try {
				return $this->mailboxMapper->findById($mailboxId);
			} catch (DoesNotExistException|ServiceException $e) {
				return null;
			}
		}, $mailboxIds);
		$existingMailboxes = array_filter($mailboxes);

		// Collect all accounts in memory
		$accountIds = array_unique(array_map(static fn (Mailbox $mailbox) => $mailbox->getAccountId(), $existingMailboxes));

		$accounts = array_combine($accountIds, array_map(function (int $accountId) {
			try {
				return $this->accountService->findById($accountId);
			} catch (DoesNotExistException $e) {
				return null;
			}
		}, $accountIds));

		foreach ($existingMailboxes as $mailbox) {
			/** @var Account $account */
			$account = $accounts[$mailbox->getAccountId()];
			$filteredMessages = array_filter($messages, static fn ($message) => $message->getMailboxId() === $mailbox->getId());

			if ($filteredMessages === []) {
				continue;
			}

			// Check for accounts or mailboxes that no longer exist,
			// no processing for drafts, sent items, junk or archive
			if ($account === null
				|| $account->getMailAccount()->getArchiveMailboxId() === $mailbox->getId()
				|| $account->getMailAccount()->getSnoozeMailboxId() === $mailbox->getId()
				|| $account->getMailAccount()->getTrashMailboxId() === $mailbox->getId()
				|| $account->getMailAccount()->getSentMailboxId() === $mailbox->getId()
				|| $account->getMailAccount()->getDraftsMailboxId() === $mailbox->getId()
				|| $mailbox->isSpecialUse(\Horde_Imap_Client::SPECIALUSE_ARCHIVE)
			) {
				$processedMessages = array_map(static function (Message $message) {
					$message->setImipProcessed(true);
					return $message;
				}, $filteredMessages); // Silently drop from passing to DAV and mark as processed, so we won't run into these messages again.
				$this->messageMapper->updateImipData(...$processedMessages);
				continue;
			}

			try {
				$imapMessages = $this->mailManager->getImapMessagesForScheduleProcessing($account, $mailbox, array_map(static fn ($message) => $message->getUid(), $filteredMessages));
			} catch (ServiceException $e) {
				$this->logger->error('Could not get IMAP messages form IMAP server', ['exception' => $e]);
				continue;
			}

			$userId = $account->getUserId();
			$recipient = $account->getEmail();
			$imipCreate = $account->getMailAccount()->getImipCreate();
			$systemVersion = $this->serverVersion->getMajorVersion();

			foreach ($filteredMessages as $message) {
				/** @var IMAPMessage $imapMessage */
				$imapMessage = current(array_filter($imapMessages, static fn (IMAPMessage $imapMessage) => $message->getUid() === $imapMessage->getUid()));
				if (empty($imapMessage->scheduling)) {
					// No scheduling info, maybe the DB is wrong
					$message->setImipProcessed(true);
					$message->setImipError(true);
					continue;
				}

				$sender = $imapMessage->getFrom()->first()?->getEmail();
				if ($sender === null) {
					$message->setImipProcessed(true);
					$message->setImipError(true);
					continue;
				}

				try {
					// an IMAP message could contain more than one iMIP object
					foreach ($imapMessage->scheduling as $schedulingInfo) {
						$processed = false;
						$contents = $schedulingInfo['contents'];

						// An invitation that arrived through a mailing list
						// names the LIST as its attendee, never this user, and
						// the calendar layer refuses such a message outright --
						// which silently loses the CANCELs as well, leaving
						// called-off meetings in the calendar looking
						// confirmed. The account can opt into accepting them,
						// and until now that setting reached only the browser.
						if ($account->getMailAccount()->getImipAllowUnmatched()) {
							$rewritten = $this->attendeeRewriter->addRecipientIfUnmatched(
								$contents,
								// The CalDAV principal's address, not the mail
								// account's: the recipient check compares
								// against calendar-user-address-set, which the
								// account's own address is usually absent from.
								(string)$this->userManager->get($userId)?->getSystemEMailAddress(),
							);
							if ($rewritten !== null) {
								$this->logger->debug('Added the user as an attendee to an unmatched iMIP message', [
									'messageId' => $message->getId(),
									'method' => $schedulingInfo['method'],
								]);
								$contents = $rewritten;
							}
						}
						if ($systemVersion < 33) {
							$principalUri = 'principals/users/' . $userId;
							if ($schedulingInfo['method'] === 'REQUEST') {
								$processed = $this->calendarManager->handleIMipRequest($principalUri, $sender, $recipient, $contents);
							} elseif ($schedulingInfo['method'] === 'REPLY') {
								$processed = $this->calendarManager->handleIMipReply($principalUri, $sender, $recipient, $contents);
							} elseif ($schedulingInfo['method'] === 'CANCEL') {
								$replyTo = $imapMessage->getReplyTo()->first()?->getEmail();
								$processed = $this->calendarManager->handleIMipCancel($principalUri, $sender, $replyTo, $recipient, $contents);
							}
						} else {
							if (!method_exists($this->calendarManager, 'handleIMip')) {
								$this->logger->error('iMIP handling is not supported by server version installed.');
								continue;
							}
							$processed = $this->calendarManager->handleIMip(
								$userId,
								$contents,
								[
									'recipient' => $recipient,
									'absent' => $imipCreate ? 'create' : 'ignore',
									'absentCreateStatus' => 'tentative',
								],
							);
						}

						$message->setImipProcessed($processed);
						$message->setImipError(!$processed);
					}
				} catch (Throwable $e) {
					$this->logger->error('iMIP message processing failed', [
						'exception' => $e,
						'messageId' => $message->getId(),
						'mailboxId' => $mailbox->getId(),
					]);
					$message->setImipProcessed(true);
					$message->setImipError(true);
				}
			}
			$this->messageMapper->updateImipData(...$filteredMessages);
		}
	}
}
