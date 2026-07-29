<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Db;

use Horde_Mail_Rfc822_Identification;
use JsonSerializable;
use OCA\Mail\AddressList;
use OCA\Mail\Service\Avatar\Avatar;
use OCP\AppFramework\Db\Entity;
use ReturnTypeWillChange;
use function in_array;
use function json_decode;
use function json_encode;

/**
 * @method void setUid(int $uid)
 * @method int getUid()
 * @method string|null getMessageId()
 * @method void setReferences(string $references)
 * @method string|null getReferences()
 * @method string|null getInReplyTo()
 * @method string|null getThreadRootId()
 * @method void setMailboxId(int $mailbox)
 * @method int getMailboxId()
 * @method void setSubject(string $subject)
 * @method string getSubject()
 * @method void setSentAt(int $time)
 * @method int getSentAt()
 * @method void setFlagAnswered(bool $answered)
 * @method bool|null getFlagAnswered()
 * @method void setFlagDeleted(bool $deleted)
 * @method bool|null getFlagDeleted()
 * @method void setFlagDraft(bool $answered)
 * @method bool|null|null getFlagDraft()
 * @method void setFlagFlagged(bool $flagged)
 * @method bool|null getFlagFlagged()
 * @method void setFlagSeen(bool $seen)
 * @method bool|null getFlagSeen()
 * @method void setFlagForwarded(bool $forwarded)
 * @method bool|null getFlagForwarded()
 * @method void setFlagJunk(bool $junk)
 * @method bool|null getFlagJunk()
 * @method void setFlagNotjunk(bool $notjunk)
 * @method bool|null getFlagNotjunk()
 * @method void setStructureAnalyzed(bool $analyzed)
 * @method bool|null getStructureAnalyzed()
 * @method void setFlagAttachments(?bool $hasAttachments)
 * @method null|bool getFlagAttachments()
 * @method void setFlagImportant(bool $important)
 * @method bool|null getFlagImportant()
 * @method void setFlagMdnsent(bool $mdnsent)
 * @method bool|null getFlagMdnsent()
 * @method void setPreviewText(?string $subject)
 * @method null|string getPreviewText()
 * @method void setSummary(?string $summary)
 * @method null|string getSummary()
 * @method void setUpdatedAt(int $time)
 * @method int getUpdatedAt()
 * @method bool isImipMessage()
 * @method void setImipMessage(bool $imipMessage)
 * @method bool isImipProcessed()
 * @method void setImipProcessed(bool $imipProcessed)
 * @method bool isImipError()
 * @method void setImipError(bool $imipError)
 * @method bool|null isEncrypted()
 * @method void setEncrypted(bool|null $encrypted)
 * @method bool getMentionsMe()
 * @method void setMentionsMe(bool $isMentionned)
 */
class Message extends Entity implements JsonSerializable {
	private const MUTABLE_FLAGS = [
		'answered',
		'deleted',
		'draft',
		'flagged',
		'seen',
		'forwarded',
		'$junk',
		'$notjunk',
		'$phishing',
		'$mdnsent',
		Tag::LABEL_IMPORTANT,
		'$important' // @todo remove this when we have removed all references on IMAP to $important @link https://github.com/nextcloud/mail/issues/25
	];

	protected $uid;
	protected $messageId;
	protected $references;
	protected $inReplyTo;
	protected $threadRootId;
	protected $mailboxId;
	protected $subject;
	protected $sentAt;
	protected $flagAnswered;
	protected $flagDeleted;
	protected $flagDraft;
	protected $flagFlagged;
	protected $flagSeen;
	protected $flagForwarded;
	protected $flagJunk;
	protected $flagNotjunk;
	protected $updatedAt;
	protected $structureAnalyzed;
	protected $flagAttachments;
	protected $flagImportant = false;
	protected $flagMdnsent;
	protected $previewText;
	protected $summary;
	protected $imipMessage = false;
	protected $imipProcessed = false;
	protected $imipError = false;
	protected $mentionsMe = false;

	/**
	 * @var bool|null
	 */
	protected $encrypted;

	/** @var AddressList */
	private $from;

	/** @var AddressList */
	private $to;

	/** @var AddressList */
	private $cc;

	/** @var AddressList */
	private $bcc;

	/** @var Tag[] */
	private $tags = [];

	/** @var Avatar|null */
	private $avatar;

	/** @var bool */
	private $fetchAvatarFromClient = false;
	/** @var array */
	private $attachments = [];

	/**
	 * Whether this message's thread (see threadRootId) contains any unseen
	 * message -- not just this one. Computed at read time (see
	 * MessageMapper::findRelatedData()), not persisted. Threaded listings
	 * show one row per thread (this message, if it's the newest), so its
	 * own flag_seen alone can't tell the frontend whether the thread as a
	 * whole should still be shown as unread.
	 *
	 * @var bool
	 */
	private $hasUnseenInThread = false;

	/**
	 * Thread-wide counterparts of this row's own favorite/important flags.
	 * They are computed at read time together with hasUnseenInThread and let
	 * the client classify one unfiltered content-search result into Priority
	 * Inbox sections without repeating the expensive content predicate once
	 * per section.
	 */
	private bool $hasFlaggedInThread = false;
	/**
	 * Whether a task was made from this message, and whether one was made from
	 * anywhere in its thread. Not columns: filled by
	 * MessageMapper::applyThreadFlagAggregates() from mail_message_tasks, the
	 * same way the thread flags beside them are.
	 */
	private bool $hasTask = false;
	private bool $hasTaskInThread = false;
	private bool $hasImportantInThread = false;
	private ?int $threadUpdatedAt = null;

	public function __construct() {
		$this->from = new AddressList([]);
		$this->to = new AddressList([]);
		$this->cc = new AddressList([]);
		$this->bcc = new AddressList([]);

		$this->addType('uid', 'integer');
		$this->addType('mailboxId', 'integer');
		$this->addType('sentAt', 'integer');
		$this->addType('flagAnswered', 'boolean');
		$this->addType('flagDeleted', 'boolean');
		$this->addType('flagDraft', 'boolean');
		$this->addType('flagFlagged', 'boolean');
		$this->addType('flagSeen', 'boolean');
		$this->addType('flagForwarded', 'boolean');
		$this->addType('flagJunk', 'boolean');
		$this->addType('flagNotjunk', 'boolean');
		$this->addType('structureAnalyzed', 'boolean');
		$this->addType('flagAttachments', 'boolean');
		$this->addType('flagImportant', 'boolean');
		$this->addType('flagMdnsent', 'boolean');
		$this->addType('updatedAt', 'integer');
		$this->addType('imipMessage', 'boolean');
		$this->addType('imipProcessed', 'boolean');
		$this->addType('imipError', 'boolean');
		$this->addType('encrypted', 'boolean');
	}

	/**
	 * @param string|null $messageId
	 *
	 * Parses the message ID to see if it is a valid Horde_Mail_Rfc822_Identification
	 * before setting it, or sets null if it is not valid.
	 */
	public function setMessageId(?string $messageId): void {
		$this->setter('messageId', [$this->parseMessageId($messageId)]);
	}

	public function setRawReferences(?string $references): void {
		$parsed = new Horde_Mail_Rfc822_Identification($references);
		$this->setter('references', [json_encode($parsed->ids)]);
	}

	public function setInReplyTo(?string $inReplyTo): void {
		$this->setter('inReplyTo', [$this->parseMessageId($inReplyTo)]);
	}

	public function setThreadRootId(?string $threadRootId): void {
		$this->setter('threadRootId', [$this->parseMessageId($threadRootId) ?? $this->messageId]);
	}

	private function parseMessageId(?string $id): ?string {
		if (empty($id)) {
			return null;
		}

		// trim whitespace and <>
		$id = '<' . trim(trim($id), '<>') . '>';

		$parsed = new Horde_Mail_Rfc822_Identification($id);
		return $parsed->ids[0] ?? null;
	}

	/**
	 * @return AddressList
	 */
	public function getFrom(): AddressList {
		return $this->from;
	}

	/**
	 * @param AddressList $from
	 */
	public function setFrom(AddressList $from): void {
		$this->from = $from;
	}

	/**
	 * @return AddressList
	 */
	public function getTo(): AddressList {
		return $this->to;
	}

	/**
	 * @param AddressList $to
	 */
	public function setTo(AddressList $to): void {
		$this->to = $to;
	}

	/**
	 * @return Tag[]
	 */
	public function getTags(): array {
		return $this->tags;
	}

	/**
	 * @param array $tags
	 */
	public function setTags(array $tags): void {
		$this->tags = $tags;
	}

	/**
	 * @return AddressList
	 */
	public function getCc(): AddressList {
		return $this->cc;
	}

	/**
	 * @param AddressList $cc
	 */
	public function setCc(AddressList $cc): void {
		$this->cc = $cc;
	}

	/**
	 * @return AddressList
	 */
	public function getBcc(): AddressList {
		return $this->bcc;
	}

	/**
	 * @param AddressList $bcc
	 */
	public function setBcc(AddressList $bcc): void {
		$this->bcc = $bcc;
	}

	/**
	 * @return void
	 */
	public function setFlag(string $flag, bool $value = true) {
		if (!in_array($flag, self::MUTABLE_FLAGS, true)) {
			// Ignore
			return;
		}
		if ($flag === Tag::LABEL_IMPORTANT) {
			$this->setFlagImportant($value);
		} elseif ($flag === '$junk') {
			$this->setFlagJunk($value);
		} elseif ($flag === '$notjunk') {
			$this->setFlagNotjunk($value);
		} elseif ($flag === '$mdnsent') {
			$this->setFlagMdnsent($value);
		} else {
			$this->setter(
				$this->columnToProperty("flag_$flag"),
				[$value]
			);
		}
	}
	/**
	 * @param Avatar|null $avatar
	 * @return void
	 */
	public function setAvatar(?Avatar $avatar): void {
		$this->avatar = $avatar;
	}

	public function setFetchAvatarFromClient(bool $fetchAvatarFromClient): void {
		$this->fetchAvatarFromClient = $fetchAvatarFromClient;
	}

	/**
	 * @return ?Avatar
	 */
	public function getAvatar(): ?Avatar {
		return $this->avatar;
	}

	public function setAttachments(array $attachments): void {
		$this->attachments = $attachments;
	}

	public function getAttachments(): array {
		return $this->attachments;
	}

	public function setHasUnseenInThread(bool $hasUnseenInThread): void {
		$this->hasUnseenInThread = $hasUnseenInThread;
	}

	public function getHasUnseenInThread(): bool {
		return $this->hasUnseenInThread;
	}

	public function setHasTask(bool $hasTask): void {
		$this->hasTask = $hasTask;
	}

	public function getHasTask(): bool {
		return $this->hasTask;
	}

	public function setHasTaskInThread(bool $hasTaskInThread): void {
		$this->hasTaskInThread = $hasTaskInThread;
	}

	public function getHasTaskInThread(): bool {
		return $this->hasTaskInThread;
	}

	public function setHasFlaggedInThread(bool $hasFlaggedInThread): void {
		$this->hasFlaggedInThread = $hasFlaggedInThread;
	}

	public function getHasFlaggedInThread(): bool {
		return $this->hasFlaggedInThread;
	}

	public function setHasImportantInThread(bool $hasImportantInThread): void {
		$this->hasImportantInThread = $hasImportantInThread;
	}

	public function getHasImportantInThread(): bool {
		return $this->hasImportantInThread;
	}

	public function setThreadUpdatedAt(?int $threadUpdatedAt): void {
		$this->threadUpdatedAt = $threadUpdatedAt;
	}

	/**
	 * Compact, deterministic state used by mailbox sync clients.
	 *
	 * This deliberately contains only mutable list-envelope state. It lets a
	 * sync compare thousands of known rows through a narrow id/state query and
	 * hydrate full messages (recipients, tags, avatars, attachments) only for
	 * rows that actually changed.
	 */
	public function getSyncState(): string {
		return self::buildSyncState(
			$this->getUpdatedAt(),
			[
				$this->getFlagAnswered(),
				$this->getFlagDeleted(),
				$this->getFlagDraft(),
				$this->getFlagFlagged(),
				$this->getFlagSeen(),
				$this->getFlagForwarded(),
				$this->getFlagJunk(),
				$this->getFlagNotjunk(),
				$this->getFlagAttachments(),
				$this->getFlagImportant(),
				$this->getFlagMdnsent(),
			],
			$this->threadUpdatedAt,
			$this->hasUnseenInThread,
			$this->hasFlaggedInThread,
			$this->hasImportantInThread,
		);
	}

	/**
	 * @param array<int, mixed> $flags
	 */
	public static function buildSyncState(
		?int $updatedAt,
		array $flags,
		?int $threadUpdatedAt,
		bool $hasUnseenInThread,
		bool $hasFlaggedInThread,
		bool $hasImportantInThread,
	): string {
		$flagBits = implode('', array_map(
			static fn ($flag): string => in_array($flag, [true, 1, '1', 't', 'true'], true) ? '1' : '0',
			$flags,
		));
		$threadBits = ($hasUnseenInThread ? '1' : '0')
			. ($hasFlaggedInThread ? '1' : '0')
			. ($hasImportantInThread ? '1' : '0');

		return max($updatedAt ?? 0, $threadUpdatedAt ?? 0) . ':' . $flagBits . ':' . $threadBits;
	}

	#[\Override]
	#[ReturnTypeWillChange]
	public function jsonSerialize() {
		$tags = $this->getTags();
		$indexed = array_combine(
			array_map(
				static fn (Tag $tag) => $tag->getImapLabel(), $tags),
			$tags
		);

		return [
			'databaseId' => $this->getId(),
			'syncState' => $this->getSyncState(),
			'uid' => $this->getUid(),
			'subject' => $this->getSubject(),
			'dateInt' => $this->getSentAt(),
			'flags' => [
				'seen' => ($this->getFlagSeen() === true),
				'flagged' => ($this->getFlagFlagged() === true),
				'answered' => ($this->getFlagAnswered() === true),
				'deleted' => ($this->getFlagDeleted() === true),
				'draft' => ($this->getFlagDraft() === true),
				'forwarded' => ($this->getFlagForwarded() === true),
				'hasAttachments' => ($this->getFlagAttachments() ?? false),
				'important' => ($this->getFlagImportant() === true),
				'$junk' => ($this->getFlagJunk() === true),
				'$notjunk' => ($this->getFlagNotjunk() === true),
				'$mdnsent' => ($this->getFlagMdnsent() === true),
				'hasUnseenInThread' => $this->hasUnseenInThread,
				'hasFlaggedInThread' => $this->hasFlaggedInThread,
				'hasTask' => $this->hasTask,
				'hasTaskInThread' => $this->hasTaskInThread,
				'hasImportantInThread' => $this->hasImportantInThread,
			],
			'tags' => $indexed,
			'from' => $this->getFrom()->jsonSerialize(),
			'to' => $this->getTo()->jsonSerialize(),
			'cc' => $this->getCc()->jsonSerialize(),
			'bcc' => $this->getBcc()->jsonSerialize(),
			'mailboxId' => $this->getMailboxId(),
			'messageId' => $this->getMessageId(),
			'inReplyTo' => $this->getInReplyTo(),
			'references' => empty($this->getReferences()) ? null: json_decode($this->getReferences(), true),
			'threadRootId' => $this->getThreadRootId(),
			'imipMessage' => $this->isImipMessage(),
			'previewText' => $this->getPreviewText(),
			'summary' => $this->getSummary(),
			'encrypted' => ($this->isEncrypted() === true),
			'mentionsMe' => $this->getMentionsMe(),
			'avatar' => $this->avatar?->jsonSerialize(),
			'fetchAvatarFromClient' => $this->fetchAvatarFromClient,
			'attachments' => $this->getAttachments(),
		];
	}
}
