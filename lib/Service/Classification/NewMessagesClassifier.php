<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Classification;

use Horde_Imap_Client;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\Tag;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\ServiceException;
use Psr\Log\LoggerInterface;

class NewMessagesClassifier {
	private const EXEMPT_FROM_CLASSIFICATION = [
		Horde_Imap_Client::SPECIALUSE_ARCHIVE,
		Horde_Imap_Client::SPECIALUSE_DRAFTS,
		Horde_Imap_Client::SPECIALUSE_JUNK,
		Horde_Imap_Client::SPECIALUSE_SENT,
		Horde_Imap_Client::SPECIALUSE_TRASH,
	];

	public function __construct(
		private ImportanceClassifier $classifier,
		private TagMapper $tagMapper,
		private LoggerInterface $logger,
		private IMailManager $mailManager,
	) {
	}

	/**
	 * Classify a batch on freshly synced messages.
	 * Objects in the incoming $messages array are mutated in place.
	 *
	 * The importance tag will be propagated to IMAP and its mapping will be persisted to the db.
	 * However, changes to db message objects themselves won't be persisted.
	 * This is up to the caller (e.g. MessageMapper->insertBulk()).
	 *
	 * @param Message[] $messages
	 * @param Mailbox $mailbox
	 * @param Account $account
	 * @param Tag $importantTag
	 * @return bool true if classification was done
	 */
	public function classifyNewMessages(
		array $messages,
		Mailbox $mailbox,
		Account $account,
		Tag $importantTag,
	): bool {
		if (!$account->getMailAccount()->getClassificationEnabled()) {
			return false;
		}

		foreach (self::EXEMPT_FROM_CLASSIFICATION as $specialUse) {
			if ($mailbox->isSpecialUse($specialUse)) {
				// Nothing to do then
				return false;
			}
		}

		// if this is a message that's been flagged / tagged as important before, we don't want to reclassify it again.
		$doNotReclassify = $this->tagMapper->getTaggedMessageIdsForMessages(
			$messages,
			$account->getUserId(),
			Tag::LABEL_IMPORTANT
		);
		$messages = array_filter($messages, static fn ($message) => $message->getFlagImportant() === false || in_array($message->getMessageId(), $doNotReclassify, true));

		try {
			$predictions = $this->classifier->classifyImportance(
				$account,
				$messages,
				$this->logger
			);
		} catch (ServiceException $e) {
			$this->logger->error('Could not classify incoming message importance: ' . $e->getMessage(), [
				'exception' => $e,
			]);
			return true;
		}

		foreach ($messages as $message) {
			$prediction = $predictions[$message->getUid()] ?? false;
			$this->logger->info("Message {$message->getUid()} ({$message->getPreviewText()}) is " . ($prediction ? 'important' : 'not important'));
			if (!$prediction) {
				continue;
			}

			// Each message's persistence is isolated: a failure here used
			// to abort the whole batch (the catch sat outside the loop),
			// leaving every remaining message unclassified for good AND
			// the current one permanently half-written -- flag set (both
			// in this in-memory object, persisted by the caller, and as
			// the IMAP keyword) with no matching $label1 tag row, since
			// tagMessage() runs after flagMessage() and neither is rolled
			// back. Confirmed live (a whole Gmail thread flag-important
			// with zero tag rows). The tag write also gets one retry: it
			// is the last step, so a transient failure there is the exact
			// signature that used to stick forever. Whatever still slips
			// through is healed by ReconcileImportanceTagJob's nightly
			// pass -- this loop and that job are two halves of one
			// mechanism.
			try {
				$message->setFlagImportant(true);
				$this->mailManager->flagMessage($account, $mailbox->getName(), $message->getUid(), Tag::LABEL_IMPORTANT, true);
				try {
					$this->mailManager->tagMessage($account, $mailbox->getName(), $message, $importantTag, true);
				} catch (ServiceException|ClientException $e) {
					$this->logger->warning("Retrying importance tag for message {$message->getUid()} after: " . $e->getMessage());
					$this->mailManager->tagMessage($account, $mailbox->getName(), $message, $importantTag, true);
				}
			} catch (ServiceException|ClientException $e) {
				$this->logger->error("Could not persist importance of message {$message->getUid()}, continuing with the rest of the batch: " . $e->getMessage(), [
					'exception' => $e,
				]);
			}
		}
		return true;
	}
}
