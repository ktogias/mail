<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Db;

use OCA\Mail\Account;
use OCA\Mail\Address;
use OCA\Mail\AddressList;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\IMAP\Threading\DatabaseMessage;
use OCA\Mail\Service\Search\Flag;
use OCA\Mail\Service\Search\FlagExpression;
use OCA\Mail\Service\Search\GlobalSearchQuery;
use OCA\Mail\Service\Search\SearchQuery;
use OCA\Mail\Support\PerformanceLogger;
use OCA\Mail\Support\PerformanceLoggerTask;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\QBMapper;
use OCP\AppFramework\Db\TTransactional;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\Exception;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\ICacheFactory;
use OCP\IDBConnection;
use OCP\IMemcache;
use OCP\IUser;
use RuntimeException;
use Throwable;
use function array_chunk;
use function array_combine;
use function array_keys;
use function array_map;
use function array_merge;
use function array_udiff;
use function get_class;
use function ltrim;
use function mb_convert_encoding;
use function mb_strcut;
use function OCA\Mail\array_flat_map;
use function strlen;

/**
 * @template-extends QBMapper<Message>
 */
class MessageMapper extends QBMapper {

	use TTransactional;

	/** @var ITimeFactory */
	private $timeFactory;

	// How long a just-confirmed flag_important value (true OR false --
	// symmetric, see shouldTrustFlagImportantReading()) stays protected
	// from a routine resync reading a fresh, contradicting value.
	//
	// This is architecturally the exact same race starring/seen already
	// have: flagMessage() only ever writes to IMAP, never straight to
	// this app's own DB -- the local flag_flagged/flag_seen/flag_important
	// column only catches up once a later sync reads the write back. For
	// starring/seen, that race is invisible: it's always a user-initiated
	// click, protected client-side by recentFlagChanges/
	// RECENT_FLAG_CHANGE_GRACE_MS (actions.js, also 120s, also raised
	// today for the same underlying reason) -- and that protection is
	// symmetric too, covering a click in either direction. flag_important
	// changes -- whether NewMessagesClassifier deciding true, or the
	// user's own markEnvelopeImportantOrUnimportant() deciding false --
	// have no client-side action to hang that same protection off of, so
	// the identical race becomes directly visible instead of silently
	// masked. Same race, same magnitude, same fix -- just enforced
	// server-side here since there is no client action to anchor it to.
	private const FLAG_IMPORTANT_GRACE_SECONDS = 120;

	public function __construct(
		IDBConnection $db,
		ITimeFactory $timeFactory,
		private TagMapper $tagMapper,
		private PerformanceLogger $performanceLogger,
		private ICacheFactory $cacheFactory,
	) {
		parent::__construct($db, 'mail_messages');
		$this->timeFactory = $timeFactory;
	}

	/**
	 * @param IQueryBuilder $query
	 *
	 * @return int[]
	 */
	private function findUids(IQueryBuilder $query): array {
		$result = $query->executeQuery();
		$uids = array_map(static fn (array $row) => (int)$row['uid'], $result->fetchAll());
		$result->closeCursor();

		return $uids;
	}

	/**
	 * @param IQueryBuilder $query
	 *
	 * @return int[]
	 */
	private function findIds(IQueryBuilder $query): array {
		$result = $query->executeQuery();
		$uids = array_map(static fn (array $row) => (int)$row['id'], $result->fetchAll());
		$result->closeCursor();

		return $uids;
	}

	public function findHighestUid(Mailbox $mailbox): ?int {
		$query = $this->db->getQueryBuilder();

		$query->select($query->func()->max('uid'))
			->from($this->getTableName())
			->where($query->expr()->eq('mailbox_id', $query->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT));

		$result = $query->executeQuery();
		$max = (int)$result->fetchColumn();
		$result->closeCursor();

		if ($max === 0) {
			return null;
		}
		return $max;
	}

	public function findLowestUid(Mailbox $mailbox): ?int {
		$query = $this->db->getQueryBuilder();

		$query->select($query->func()->min('uid'))
			->from($this->getTableName())
			->where($query->expr()->eq('mailbox_id', $query->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT));

		$result = $query->executeQuery();
		$min = (int)$result->fetchColumn();
		$result->closeCursor();

		if ($min === 0) {
			return null;
		}
		return $min;
	}

	public function findByUserId(string $userId, int $id): Message {
		$query = $this->db->getQueryBuilder();

		$query->select('m.*')
			->from($this->getTableName(), 'm')
			->join('m', 'mail_mailboxes', 'mb', $query->expr()->eq('m.mailbox_id', 'mb.id', IQueryBuilder::PARAM_INT))
			->join('m', 'mail_accounts', 'a', $query->expr()->eq('mb.account_id', 'a.id', IQueryBuilder::PARAM_INT))
			->where(
				$query->expr()->eq('a.user_id', $query->createNamedParameter($userId)),
				$query->expr()->eq('m.id', $query->createNamedParameter($id, IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT)
			);

		$results = $this->findRelatedData($this->findEntities($query), $userId);
		if ($results === []) {
			throw new DoesNotExistException("Message $id does not exist");
		}
		return $results[0];
	}

	/**
	 * @throws DoesNotExistException
	 */
	public function findAccountIdForMessage(int $messageId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select('mb.account_id')
			->from($this->getTableName(), 'm')
			->join('m', 'mail_mailboxes', 'mb', $qb->expr()->eq('m.mailbox_id', 'mb.id', IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('m.id', $qb->createNamedParameter($messageId, IQueryBuilder::PARAM_INT)));

		$row = $this->findOneQuery($qb);
		return (int)$row['account_id'];
	}

	public function findAllUids(Mailbox $mailbox): array {
		$query = $this->db->getQueryBuilder();

		$query->select('uid')
			->from($this->getTableName())
			->where($query->expr()->eq('mailbox_id', $query->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT));

		return $this->findUids($query);
	}

	public function countByMailbox(Mailbox $mailbox): int {
		$query = $this->db->getQueryBuilder();

		$query->select($query->func()->count('id'))
			->from($this->getTableName())
			->where($query->expr()->eq('mailbox_id', $query->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT));

		$result = $query->executeQuery();
		$count = (int)$result->fetchOne();
		$result->closeCursor();

		return $count;
	}

	/**
	 * @param IMailSearch::ORDER_* $sortOrder
	 */
	public function findAllIds(Mailbox $mailbox, string $sortOrder, int $limit): array {
		$query = $this->db->getQueryBuilder();
		$direction = $sortOrder === IMailSearch::ORDER_OLDEST_FIRST ? 'ASC' : 'DESC';

		$query->select('id')
			->from($this->getTableName())
			->where($query->expr()->eq('mailbox_id', $query->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT))
			// sent_at alone is not a unique key -- messages arriving in the
			// same second (a mailing-list burst, several recipients on one
			// send) tie on it, and a plain ORDER BY + LIMIT combination is
			// free to return a DIFFERENT subset of the tied rows on each
			// otherwise-identical call. This is the "cold start" path
			// SyncService::getDatabaseSyncChanges() falls back to whenever
			// a bucket's known-ids set is empty -- confirmed live as
			// Priority Inbox sections (Important, Favorites, and the
			// unbounded-display "Other" section alike) visibly cycling
			// between different message sets on every tick, unrelated to
			// any new mail arriving and unrelated to threading. `id` is
			// the one column here that's both unique and, being an
			// auto-increment primary key, already correlates with arrival
			// order -- an ordering the codebase already establishes as the
			// intended tiebreaker (see the thread-root self-join a few
			// lines below findIdsByQuery(), which breaks a sent_at tie the
			// same way).
			->orderBy('sent_at', $direction)
			->addOrderBy('id', $direction)
			->setMaxResults($limit);

		return $this->findIds($query);
	}

	/**
	 * @param Mailbox $mailbox
	 * @param int[] $ids
	 *
	 * @return int[]
	 */
	public function findUidsForIds(Mailbox $mailbox, array $ids) {
		if ($ids === []) {
			// Shortcut for empty sets
			return [];
		}

		$query = $this->db->getQueryBuilder();
		$query->select('uid')
			->from($this->getTableName())
			->where(
				$query->expr()->eq('mailbox_id', $query->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT),
				$query->expr()->in('id', $query->createParameter('ids'), IQueryBuilder::PARAM_INT_ARRAY)
			);

		return array_flat_map(function (array $chunk) use ($query) {
			$query->setParameter('ids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
			return $this->findUids($query);
		}, array_chunk($ids, 1000));
	}

	/**
	 * @param Account $account
	 *
	 * @return DatabaseMessage[]
	 */
	public function findThreadingData(Account $account): array {
		$mailboxesQuery = $this->db->getQueryBuilder();
		$messagesQuery = $this->db->getQueryBuilder();

		$mailboxesQuery->select('id')
			->from('mail_mailboxes')
			->where($mailboxesQuery->expr()->eq('account_id', $messagesQuery->createNamedParameter($account->getId(), IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT));
		$messagesQuery->select('id', 'subject', 'message_id', 'in_reply_to', 'references', 'thread_root_id')
			->from($this->getTableName())
			->where($messagesQuery->expr()->in('mailbox_id', $messagesQuery->createFunction($mailboxesQuery->getSQL()), IQueryBuilder::PARAM_INT_ARRAY))
			->andWhere(
				$messagesQuery->expr()->isNotNull('message_id'),
				$messagesQuery->expr()->orX(
					$messagesQuery->expr()->isNotNull('in_reply_to'),
					$messagesQuery->expr()->neq('references', $messagesQuery->createNamedParameter('[]'))
				),
			);

		$result = $messagesQuery->executeQuery();
		$messages = [];
		while (($row = $result->fetch())) {
			$messages[] = DatabaseMessage::fromRowData(
				(int)$row['id'],
				$row['subject'],
				$row['message_id'],
				$row['references'],
				$row['in_reply_to'],
				$row['thread_root_id']
			);
		}
		$result->closeCursor();

		return $messages;
	}

	/**
	 * @param DatabaseMessage[] $messages
	 *
	 * @todo combine threads and send just one query per thread, like UPDATE ... SET thread_root_id = xxx where UID IN (...)
	 */
	public function writeThreadIds(array $messages): void {
		$this->db->beginTransaction();

		try {
			$query = $this->db->getQueryBuilder();
			$query->update($this->getTableName())
				->set('thread_root_id', $query->createParameter('thread_root_id'))
				->where($query->expr()->eq('id', $query->createParameter('id')));

			foreach ($messages as $message) {
				$query->setParameter(
					'thread_root_id',
					self::filterMessageIdLength($message->getThreadRootId()),
					$message->getThreadRootId() === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_STR
				);
				$query->setParameter('id', $message->getDatabaseId(), IQueryBuilder::PARAM_INT);

				$query->executeStatement();
			}

			$this->db->commit();
		} catch (Throwable $e) {
			// Make sure to always roll back, otherwise the outer code runs in a failed transaction
			$this->db->rollBack();

			throw $e;
		}
	}

	/**
	 * @param Message ...$messages
	 * @return void
	 * @throws Exception
	 */
	public function insertBulk(Account $account, Message ...$messages): void {
		$this->db->beginTransaction();
		try {
			$qb1 = $this->db->getQueryBuilder();
			$qb1->insert($this->getTableName());
			$qb1->setValue('uid', $qb1->createParameter('uid'));
			$qb1->setValue('message_id', $qb1->createParameter('message_id'));
			$qb1->setValue('references', $qb1->createParameter('references'));
			$qb1->setValue('in_reply_to', $qb1->createParameter('in_reply_to'));
			$qb1->setValue('thread_root_id', $qb1->createParameter('thread_root_id'));
			$qb1->setValue('mailbox_id', $qb1->createParameter('mailbox_id'));
			$qb1->setValue('subject', $qb1->createParameter('subject'));
			$qb1->setValue('sent_at', $qb1->createParameter('sent_at'));
			$qb1->setValue('flag_answered', $qb1->createParameter('flag_answered'));
			$qb1->setValue('flag_deleted', $qb1->createParameter('flag_deleted'));
			$qb1->setValue('flag_draft', $qb1->createParameter('flag_draft'));
			$qb1->setValue('flag_flagged', $qb1->createParameter('flag_flagged'));
			$qb1->setValue('flag_seen', $qb1->createParameter('flag_seen'));
			$qb1->setValue('flag_forwarded', $qb1->createParameter('flag_forwarded'));
			$qb1->setValue('flag_junk', $qb1->createParameter('flag_junk'));
			$qb1->setValue('flag_notjunk', $qb1->createParameter('flag_notjunk'));
			$qb1->setValue('flag_important', $qb1->createParameter('flag_important'));
			$qb1->setValue('flag_mdnsent', $qb1->createParameter('flag_mdnsent'));
			$qb2 = $this->db->getQueryBuilder();

			$qb2->insert('mail_recipients')
				->setValue('message_id', $qb2->createParameter('message_id'))
				->setValue('type', $qb2->createParameter('type'))
				->setValue('label', $qb2->createParameter('label'))
				->setValue('email', $qb2->createParameter('email'));

			foreach ($messages as $message) {
				$qb1->setParameter('uid', $message->getUid(), IQueryBuilder::PARAM_INT);
				$qb1->setParameter('message_id', $message->getMessageId(), IQueryBuilder::PARAM_STR);
				$inReplyTo = self::filterMessageIdLength($message->getInReplyTo());
				$qb1->setParameter('in_reply_to', $inReplyTo, $inReplyTo === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_STR);
				$references = $message->getReferences();
				$qb1->setParameter('references', $references, $references === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_STR);
				$threadRootId = self::filterMessageIdLength($message->getThreadRootId());
				$qb1->setParameter('thread_root_id', $threadRootId, $threadRootId === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_STR);
				$qb1->setParameter('mailbox_id', $message->getMailboxId(), IQueryBuilder::PARAM_INT);
				$qb1->setParameter('subject', $message->getSubject(), IQueryBuilder::PARAM_STR);
				$qb1->setParameter('sent_at', $message->getSentAt(), IQueryBuilder::PARAM_INT);
				$qb1->setParameter('flag_answered', $message->getFlagAnswered(), IQueryBuilder::PARAM_BOOL);
				$qb1->setParameter('flag_deleted', $message->getFlagDeleted(), IQueryBuilder::PARAM_BOOL);
				$qb1->setParameter('flag_draft', $message->getFlagDraft(), IQueryBuilder::PARAM_BOOL);
				$qb1->setParameter('flag_flagged', $message->getFlagFlagged(), IQueryBuilder::PARAM_BOOL);
				$qb1->setParameter('flag_seen', $message->getFlagSeen(), IQueryBuilder::PARAM_BOOL);
				$qb1->setParameter('flag_forwarded', $message->getFlagForwarded(), IQueryBuilder::PARAM_BOOL);
				$qb1->setParameter('flag_junk', $message->getFlagJunk(), IQueryBuilder::PARAM_BOOL);
				$qb1->setParameter('flag_notjunk', $message->getFlagNotjunk(), IQueryBuilder::PARAM_BOOL);
				$qb1->setParameter('flag_important', $message->getFlagImportant(), IQueryBuilder::PARAM_BOOL);
				$qb1->setParameter('flag_mdnsent', $message->getFlagMdnsent(), IQueryBuilder::PARAM_BOOL);
				$qb1->executeStatement();

				// Seeded from Gmail's own state on this message's very first
				// sync -- starts the same grace window a later routine
				// resync's own read would (see
				// shouldTrustFlagImportantReading()). The return value is
				// irrelevant here: nothing was written conditionally above,
				// this call is purely for its confirm-the-value side effect.
				$this->shouldTrustFlagImportantReading($message->getMailboxId(), $message->getUid(), $message->getFlagImportant());

				$message->setId($qb1->getLastInsertId());
				$recipientTypes = [
					Address::TYPE_FROM => $message->getFrom(),
					Address::TYPE_TO => $message->getTo(),
					Address::TYPE_CC => $message->getCc(),
					Address::TYPE_BCC => $message->getBcc(),
				];
				foreach ($recipientTypes as $type => $recipients) {
					foreach ($recipients->iterate() as $recipient) {
						if ($recipient->getEmail() === null) {
							// If for some reason the e-mail is not set we should ignore this entry
							continue;
						}

						$qb2->setParameter('message_id', $message->getId(), IQueryBuilder::PARAM_INT);
						$qb2->setParameter('type', $type, IQueryBuilder::PARAM_INT);
						$qb2->setParameter('label', mb_strcut($recipient->getLabel(), 0, 255), IQueryBuilder::PARAM_STR);
						$qb2->setParameter('email', mb_strcut($recipient->getEmail(), 0, 255), IQueryBuilder::PARAM_STR);

						$qb2->executeStatement();
					}
				}
				foreach ($message->getTags() as $tag) {
					$this->tagMapper->tagMessage($tag, $message->getMessageId(), $account->getUserId());
				}
			}

			$this->db->commit();
		} catch (Throwable $e) {
			// Make sure to always roll back, otherwise the outer code runs in a failed transaction
			$this->db->rollBack();

			throw $e;
		}
	}

	private static function flagImportantConfirmationKey(int $mailboxId, int $uid): string {
		return "confirmed_important_{$mailboxId}_{$uid}";
	}

	/**
	 * Whether a fresh IMAP-derived flag_important reading should be
	 * trusted and written, symmetric for both directions -- there is no
	 * "upgrade" or "downgrade" special case here, deliberately: the exact
	 * same race threatens a message going true -> false (this app's own
	 * classifier decided important, IMAP hasn't settled that write yet)
	 * as one going false -> true (the user manually removed importance
	 * via markEnvelopeImportantOrUnimportant(), a stale/concurrent read
	 * still has Gmail's pre-removal state). Treating only one direction
	 * as trustworthy-by-default would leave the other silently
	 * unprotected -- exactly the asymmetry an earlier version of this
	 * fix had, caught on review.
	 *
	 * Stores {value, confirmedAt} in a small distributed cache (the same
	 * ICacheFactory pattern used throughout this app) and compares the
	 * timestamp against the injected, mockable ITimeFactory -- not the
	 * cache backend's own physical TTL, which uses real wall-clock time
	 * no test can fast-forward. No prior confirmation, or one that
	 * already agrees with the fresh reading: trust it, and (re)confirm.
	 * One that disagrees: trust it only once FLAG_IMPORTANT_GRACE_SECONDS
	 * has passed since it was last confirmed -- recent enough to still
	 * plausibly be a write that hasn't settled yet (distrust the fresh
	 * reading, protect the confirmed value), or old enough that the
	 * contradiction is itself the real, current state.
	 *
	 * No distributed memcache available reads as "trust every fresh
	 * reading, unconditionally" -- same fail-open philosophy as
	 * isServerBusy()'s own memcache-unavailable fallback elsewhere in
	 * this app: better to risk the rare stale-read flap than to block
	 * every legitimate change.
	 *
	 * @return bool whether $freshValue should be written
	 */
	private function shouldTrustFlagImportantReading(int $mailboxId, int $uid, bool $freshValue): bool {
		$cache = $this->cacheFactory->createDistributed('mail_flag_important');
		if (!($cache instanceof IMemcache)) {
			return true;
		}

		$key = self::flagImportantConfirmationKey($mailboxId, $uid);
		$confirmation = $cache->get($key);
		$agreesWithLastConfirmation = is_array($confirmation)
			&& array_key_exists('value', $confirmation)
			&& $confirmation['value'] === $freshValue;
		$stillWithinGraceWindow = is_array($confirmation)
			&& array_key_exists('confirmedAt', $confirmation)
			&& $this->timeFactory->getTime() < ((int)$confirmation['confirmedAt'] + self::FLAG_IMPORTANT_GRACE_SECONDS);

		if ($confirmation !== null && !$agreesWithLastConfirmation && $stillWithinGraceWindow) {
			return false;
		}

		$cache->set(
			$key,
			['value' => $freshValue, 'confirmedAt' => $this->timeFactory->getTime()],
			self::FLAG_IMPORTANT_GRACE_SECONDS * 2,
		);
		return true;
	}

	/**
	 * @throws Exception
	 */
	private static function filterMessageIdLength(?string $messageId): ?string {
		if ($messageId === null) {
			return null;
		}
		if (strlen($messageId) > 1023) {
			throw new Exception("IMAP message ID $messageId is too long for the database");
		}

		return $messageId;
	}

	/**
	 * Memoized per uid within one updateBulk() call: whichever caller
	 * (the flag write below, or updateTags() for the important tag) asks
	 * first computes it via shouldTrustFlagImportantReading(), and every
	 * later caller for the SAME message this same call reuses that exact
	 * answer instead of asking again -- see updateBulk()'s own
	 * $trustedImportant comment for why sharing the computed value,
	 * rather than sharing only the check, is what actually matters here.
	 */
	private function trustedImportantReading(array &$trustedImportant, Message $message): bool {
		$uid = $message->getUid();
		if (!array_key_exists($uid, $trustedImportant)) {
			$trustedImportant[$uid] = $this->shouldTrustFlagImportantReading(
				$message->getMailboxId(),
				$uid,
				$message->getFlagImportant(),
			);
		}
		return $trustedImportant[$uid];
	}

	/**
	 * @param Account $account
	 * @param bool $permflagsEnabled
	 * @param Message[] $messages
	 * @return Message[]
	 */
	public function updateBulk(Account $account, bool $permflagsEnabled, Message ...$messages): array {
		$this->db->beginTransaction();

		$perf = $this->performanceLogger->start(
			"partial sync {$account->getId()}:{$account->getName()}"
		);

		// MailboxId is the same for all messages according to updateBulk() call
		$mailboxId = $messages[0]->getMailboxId();

		$flags = [
			'flag_answered',
			'flag_deleted',
			'flag_draft',
			'flag_flagged',
			'flag_seen',
			'flag_forwarded',
			'flag_junk',
			'flag_notjunk',
			'flag_mdnsent',
			'flag_important',
		];

		$updateData = [];
		foreach ($flags as $flag) {
			$updateData[$flag . '_true'] = [];
			$updateData[$flag . '_false'] = [];
		}

		// Whether THIS message's fresh flag_important reading should be
		// trusted, keyed by uid -- computed at most once per message
		// across this whole updateBulk() call (see
		// trustedImportantReading() below) and consulted by BOTH the flag
		// write below and updateTags() further down, instead of each
		// independently asking shouldTrustFlagImportantReading() the same
		// question. flag_important and the important TAG are historically
		// the same fact stored twice (see updateTags()'s own comment) --
		// sharing one computed decision, rather than two call sites that
		// merely happen to agree, is what makes them structurally
		// incapable of disagreeing, not just incidentally consistent.
		$trustedImportant = [];

		foreach ($messages as $message) {
			if (empty($message->getUpdatedFields()) === false) {
				if ($message->getFlagAnswered()) {
					$updateData['flag_answered_true'][] = $message->getUid();
				} else {
					$updateData['flag_answered_false'][] = $message->getUid();
				}

				if ($message->getFlagDeleted()) {
					$updateData['flag_deleted_true'][] = $message->getUid();
				} else {
					$updateData['flag_deleted_false'][] = $message->getUid();
				}

				if ($message->getFlagDraft()) {
					$updateData['flag_draft_true'][] = $message->getUid();
				} else {
					$updateData['flag_draft_false'][] = $message->getUid();
				}

				if ($message->getFlagFlagged()) {
					$updateData['flag_flagged_true'][] = $message->getUid();
				} else {
					$updateData['flag_flagged_false'][] = $message->getUid();
				}

				if ($message->getFlagSeen()) {
					$updateData['flag_seen_true'][] = $message->getUid();
				} else {
					$updateData['flag_seen_false'][] = $message->getUid();
				}

				if ($message->getFlagForwarded()) {
					$updateData['flag_forwarded_true'][] = $message->getUid();
				} else {
					$updateData['flag_forwarded_false'][] = $message->getUid();
				}

				if ($message->getFlagJunk()) {
					$updateData['flag_junk_true'][] = $message->getUid();
				} else {
					$updateData['flag_junk_false'][] = $message->getUid();
				}

				if ($message->getFlagNotjunk()) {
					$updateData['flag_notjunk_true'][] = $message->getUid();
				} else {
					$updateData['flag_notjunk_false'][] = $message->getUid();
				}

				if ($message->getFlagMdnsent()) {
					$updateData['flag_mdnsent_true'][] = $message->getUid();
				} else {
					$updateData['flag_mdnsent_false'][] = $message->getUid();
				}

				// Not treated like every other flag in this loop: flag_important
				// represents THIS APP's own importance classification (see
				// ImportanceClassifier.php), not a genuine externally-synced
				// IMAP flag with shared, multi-client meaning the way
				// \Seen/\Flagged/\Answered are. toDbMessage() recomputes it
				// fresh from whatever Gmail's own IMAP keyword state happens
				// to say on THIS fetch -- if a recent local change (this
				// app's own classifier deciding true, or the user's own
				// markEnvelopeImportantOrUnimportant() deciding false) hasn't
				// fully settled on IMAP's side yet (or Gmail's own backend
				// has a moment of eventual-consistency lag for it, plausible
				// given the slow/unreliable IMAP conditions documented
				// elsewhere in this account's history), a routine resync
				// landing in that window would otherwise silently revert it
				// -- confirmed live as the Priority Inbox's "Important"
				// section visibly losing and re-gaining messages with no
				// user action involved. Symmetric in both directions,
				// deliberately: the same race threatens a change either way,
				// so there is no special-cased "upgrade" vs "downgrade"
				// branch here, just the one check. See
				// shouldTrustFlagImportantReading() for the actual logic.
				if ($this->trustedImportantReading($trustedImportant, $message)) {
					if ($message->getFlagImportant()) {
						$updateData['flag_important_true'][] = $message->getUid();
					} else {
						$updateData['flag_important_false'][] = $message->getUid();
					}
				}
			}
		}

		try {
			// UPDATE messages SET flag true/false WHERE uid in (uids) -> for each flag
			// => total of 20 queries
			foreach ($flags as $flag) {
				$queryTrue = $this->db->getQueryBuilder();
				$queryTrue->update($this->getTableName())
					->set($flag, $queryTrue->createNamedParameter(1, IQueryBuilder::PARAM_INT))
					->set('updated_at', $queryTrue->createNamedParameter($this->timeFactory->getTime(), IQueryBuilder::PARAM_INT))
					->where($queryTrue->expr()->andX(
						$queryTrue->expr()->in('uid', $queryTrue->createParameter('uids')),
						$queryTrue->expr()->eq('mailbox_id', $queryTrue->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT)),
						$queryTrue->expr()->eq($flag, $queryTrue->createNamedParameter(0, IQueryBuilder::PARAM_INT))
					));
				foreach (array_chunk($updateData[$flag . '_true'], 1000) as $chunk) {
					$queryTrue->setParameter('uids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
					$queryTrue->executeStatement();
				}

				$queryFalse = $this->db->getQueryBuilder();
				$queryFalse->update($this->getTableName())
					->set($flag, $queryFalse->createNamedParameter(0, IQueryBuilder::PARAM_INT))
					->set('updated_at', $queryFalse->createNamedParameter($this->timeFactory->getTime(), IQueryBuilder::PARAM_INT))
					->where($queryFalse->expr()->andX(
						$queryFalse->expr()->in('uid', $queryFalse->createParameter('uids')),
						$queryFalse->expr()->eq('mailbox_id', $queryFalse->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT)),
						$queryFalse->expr()->eq($flag, $queryFalse->createNamedParameter(1, IQueryBuilder::PARAM_INT))
					));
				foreach (array_chunk($updateData[$flag . '_false'], 1000) as $chunk) {
					$queryFalse->setParameter('uids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
					$queryFalse->executeStatement();
				}

				$perf->step('Set ' . $flag . ' in messages.');
			}

			// get all tags before the loop and create a mapping [message_id => [tag,...]] but only if permflags are enabled
			$tags = [];
			if ($permflagsEnabled) {
				$tags = $this->tagMapper->getAllTagsForMessages($messages, $account->getUserId());
				$perf->step('Selected Tags for all messages');
			}

			foreach ($messages as $message) {
				// check permflags and only go through the tagging logic if they're enabled
				if ($permflagsEnabled) {
					$this->updateTags($account, $message, $tags, $perf, $trustedImportant);
				}
			}

			$this->db->commit();
		} catch (Throwable $e) {
			// Make sure to always roll back, otherwise the outer code runs in a failed transaction
			$this->db->rollBack();

			throw $e;
		}

		$perf->end();

		return $messages;
	}

	private static function tagListIncludesImportant(array $tags): bool {
		foreach ($tags as $tag) {
			if ($tag->getImapLabel() === Tag::LABEL_IMPORTANT) {
				return true;
			}
		}
		return false;
	}

	/**
	 * @param Account $account
	 * @param Message $message
	 * @param Tag[][] $tags
	 * @param PerformanceLoggerTask $perf
	 * @param bool[] $trustedImportant per-uid memoized shouldTrustFlagImportantReading()
	 *                                 decisions shared with updateBulk()'s own flag write --
	 *                                 see trustedImportantReading().
	 */
	private function updateTags(Account $account, Message $message, array $tags, PerformanceLoggerTask $perf, array &$trustedImportant): void {
		$imapTags = $message->getTags();
		$messageId = $message->getMessageId();
		$dbTags = $messageId !== null ? ($tags[$messageId] ?? []) : [];

		if ($imapTags === [] && $dbTags === []) {
			// neither old nor new tags
			return;
		}

		// The important tag ($label1) is flag_important's own value, in
		// tag form -- historically the same concept stored twice (see
		// MigrateImportantFromImapAndDb.php). Both are derived from the
		// exact same IMAP fetch in toDbMessage(), yet only flag_important
		// was ever protected from the race a fresh-but-not-yet-settled IMAP
		// read causes (see shouldTrustFlagImportantReading() and its own
		// comment above): a message the classifier (or the user, via
		// markEnvelopeImportantOrUnimportant()) had just tagged important
		// would get silently UNTAGGED by the very next flags-resync pass,
		// since Gmail's own backend hadn't yet made the keyword visible on
		// that fresh fetch -- confirmed live as the important badge
		// (Envelope.vue's isImportant(), which reads this tag, not
		// flag_important) disappearing right after appearing, only
		// returning once a later poll caught up. Reading the SAME per-uid
		// decision updateBulk()'s own flag write already computed (see
		// trustedImportantReading()), rather than each independently
		// asking shouldTrustFlagImportantReading() the same question, is
		// what makes the flag and its tag twin structurally incapable of
		// disagreeing -- not just incidentally consistent because two
		// separate calls happen to agree. Only looked up when the
		// important tag is actually in play at all, to skip the
		// (memoized, but still a lookup) cost for the common case of a
		// message with no importance history whatsoever.
		$trustImportantReading = true;
		if (self::tagListIncludesImportant($imapTags) || self::tagListIncludesImportant($dbTags)) {
			$trustImportantReading = $this->trustedImportantReading($trustedImportant, $message);
		}

		$toAdd = array_udiff($imapTags, $dbTags, static fn (Tag $a, Tag $b) => strcmp($a->getImapLabel(), $b->getImapLabel()));
		foreach ($toAdd as $tag) {
			if ($tag->getImapLabel() === Tag::LABEL_IMPORTANT && !$trustImportantReading) {
				continue;
			}
			$this->tagMapper->tagMessage($tag, $message->getMessageId(), $account->getUserId());
		}
		$perf->step('Tagged messages');

		if ($dbTags === []) {
			// we have nothing to possibly remove
			return;
		}

		$toRemove = array_udiff($dbTags, $imapTags, static fn (Tag $a, Tag $b) => strcmp($a->getImapLabel(), $b->getImapLabel()));
		foreach ($toRemove as $tag) {
			if ($tag->getImapLabel() === Tag::LABEL_IMPORTANT && !$trustImportantReading) {
				continue;
			}
			$this->tagMapper->untagMessage($tag, $message->getMessageId());
		}
		$perf->step('Untagged messages');
	}

	/**
	 * @param Message ...$messages
	 *
	 * @return Message[]
	 */
	public function updatePreviewDataBulk(Message ...$messages): array {
		$this->db->beginTransaction();

		try {
			$query = $this->db->getQueryBuilder();
			$query->update($this->getTableName())
				->set('flag_attachments', $query->createParameter('flag_attachments'))
				->set('preview_text', $query->createParameter('preview_text'))
				->set('structure_analyzed', $query->createNamedParameter(true, IQueryBuilder::PARAM_BOOL))
				->set('updated_at', $query->createNamedParameter($this->timeFactory->getTime(), IQueryBuilder::PARAM_INT))
				->set('imip_message', $query->createParameter('imip_message'))
				->set('encrypted', $query->createParameter('encrypted'))
				->set('mentions_me', $query->createParameter('mentions_me'))
				->where($query->expr()->andX(
					$query->expr()->eq('uid', $query->createParameter('uid')),
					$query->expr()->eq('mailbox_id', $query->createParameter('mailbox_id'))
				));

			foreach ($messages as $message) {
				if (empty($message->getUpdatedFields())) {
					// Micro optimization
					continue;
				}

				$query->setParameter('uid', $message->getUid(), IQueryBuilder::PARAM_INT);
				$query->setParameter('mailbox_id', $message->getMailboxId(), IQueryBuilder::PARAM_INT);
				$query->setParameter('flag_attachments', $message->getFlagAttachments(), $message->getFlagAttachments() === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_BOOL);
				$previewText = null;
				if ($message->getPreviewText() !== null) {
					$convertedText = mb_convert_encoding($message->getPreviewText(), 'UTF-8', 'UTF-8');
					//converting the spaces is necessary for ltrim to work
					$previewText = mb_strcut(ltrim(preg_replace('/\s/u', ' ', $convertedText)), 0, 255);

					// Make sure modifications are visible when these objects are used right away
					$message->setPreviewText($previewText);
				}
				$query->setParameter(
					'preview_text',
					$previewText,
					$previewText === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_STR
				);
				$query->setParameter('imip_message', $message->isImipMessage(), IQueryBuilder::PARAM_BOOL);
				$query->setParameter('encrypted', $message->isEncrypted(), IQueryBuilder::PARAM_BOOL);
				$query->setParameter('mentions_me', $message->getMentionsMe(), IQueryBuilder::PARAM_BOOL);

				$query->executeStatement();
			}

			$this->db->commit();
		} catch (Throwable $e) {
			// Make sure to always roll back, otherwise the outer code runs in a failed transaction
			$this->db->rollBack();

			throw $e;
		}

		return $messages;
	}

	/**
	 * @param Message ...$messages
	 *
	 * @return Message[]
	 */
	public function updateImipData(Message ...$messages): array {
		$this->db->beginTransaction();

		try {
			$query = $this->db->getQueryBuilder();
			$query->update($this->getTableName())
				->set('imip_message', $query->createParameter('imip_message'))
				->set('imip_error', $query->createParameter('imip_error'))
				->set('imip_processed', $query->createParameter('imip_processed'))
				->where($query->expr()->andX(
					$query->expr()->eq('uid', $query->createParameter('uid')),
					$query->expr()->eq('mailbox_id', $query->createParameter('mailbox_id'))
				));

			foreach ($messages as $message) {
				if (empty($message->getUpdatedFields())) {
					// Micro optimization
					continue;
				}

				$query->setParameter('uid', $message->getUid(), IQueryBuilder::PARAM_INT);
				$query->setParameter('mailbox_id', $message->getMailboxId(), IQueryBuilder::PARAM_INT);
				$query->setParameter('imip_message', $message->isImipMessage(), IQueryBuilder::PARAM_BOOL);
				$query->setParameter('imip_error', $message->isImipError(), IQueryBuilder::PARAM_BOOL);
				$query->setParameter('imip_processed', $message->isImipProcessed(), IQueryBuilder::PARAM_BOOL);
				$query->executeStatement();
			}

			$this->db->commit();
		} catch (Throwable $e) {
			// Make sure to always roll back, otherwise the outer code runs in a failed transaction
			$this->db->rollBack();

			throw $e;
		}

		return $messages;
	}

	public function resetPreviewDataFlag(): void {
		$qb = $this->db->getQueryBuilder();
		$update = $qb->update($this->getTableName())
			->set('structure_analyzed', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL));
		$update->executeStatement();
	}

	public function deleteAll(Mailbox $mailbox): void {
		$messageIdQuery = $this->db->getQueryBuilder();
		$messageIdQuery->select('id')
			->from($this->getTableName())
			->where($messageIdQuery->expr()->eq('mailbox_id', $messageIdQuery->createNamedParameter($mailbox->getId())));

		$cursor = $messageIdQuery->executeQuery();
		$messageIds = $cursor->fetchAll();
		$cursor->closeCursor();

		$messageIds = array_map(static fn (array $row) => (int)$row['id'], $messageIds);

		$deleteRecipientsQuery = $this->db->getQueryBuilder();
		$deleteRecipientsQuery->delete('mail_recipients')
			->where($deleteRecipientsQuery->expr()->in('message_id', $deleteRecipientsQuery->createParameter('ids')));

		foreach (array_chunk($messageIds, 1000) as $chunk) {
			// delete all related recipient entries
			$deleteRecipientsQuery->setParameter('ids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
			$deleteRecipientsQuery->executeStatement();
		}

		$query = $this->db->getQueryBuilder();

		$query->delete($this->getTableName())
			->where($query->expr()->eq('mailbox_id', $query->createNamedParameter($mailbox->getId())));

		$query->executeStatement();
	}

	public function deleteByUid(Mailbox $mailbox, int ...$uids): void {
		$selectMessageIdsQuery = $this->db->getQueryBuilder();
		$deleteRecipientsQuery = $this->db->getQueryBuilder();
		$deleteMessagesQuery = $this->db->getQueryBuilder();

		$selectMessageIdsQuery->select('id')
			->from($this->getTableName())
			->where(
				$selectMessageIdsQuery->expr()->eq('mailbox_id', $selectMessageIdsQuery->createNamedParameter($mailbox->getId())),
				$selectMessageIdsQuery->expr()->in('uid', $deleteMessagesQuery->createParameter('uids')),
			);
		$deleteRecipientsQuery->delete('mail_recipients')
			->where(
				$deleteRecipientsQuery->expr()->in('message_id', $deleteRecipientsQuery->createParameter('ids')),
			);
		$deleteMessagesQuery->delete('mail_messages')
			->where(
				$deleteMessagesQuery->expr()->in('id', $deleteMessagesQuery->createParameter('ids')),
			);

		foreach (array_chunk($uids, 1000) as $chunk) {
			$this->atomic(function () use ($selectMessageIdsQuery, $deleteRecipientsQuery, $deleteMessagesQuery, $chunk) {
				$selectMessageIdsQuery->setParameter('uids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
				$selectResult = $selectMessageIdsQuery->executeQuery();
				$ids = array_map('intval', $selectResult->fetchAll(\PDO::FETCH_COLUMN));
				$selectResult->closeCursor();
				if (empty($ids)) {
					// Avoid useless queries
					return;
				}

				// delete all related recipient entries
				$deleteRecipientsQuery->setParameter('ids', $ids, IQueryBuilder::PARAM_INT_ARRAY);
				$deleteRecipientsQuery->executeStatement();

				// delete all messages
				$deleteMessagesQuery->setParameter('ids', $ids, IQueryBuilder::PARAM_INT_ARRAY);
				$deleteMessagesQuery->executeStatement();
			}, $this->db);
		}
	}

	/**
	 * @param Account $account
	 * @param string $threadRootId
	 *
	 * @return Message[]
	 */
	/**
	 * Message-IDs of an account's flag_important messages that have no
	 * matching row in mail_message_tags for the given tag -- the exact
	 * signature left behind when the classifier's flagMessage() succeeded
	 * but its tagMessage() failed (see NewMessagesClassifier), or by any
	 * client writing only the importance keyword. Consumed by
	 * ReconcileImportanceTagJob's bounded nightly backfill.
	 *
	 * Deliberately cheap: flag_important=true is a small fraction of any
	 * mailbox, the probe per row is a NOT EXISTS on the (indexed) tag
	 * mapping, there is no ORDER BY, and the LIMIT lets the planner stop
	 * at the first $limit hits. No IMAP involved at any point.
	 *
	 * @return string[]
	 */
	public function findImportantMessageIdsWithoutTag(int $accountId, int $tagId, int $limit): array {
		$qb = $this->db->getQueryBuilder();
		$tagProbe = $this->db->getQueryBuilder();
		$tagProbe->select($tagProbe->expr()->literal(1))
			->from('mail_message_tags', 'mt')
			->where(
				$tagProbe->expr()->eq('mt.imap_message_id', 'm.message_id', IQueryBuilder::PARAM_STR),
				// Parameter created on the OUTER builder: the inner SQL is
				// embedded as literal text, so its own placeholder counter
				// would collide with the outer one (same reason as the
				// thread-match subquery in findIdsByQuery()).
				$tagProbe->expr()->eq('mt.tag_id', $qb->createNamedParameter($tagId, IQueryBuilder::PARAM_INT)),
			);

		$qb->selectDistinct('m.message_id')
			->from($this->getTableName(), 'm')
			->join('m', 'mail_mailboxes', 'mb', $qb->expr()->eq('m.mailbox_id', 'mb.id', IQueryBuilder::PARAM_INT))
			->where(
				$qb->expr()->eq('mb.account_id', $qb->createNamedParameter($accountId, IQueryBuilder::PARAM_INT)),
				$qb->expr()->eq('m.flag_important', $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL)),
				$qb->expr()->isNotNull('m.message_id'),
				$qb->createFunction('NOT EXISTS (' . $tagProbe->getSQL() . ')'),
			)
			->setMaxResults($limit);

		$result = $qb->executeQuery();
		$ids = array_map(static fn (array $row) => $row['message_id'], $result->fetchAll());
		$result->closeCursor();
		return $ids;
	}

	public function findThread(Account $account, string $threadRootId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('messages.*')
			->from($this->getTableName(), 'messages')
			->join('messages', 'mail_mailboxes', 'mailboxes', $qb->expr()->eq('messages.mailbox_id', 'mailboxes.id', IQueryBuilder::PARAM_INT))
			->where(
				$qb->expr()->eq('mailboxes.account_id', $qb->createNamedParameter($account->getId(), IQueryBuilder::PARAM_INT)),
				$qb->expr()->eq('messages.thread_root_id', $qb->createNamedParameter($threadRootId, IQueryBuilder::PARAM_STR), IQueryBuilder::PARAM_STR)
			)
			->orderBy('messages.sent_at', 'desc');

		return $this->findRelatedData($this->findEntities($qb), $account->getUserId());
	}

	/**
	 * @param Account $account
	 * @param string $messageId
	 *
	 * @return Message[]
	 */
	public function findByMessageId(Account $account, string $messageId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('messages.*')
			->from($this->getTableName(), 'messages')
			->join('messages', 'mail_mailboxes', 'mailboxes', $qb->expr()->eq('messages.mailbox_id', 'mailboxes.id', IQueryBuilder::PARAM_INT))
			->where(
				$qb->expr()->eq('mailboxes.account_id', $qb->createNamedParameter($account->getId(), IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT),
				$qb->expr()->eq('messages.message_id', $qb->createNamedParameter($messageId, IQueryBuilder::PARAM_STR), IQueryBuilder::PARAM_STR)
			);

		return $this->findEntities($qb);
	}

	/**
	 * @param Mailbox $mailbox
	 * @param SearchQuery $query
	 * @param int|null $limit
	 * @param int[]|null $uids
	 *
	 * @return int[]
	 */
	/**
	 * @param int[]|null $uids Two distinct meanings, selected by
	 *                         $uidsRestrict:
	 *                          - false (default, the search path): UIDs
	 *                            that matched an IMAP body search; they
	 *                            are OR-ed with the subject condition so
	 *                            body hits and subject hits combine.
	 *                          - true (the sync-diff path): candidate
	 *                            UIDs the result must be RESTRICTED to,
	 *                            always AND-ed. Without this flag a sync
	 *                            of a search bucket whose query had a
	 *                            subject term put its candidate UIDs
	 *                            into the OR -- every new message
	 *                            "matched" the filter, and ordinary mail
	 *                            flooded the active search's results on
	 *                            the next background tick (confirmed
	 *                            live).
	 */
	public function findIdsByQuery(Mailbox $mailbox, SearchQuery $query, string $sortOrder, ?int $limit, ?array $uids = null, bool $uidsRestrict = false): array {
		$qb = $this->db->getQueryBuilder();

		// No DISTINCT needed: recipient matches are EXISTS probes (see
		// recipientTermsMatchExists()), so the row set never contains
		// more than one row per message in the first place.
		$select = $qb->select(['m.id', 'm.sent_at']);

		$select->from($this->getTableName(), 'm');

		if ($query->getThreaded()) {
			$selfJoin = $select->expr()->andX(
				$select->expr()->eq('m.mailbox_id', 'm2.mailbox_id', IQueryBuilder::PARAM_INT),
				$select->expr()->eq('m.thread_root_id', 'm2.thread_root_id', IQueryBuilder::PARAM_INT),
				$select->expr()->orX(
					$select->expr()->lt('m.sent_at', 'm2.sent_at', IQueryBuilder::PARAM_INT),
					$select->expr()->andX(
						$select->expr()->eq('m.sent_at', 'm2.sent_at', IQueryBuilder::PARAM_INT),
						$select->expr()->lt('m.message_id', 'm2.message_id', IQueryBuilder::PARAM_STR),
					),
				),
			);
			$select->leftJoin('m', $this->getTableName(), 'm2', $selfJoin);
		}

		$select->where(
			$qb->expr()->eq('m.mailbox_id', $qb->createNamedParameter($mailbox->getId()), IQueryBuilder::PARAM_INT)
		);

		if (!empty($query->getTags())) {
			$select->innerJoin('m', 'mail_message_tags', 'tags', 'm.message_id = tags.imap_message_id');
			$select->andWhere(
				$qb->expr()->in('tags.tag_id', $qb->createNamedParameter($query->getTags(), IQueryBuilder::PARAM_STR_ARRAY))
			);
		}

		$textOrs = [];

		if (!empty($query->getFrom())) {
			$fromMatch = $this->recipientTermsMatchExists($qb, Recipient::TYPE_FROM, $query->getFrom());
			if ($query->getMatch() === 'anyof') {
				$textOrs[] = $fromMatch;
			} else {
				$select->andWhere($fromMatch);
			}
		}
		if (!empty($query->getTo())) {
			$toMatch = $this->recipientTermsMatchExists($qb, Recipient::TYPE_TO, $query->getTo());
			if ($query->getMatch() === 'anyof') {
				$textOrs[] = $toMatch;
			} else {
				$select->andWhere($toMatch);
			}
		}
		if (!empty($query->getCc())) {
			$select->andWhere($this->recipientTermsMatchExists($qb, Recipient::TYPE_CC, $query->getCc()));
		}
		if (!empty($query->getBcc())) {
			$select->andWhere($this->recipientTermsMatchExists($qb, Recipient::TYPE_BCC, $query->getBcc()));
		}

		if (!empty($query->getSubjects())) {
			$textOrs[] = $qb->expr()->orX(
				...array_map(fn (string $subject) => $qb->expr()->iLike(
					'm.subject',
					$qb->createNamedParameter('%' . $this->db->escapeLikeParameter($subject) . '%', IQueryBuilder::PARAM_STR),
					IQueryBuilder::PARAM_STR
				), $query->getSubjects())
			);
		}
		// createParameter
		if ($uids !== null) {
			// In the case of body+subject search we need a combination of both results,
			// thus the orWhere in every other case andWhere should do the job.
			// Restriction UIDs (the sync-diff path) always AND -- see the
			// $uidsRestrict doc block above.
			if (!$uidsRestrict && !empty($query->getSubjects())) {
				$textOrs[] = $qb->expr()->in('m.uid', $qb->createParameter('uids'));
			} else {
				$select->andWhere(
					$qb->expr()->in('m.uid', $qb->createParameter('uids'))
				);
			}
		}
		if (!empty($textOrs)) {
			$select->andWhere($qb->expr()->orX(...$textOrs));
		}

		if (!empty($query->getStart())) {
			$select->andWhere(
				$qb->expr()->gte('m.sent_at', $qb->createNamedParameter($query->getStart()), IQueryBuilder::PARAM_INT)
			);
		}

		if (!empty($query->getEnd())) {
			$select->andWhere(
				$qb->expr()->lte('m.sent_at', $qb->createNamedParameter($query->getEnd()), IQueryBuilder::PARAM_INT)
			);
		}

		if ($query->getHasAttachments()) {
			$select->andWhere(
				$qb->expr()->eq('m.flag_attachments', $qb->createNamedParameter($query->getHasAttachments(), IQueryBuilder::PARAM_INT))
			);
		}

		if ($query->getMentionsMe()) {
			$select->andWhere(
				$qb->expr()->eq('m.mentions_me', $qb->createNamedParameter($query->getMentionsMe(), IQueryBuilder::PARAM_BOOL))
			);
		}

		if ($query->getCursor() !== null && $sortOrder === IMailSearch::ORDER_NEWEST_FIRST) {
			$select->andWhere(
				$qb->expr()->lt('m.sent_at', $qb->createNamedParameter($query->getCursor(), IQueryBuilder::PARAM_INT))
			);
		} elseif ($query->getCursor() !== null && $sortOrder === IMailSearch::ORDER_OLDEST_FIRST) {
			$select->andWhere(
				$qb->expr()->gt('m.sent_at', $qb->createNamedParameter($query->getCursor(), IQueryBuilder::PARAM_INT))
			);
		}

		if ($query->getThreaded() && (!empty($query->getFlags()) || !empty($query->getFlagExpressions()) || !empty($query->getThreadExcludedFlags()))) {
			// In threaded view, `m` (see the self-join above) is only a
			// stand-in for its whole thread -- the thread's newest message,
			// not a message to judge on its own. A flag filter (unread,
			// starred, important, ...) must therefore match if ANY message
			// in the thread has it, not only the newest one -- otherwise a
			// thread whose newest reply has already been read is invisible
			// to the "unread" filter even though it genuinely contains an
			// unread message (confirmed live).
			// Named parameters must be created on the OUTER query builder
			// ($qb), not the inner one -- both generate placeholder names
			// from their own independent counters (e.g. :dcValue1), so a
			// value bound on the inner builder collides with whatever the
			// outer builder's own placeholder of the same name is bound to
			// once the inner SQL is embedded as literal text below. This is
			// the same reason findIdsGloballyByQuery()'s sub-select above
			// creates its parameters via the outer $qb too.
			$newThreadMatchQb = function () {
				$threadMatchQb = $this->db->getQueryBuilder();
				$threadMatch = $threadMatchQb->select($threadMatchQb->expr()->literal(1))
					->from($this->getTableName(), 'tm')
					->where(
						$threadMatchQb->expr()->eq('tm.mailbox_id', 'm.mailbox_id', IQueryBuilder::PARAM_INT),
						$threadMatchQb->expr()->orX(
							// A message with no thread_root_id isn't grouped
							// with anything (NULL never equals NULL below), so
							// it must still match itself.
							$threadMatchQb->expr()->eq('tm.id', 'm.id', IQueryBuilder::PARAM_INT),
							$threadMatchQb->expr()->eq('tm.thread_root_id', 'm.thread_root_id', IQueryBuilder::PARAM_STR),
						),
					);
				return [$threadMatchQb, $threadMatch];
			};
			if (!empty($query->getFlags()) || !empty($query->getFlagExpressions())) {
				[$threadMatchQb, $threadMatch] = $newThreadMatchQb();
				foreach ($query->getFlags() as $flag) {
					$threadMatch->andWhere($threadMatchQb->expr()->eq('tm.' . $this->flagToColumnName($flag), $qb->createNamedParameter($flag->isSet(), IQueryBuilder::PARAM_BOOL)));
				}
				foreach ($query->getFlagExpressions() as $expr) {
					$threadMatch->andWhere($this->flagExpressionToQuery($expr, $qb, 'tm'));
				}
				$select->andWhere($qb->createFunction('EXISTS (' . $threadMatch->getSQL() . ')'));
			}
			// Partition semantics (see SearchQuery::getThreadExcludedFlags()):
			// the thread matches only if NO member carries the positive
			// flag -- NOT EXISTS, the exact complement of the EXISTS above,
			// so "Other" (no important member) and "Important" (some
			// important member) partition mixed threads instead of both
			// listing them. One subquery per excluded flag: multiple
			// exclusions AND together ("no starred member AND no important
			// member"), which a single combined subquery would not express.
			foreach ($query->getThreadExcludedFlags() as $flag) {
				[$threadMatchQb, $threadMatch] = $newThreadMatchQb();
				$threadMatch->andWhere($threadMatchQb->expr()->eq('tm.' . $this->flagToColumnName($flag), $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL)));
				$select->andWhere($qb->createFunction('NOT EXISTS (' . $threadMatch->getSQL() . ')'));
			}
		} else {
			foreach ($query->getFlags() as $flag) {
				$select->andWhere($qb->expr()->eq('m.' . $this->flagToColumnName($flag), $qb->createNamedParameter($flag->isSet(), IQueryBuilder::PARAM_BOOL)));
			}
			// In flat/singleton view one row IS one message: a thread-
			// excluded flag degrades to a plain negated per-message check,
			// exactly what these tokens produced before partition
			// semantics existed.
			foreach ($query->getThreadExcludedFlags() as $flag) {
				$select->andWhere($qb->expr()->eq('m.' . $this->flagToColumnName($flag), $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL)));
			}
			if (!empty($query->getFlagExpressions())) {
				$select->andWhere(
					...array_map(fn (FlagExpression $expr) => $this->flagExpressionToQuery($expr, $select, 'm'), $query->getFlagExpressions())
				);
			}
		}

		if ($query->getThreaded()) {
			$select->andWhere($qb->expr()->isNull('m2.id'));
		}

		// See findAllIds()'s own comment: sent_at alone ties whenever
		// several messages land in the same second, and combined with
		// the LIMIT below that makes the specific subset returned
		// non-deterministic across otherwise-identical calls. `m.id` is
		// unique and already correlates with arrival order.
		if ($sortOrder === 'ASC') {
			$select->orderBy('m.sent_at', $sortOrder);
			$select->addOrderBy('m.id', $sortOrder);
		} else {
			$select->orderBy('m.sent_at', 'DESC');
			$select->addOrderBy('m.id', 'DESC');
		}

		if ($limit !== null) {
			$select->setMaxResults($limit);
		}

		return $this->executeWithSearchTimeout(function () use ($qb, $select, $uids) {
			if ($uids !== null) {
				return array_flat_map(function (array $chunk) use ($qb, $select) {
					$qb->setParameter('uids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
					return array_map(static fn (Message $message) => $message->getId(), $this->findEntities($select));
				}, array_chunk($uids, 1000));
			}

			return array_map(static fn (Message $message) => $message->getId(), $this->findEntities($select));
		});
	}

	/**
	 * Cap the execution time of a search query (PostgreSQL only).
	 *
	 * The search is by far the heaviest query of this app, and nothing
	 * else in the stack limits a runaway instance's lifetime: a single
	 * pathological search was observed live running for 51 minutes (16
	 * concurrent copies, database pinned, every other request starving
	 * behind them). A generous cap -- two orders of magnitude above the
	 * measured normal case -- turns that failure mode into one cleanly
	 * failed request instead of a full-instance outage.
	 *
	 * Deliberately scoped to THIS session and reset right after, never
	 * set at the role/database level: migrations, repair steps, cron
	 * jobs and other apps' queries legitimately run long and must not
	 * inherit any cap.
	 *
	 * @template T
	 * @param callable(): T $fn
	 * @return T
	 */
	private function executeWithSearchTimeout(callable $fn) {
		if ($this->db->getDatabaseProvider() !== IDBConnection::PLATFORM_POSTGRES) {
			return $fn();
		}

		$this->db->executeStatement("SET statement_timeout = '60s'");
		try {
			return $fn();
		} finally {
			$this->db->executeStatement('RESET statement_timeout');
		}
	}

	public function findIdsGloballyByQuery(IUser $user, SearchQuery $query, ?int $limit, ?array $uids = null): array {
		$qb = $this->db->getQueryBuilder();
		$qbMailboxes = $this->db->getQueryBuilder();

		// No DISTINCT needed: recipient matches are EXISTS probes (see
		// recipientEmailsMatchExists()), so the row set never contains
		// more than one row per message in the first place.
		$select = $qb->select(['m.id', 'm.sent_at']);

		$selfJoin = $select->expr()->andX(
			$select->expr()->eq('m.mailbox_id', 'm2.mailbox_id', IQueryBuilder::PARAM_INT),
			$select->expr()->eq('m.thread_root_id', 'm2.thread_root_id', IQueryBuilder::PARAM_INT),
			$select->expr()->orX(
				$select->expr()->lt('m.sent_at', 'm2.sent_at', IQueryBuilder::PARAM_INT),
				$select->expr()->andX(
					$select->expr()->eq('m.sent_at', 'm2.sent_at', IQueryBuilder::PARAM_INT),
					$select->expr()->lt('m.message_id', 'm2.message_id', IQueryBuilder::PARAM_STR),
				),
			),
		);

		$select->from($this->getTableName(), 'm')
			->leftJoin('m', $this->getTableName(), 'm2', $selfJoin);

		$selectMailboxIds = $qbMailboxes->select('mb.id')
			->from('mail_mailboxes', 'mb')
			->join('mb', 'mail_accounts', 'a', $qb->expr()->eq('a.id', 'mb.account_id', IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('a.user_id', $qb->createNamedParameter($user->getUID())));

		if ($query instanceof GlobalSearchQuery) {
			$excludeMailboxIds = $query->getExcludeMailboxIds();
			if (count($excludeMailboxIds) > 0) {
				$selectMailboxIds->andWhere(
					$qb->expr()->notIn('mb.id', $qb->createNamedParameter($excludeMailboxIds, IQueryBuilder::PARAM_INT_ARRAY))
				);
			}
		}

		$select->where(
			$qb->expr()->in('m.mailbox_id', $qb->createFunction($selectMailboxIds->getSQL()), IQueryBuilder::PARAM_INT_ARRAY)
		);

		if (!empty($query->getFrom())) {
			$select->andWhere($this->recipientEmailsMatchExists($qb, Recipient::TYPE_FROM, $query->getFrom()));
		}
		if (!empty($query->getTo())) {
			$select->andWhere($this->recipientEmailsMatchExists($qb, Recipient::TYPE_TO, $query->getTo()));
		}
		if (!empty($query->getCc())) {
			$select->andWhere($this->recipientEmailsMatchExists($qb, Recipient::TYPE_CC, $query->getCc()));
		}
		if (!empty($query->getBcc())) {
			$select->andWhere($this->recipientEmailsMatchExists($qb, Recipient::TYPE_BCC, $query->getBcc()));
		}

		if (!empty($query->getSubjects())) {
			$select->andWhere(
				$qb->expr()->orX(
					...array_map(fn (string $subject) => $qb->expr()->iLike(
						'm.subject',
						$qb->createNamedParameter('%' . $this->db->escapeLikeParameter($subject) . '%', IQueryBuilder::PARAM_STR),
						IQueryBuilder::PARAM_STR
					), $query->getSubjects())
				)
			);
		}

		if (!empty($query->getStart())) {
			$select->andWhere(
				$qb->expr()->gte('m.sent_at', $qb->createNamedParameter($query->getStart()), IQueryBuilder::PARAM_INT)
			);
		}

		if (!empty($query->getEnd())) {
			$select->andWhere(
				$qb->expr()->lte('m.sent_at', $qb->createNamedParameter($query->getEnd()), IQueryBuilder::PARAM_INT)
			);
		}

		if ($query->getCursor() !== null) {
			$select->andWhere(
				$qb->expr()->lt('m.sent_at', $qb->createNamedParameter($query->getCursor(), IQueryBuilder::PARAM_INT))
			);
		}
		if ($uids !== null) {
			$select->andWhere(
				$qb->expr()->in('m.uid', $qb->createParameter('uids'))
			);
		}
		foreach ($query->getFlags() as $flag) {
			$select->andWhere($qb->expr()->eq('m.' . $this->flagToColumnName($flag), $qb->createNamedParameter($flag->isSet(), IQueryBuilder::PARAM_BOOL)));
		}
		// Global search never served the priority-inbox partition, so a
		// thread-excluded flag keeps its historical per-message meaning
		// here (same as the flat branch of findIdsByQuery()).
		foreach ($query->getThreadExcludedFlags() as $flag) {
			$select->andWhere($qb->expr()->eq('m.' . $this->flagToColumnName($flag), $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL)));
		}
		if (!empty($query->getFlagExpressions())) {
			$select->andWhere(
				...array_map(fn (FlagExpression $expr) => $this->flagExpressionToQuery($expr, $select, 'm'), $query->getFlagExpressions())
			);
		}

		$select->andWhere($qb->expr()->isNull('m2.id'));

		// See findAllIds()'s own comment: sent_at alone ties across
		// mailboxes even more readily than within one, and this method
		// always applies a LIMIT below -- same non-determinism risk.
		$select->orderBy('m.sent_at', 'desc');
		$select->addOrderBy('m.id', 'desc');

		if ($limit !== null) {
			$select->setMaxResults($limit);
		}

		return $this->executeWithSearchTimeout(function () use ($select, $uids) {
			if ($uids !== null) {
				return array_flat_map(function (array $chunk) use ($select) {
					$select->setParameter('uids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
					return array_map(static fn (Message $message) => $message->getId(), $this->findEntities($select));
				}, array_chunk($uids, 1000));
			}

			return array_map(static fn (Message $message) => $message->getId(), $this->findEntities($select));
		});
	}

	/**
	 * Return true when a distinct query is required.
	 *
	 * For the threaded message list it's necessary to self-join
	 * the mail_messages table to figure out if we are the latest message
	 * of a thread.
	 *
	 * Unfortunately a self-join on a larger table has a significant
	 * performance impact. An database index (e.g. on thread_root_id)
	 * could improve the query performance but adding an index is blocked by
	 * - https://github.com/nextcloud/server/pull/25471
	 * - https://github.com/nextcloud/mail/issues/4735
	 *
	 * We noticed a better query performance without distinct. As distinct is
	 * only necessary when a search query is present (e.g. search for mail with
	 * two recipients) it's reasonable to use distinct only for those requests.
	 *
	 * @param SearchQuery $query
	 * @return bool
	 */
	/**
	 * Recipient match as an EXISTS(...) sub-query instead of an INNER JOIN.
	 *
	 * Joining mail_recipients (up to four times, one alias per address
	 * field) multiplied the row set by the number of recipients per
	 * message BEFORE any filtering: measured on a 27k-message mailbox,
	 * ~440k joined rows flowed through the final ILIKE filter, with a
	 * SELECT DISTINCT on top to fold the duplicates back out again. An
	 * EXISTS probe per message keeps the row set at one row per message,
	 * needs no DISTINCT, and lets the planner pick a semi-join strategy.
	 *
	 * Named parameters are deliberately created on the OUTER query
	 * builder ($qb): both builders generate placeholder names from their
	 * own independent counters, so a value bound on the inner builder
	 * collides with the outer builder's same-named placeholder once the
	 * inner SQL is embedded as literal text (same reasoning as the
	 * thread-flag EXISTS in findIdsByQuery()).
	 *
	 * @param string[] $terms substring-matched against email and label
	 */
	private function recipientTermsMatchExists(IQueryBuilder $qb, int $type, array $terms): string {
		$inner = $this->db->getQueryBuilder();
		$inner->select($inner->expr()->literal(1))
			->from('mail_recipients', 'r')
			->where(
				$inner->expr()->eq('r.message_id', 'm.id', IQueryBuilder::PARAM_INT),
				$inner->expr()->eq('r.type', $qb->createNamedParameter($type, IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT),
				$inner->expr()->orX(
					...array_map(fn (string $email) => $inner->expr()->iLike('r.email', $qb->createNamedParameter('%' . $this->db->escapeLikeParameter($email) . '%', IQueryBuilder::PARAM_STR)), $terms),
					...array_map(fn (string $label) => $inner->expr()->iLike('r.label', $qb->createNamedParameter('%' . $this->db->escapeLikeParameter($label) . '%', IQueryBuilder::PARAM_STR)), $terms),
				),
			);
		return 'EXISTS (' . $inner->getSQL() . ')';
	}

	/**
	 * Same as recipientTermsMatchExists(), for exact address matches
	 * (findIdsGloballyByQuery()'s semantics).
	 *
	 * @param string[] $emails matched exactly against email
	 */
	private function recipientEmailsMatchExists(IQueryBuilder $qb, int $type, array $emails): string {
		$inner = $this->db->getQueryBuilder();
		$inner->select($inner->expr()->literal(1))
			->from('mail_recipients', 'r')
			->where(
				$inner->expr()->eq('r.message_id', 'm.id', IQueryBuilder::PARAM_INT),
				$inner->expr()->eq('r.type', $qb->createNamedParameter($type, IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT),
				$inner->expr()->in('r.email', $qb->createNamedParameter($emails, IQueryBuilder::PARAM_STR_ARRAY)),
			);
		return 'EXISTS (' . $inner->getSQL() . ')';
	}

	private function flagExpressionToQuery(FlagExpression $expr, IQueryBuilder $qb, string $tableAlias): string {
		$operands = array_map(function (object $operand) use ($qb, $tableAlias) {
			if ($operand instanceof Flag) {
				return $qb->expr()->eq(
					$tableAlias . '.' . $this->flagToColumnName($operand),
					$qb->createNamedParameter($operand->isSet(), IQueryBuilder::PARAM_BOOL),
					IQueryBuilder::PARAM_BOOL
				);
			}
			if ($operand instanceof FlagExpression) {
				return $this->flagExpressionToQuery($operand, $qb, $tableAlias);
			}

			throw new RuntimeException('Invalid operand type ' . get_class($operand));
		}, $expr->getOperands());

		/** @psalm-suppress InvalidCast */
		return match ($expr->getOperator()) {
			'and' => (string)$qb->expr()->andX(...$operands),
			'or' => (string)$qb->expr()->orX(...$operands),
			default => throw new RuntimeException('Unknown operator ' . $expr->getOperator()),
		};
	}

	private function flagToColumnName(Flag $flag): string {
		// workaround for @link https://github.com/nextcloud/mail/issues/25
		if ($flag->getFlag() === Tag::LABEL_IMPORTANT) {
			return 'flag_important';
		}
		$key = ltrim($flag->getFlag(), '\\$');
		return "flag_$key";
	}

	/**
	 * @param Mailbox $mailbox
	 * @param int[] $uids
	 *
	 * @return Message[]
	 */
	public function findByUids(Mailbox $mailbox, array $uids): array {
		$qb = $this->db->getQueryBuilder();

		$select = $qb
			->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->eq('mailbox_id', $qb->createNamedParameter($mailbox->getId()), IQueryBuilder::PARAM_INT),
				$qb->expr()->in('uid', $qb->createNamedParameter($uids, IQueryBuilder::PARAM_INT_ARRAY))
			)
			->orderBy('sent_at', 'desc');
		return $this->findRecipients($this->findEntities($select));
	}

	/**
	 * @param Mailbox $mailbox
	 * @param string $userId
	 * @param int[] $ids
	 *
	 * @return Message[]
	 */
	public function findByMailboxAndIds(Mailbox $mailbox, string $userId, array $ids): array {
		if ($ids === []) {
			return [];
		}

		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->eq('mailbox_id', $qb->createNamedParameter($mailbox->getId()), IQueryBuilder::PARAM_INT),
				$qb->expr()->in('id', $qb->createParameter('ids'))
			)
			->orderBy('sent_at', 'desc');

		$results = [];
		foreach (array_chunk($ids, 1000) as $chunk) {
			$qb->setParameter('ids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
			$results[] = $this->findRelatedData($this->findEntities($qb), $userId);
		}
		return array_merge([], ...$results);
	}

	/**
	 * @param string $userId
	 * @param int[] $ids
	 * @param string $sortOrder
	 *
	 * @return Message[]
	 */
	public function findByIds(string $userId, array $ids, string $sortOrder, string $orderBy = 'sent_at'): array {
		if ($ids === []) {
			return [];
		}
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->in('id', $qb->createParameter('ids'))
			)
			->orderBy($orderBy, $sortOrder);

		$results = [];
		foreach (array_chunk($ids, 1000) as $chunk) {
			$qb->setParameter('ids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
			$results[] = $this->findRelatedData($this->findEntities($qb), $userId);
		}
		return array_merge([], ...$results);
	}

	/**
	 * @param Message[] $messages
	 *
	 * @return Message[]
	 */
	private function findRecipients(array $messages): array {
		/** @var Message[] $indexedMessages */
		$indexedMessages = array_combine(
			array_map(static fn (Message $msg) => $msg->getId(), $messages),
			$messages
		);

		$qb2 = $this->db->getQueryBuilder();
		$qb2->select('label', 'email', 'type', 'message_id')
			->from('mail_recipients')
			->where($qb2->expr()->in('message_id', $qb2->createParameter('ids'), IQueryBuilder::PARAM_INT_ARRAY));

		$recipientsResults = [];
		foreach (array_chunk(array_keys($indexedMessages), 1000) as $chunk) {
			$qb2->setParameter('ids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
			$result = $qb2->executeQuery();
			$recipientsResults[] = $result->fetchAll();
			$result->closeCursor();
		}

		$recipientsResults = array_merge([], ...$recipientsResults);

		foreach ($recipientsResults as $recipient) {
			$message = $indexedMessages[(int)$recipient['message_id']];
			switch ($recipient['type']) {
				case Address::TYPE_FROM:
					$message->setFrom(
						$message->getFrom()->merge(AddressList::fromRow($recipient))
					);
					break;
				case Address::TYPE_TO:
					$message->setTo(
						$message->getTo()->merge(AddressList::fromRow($recipient))
					);
					break;
				case Address::TYPE_CC:
					$message->setCc(
						$message->getCc()->merge(AddressList::fromRow($recipient))
					);
					break;
				case Address::TYPE_BCC:
					$message->setBcc(
						$message->getBcc()->merge(AddressList::fromRow($recipient))
					);
					break;
			}
		}

		return $messages;
	}

	/**
	 * @param Message[] $messages
	 * @return Message[]
	 */
	public function findRelatedData(array $messages, string $userId): array {
		$messages = $this->findRecipients($messages);
		$messages = $this->applyHasUnseenInThread($messages);
		$tags = $this->tagMapper->getAllTagsForMessages($messages, $userId);
		/** @var Message $message */
		$messages = array_map(static function ($message) use ($tags) {
			$messageId = $message->getMessageId();
			$message->setTags($messageId !== null ? ($tags[$messageId] ?? []) : []);
			return $message;
		}, $messages);
		return $messages;
	}

	/**
	 * A thread's newest message is what's shown as a single row in
	 * threaded listings (see the m2 self-join in findIdsByQuery()), but its
	 * own flag_seen only reflects that one message. Compute whether ANY
	 * message in its thread is still unseen, so the frontend can show the
	 * whole thread as unread even when its newest reply has already been
	 * read -- the same thread-wide semantics as the "unread" filter.
	 *
	 * @param Message[] $messages
	 * @return Message[]
	 */
	private function applyHasUnseenInThread(array $messages): array {
		$threadRootIdsByMailbox = [];
		foreach ($messages as $message) {
			$threadRootId = $message->getThreadRootId();
			if ($threadRootId !== null) {
				$threadRootIdsByMailbox[$message->getMailboxId()][] = $threadRootId;
			}
		}

		$unseenThreadKeys = [];
		foreach ($threadRootIdsByMailbox as $mailboxId => $threadRootIds) {
			$qb = $this->db->getQueryBuilder();
			$qb->selectDistinct('thread_root_id')
				->from($this->getTableName())
				->where(
					$qb->expr()->eq('mailbox_id', $qb->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT)),
					$qb->expr()->in('thread_root_id', $qb->createNamedParameter(array_values(array_unique($threadRootIds)), IQueryBuilder::PARAM_STR_ARRAY)),
					$qb->expr()->eq('flag_seen', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL)),
				);
			$result = $qb->executeQuery();
			while (($threadRootId = $result->fetchOne()) !== false) {
				$unseenThreadKeys[$mailboxId . ':' . $threadRootId] = true;
			}
			$result->closeCursor();
		}

		foreach ($messages as $message) {
			$threadRootId = $message->getThreadRootId();
			if ($threadRootId === null) {
				// Not grouped with anything (see findIdsByQuery()'s self-join
				// for why), so the thread's status is just its own.
				$message->setHasUnseenInThread($message->getFlagSeen() !== true);
			} else {
				$message->setHasUnseenInThread(isset($unseenThreadKeys[$message->getMailboxId() . ':' . $threadRootId]));
			}
		}

		return $messages;
	}

	/**
	 * @param Mailbox $mailbox
	 * @param array $ids
	 * @param int|null $lastMessageTimestamp
	 * @param IMailSearch::ORDER_* $sortOrder
	 *
	 * @return int[]
	 */
	public function findNewIds(Mailbox $mailbox, array $ids, ?int $lastMessageTimestamp, string $sortOrder): array {
		$select = $this->db->getQueryBuilder();
		$subSelect = $this->db->getQueryBuilder();

		$subSelect
			->select($sortOrder === IMailSearch::ORDER_NEWEST_FIRST
				? $subSelect->func()->min('sent_at')
				: $subSelect->func()->max('sent_at'))
			->from($this->getTableName())
			->where(
				$subSelect->expr()->eq('mailbox_id', $select->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT)),
				$subSelect->expr()->orX(
					$subSelect->expr()->in('id', $select->createParameter('ids'), IQueryBuilder::PARAM_INT_ARRAY)
				)
			);

		$selfJoin = $select->expr()->andX(
			$select->expr()->eq('m.mailbox_id', 'm2.mailbox_id', IQueryBuilder::PARAM_INT),
			$select->expr()->eq('m.thread_root_id', 'm2.thread_root_id', IQueryBuilder::PARAM_INT),
			$select->expr()->orX(
				$sortOrder === IMailSearch::ORDER_NEWEST_FIRST
					? $select->expr()->lt('m.sent_at', 'm2.sent_at', IQueryBuilder::PARAM_INT)
					: $select->expr()->gt('m.sent_at', 'm2.sent_at', IQueryBuilder::PARAM_INT),
				$select->expr()->andX(
					$select->expr()->eq('m.sent_at', 'm2.sent_at', IQueryBuilder::PARAM_INT),
					$select->expr()->lt('m.message_id', 'm2.message_id', IQueryBuilder::PARAM_STR),
				),
			),
		);
		$wheres = [$select->expr()->eq('m.mailbox_id', $select->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT)),
			$select->expr()->andX($subSelect->expr()->notIn('m.id', $select->createParameter('ids'), IQueryBuilder::PARAM_INT_ARRAY)),
			$select->expr()->isNull('m2.id'),
		];
		if ($sortOrder === IMailSearch::ORDER_NEWEST_FIRST) {
			$wheres[] = $select->expr()->gt('m.sent_at', $select->createFunction('(' . $subSelect->getSQL() . ')'), IQueryBuilder::PARAM_INT);
		} else {
			$wheres[] = $select->expr()->lt('m.sent_at', $select->createFunction('(' . $subSelect->getSQL() . ')'), IQueryBuilder::PARAM_INT);
		}

		if ($lastMessageTimestamp !== null && $sortOrder === IMailSearch::ORDER_OLDEST_FIRST) {
			// Don't consider old "new messages" as new when their UID has already been seen before
			$wheres[] = $select->expr()->lt('m.sent_at', $select->createNamedParameter($lastMessageTimestamp, IQueryBuilder::PARAM_INT));
		}

		$select
			->select(['m.id', 'm.sent_at'])
			->from($this->getTableName(), 'm')
			->leftJoin('m', $this->getTableName(), 'm2', $selfJoin)
			->where(...$wheres)
			->orderBy('m.sent_at', $sortOrder === IMailSearch::ORDER_NEWEST_FIRST ? 'desc' : 'asc');

		$results = [];
		foreach (array_chunk($ids, 1000) as $chunk) {
			$select->setParameter('ids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
			$results[] = $this->findIds($select);
		}

		return array_merge([], ...$results);
	}

	/**
	 * Currently unused
	 */
	public function findChanged(Account $account, Mailbox $mailbox, int $since): array {
		$qb = $this->db->getQueryBuilder();

		$select = $qb
			->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->eq('mailbox_id', $qb->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT)),
				$qb->expr()->gt('updated_at', $qb->createNamedParameter($since, IQueryBuilder::PARAM_INT))
			);
		return $this->findRelatedData($this->findEntities($select), $account->getUserId());
	}

	/**
	 * @param array $mailboxIds
	 * @param int $limit
	 *
	 * @return Message[]
	 */
	public function findLatestMessages(string $userId, array $mailboxIds, int $limit): array {
		$qb = $this->db->getQueryBuilder();

		$select = $qb
			->select('m.*')
			->from($this->getTableName(), 'm')
			->where(
				$qb->expr()->in('m.mailbox_id', $qb->createNamedParameter($mailboxIds, IQueryBuilder::PARAM_INT_ARRAY), IQueryBuilder::PARAM_INT_ARRAY)
			)
			->orderBy('sent_at', 'desc')
			->setMaxResults($limit);

		return $this->findRelatedData($this->findEntities($select), $userId);
	}

	public function deleteOrphans(): void {
		$qb1 = $this->db->getQueryBuilder();
		$idsQuery = $qb1->select('m.id')
			->from($this->getTableName(), 'm')
			->leftJoin('m', 'mail_mailboxes', 'mb', $qb1->expr()->eq('m.mailbox_id', 'mb.id'))
			->where($qb1->expr()->isNull('mb.id'));
		$result = $idsQuery->executeQuery();
		$ids = [];
		while ($row = $result->fetch()) {
			$ids[] = (int)$row['id'];
		}
		$result->closeCursor();

		$qb2 = $this->db->getQueryBuilder();
		$query = $qb2
			->delete($this->getTableName())
			->where($qb2->expr()->in('id', $qb2->createParameter('ids'), IQueryBuilder::PARAM_INT_ARRAY));
		foreach (array_chunk($ids, 1000) as $chunk) {
			$query->setParameter('ids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
			$query->executeStatement();
		}
		$qb3 = $this->db->getQueryBuilder();
		$recipientIdsQuery = $qb3->selectDistinct('r.id')
			->from('mail_recipients', 'r')
			->leftJoin('r', 'mail_messages', 'm', $qb3->expr()->eq('r.message_id', 'm.id'))
			->where(
				$qb3->expr()->isNull('m.id'),
				$qb3->expr()->isNull('r.local_message_id')
			);
		$result = $recipientIdsQuery->executeQuery();
		while ($row = $result->fetch()) {
			$ids[] = (int)$row['id'];
		}
		$result->closeCursor();

		$qb4 = $this->db->getQueryBuilder();
		$recipientsQuery = $qb4
			->delete('mail_recipients')
			->where($qb4->expr()->in('id', $qb4->createParameter('ids'), IQueryBuilder::PARAM_INT_ARRAY));
		foreach (array_chunk($ids, 1000) as $chunk) {
			$recipientsQuery->setParameter('ids', $chunk, IQueryBuilder::PARAM_INT_ARRAY);
			$recipientsQuery->executeStatement();
		}
	}

	public function getIdForUid(Mailbox $mailbox, int $uid): ?int {
		$qb = $this->db->getQueryBuilder();

		$select = $qb
			->select('m.id')
			->from($this->getTableName(), 'm')
			->where(
				$qb->expr()->eq('mailbox_id', $qb->createNamedParameter($mailbox->getId()), IQueryBuilder::PARAM_INT),
				$qb->expr()->eq('uid', $qb->createNamedParameter($uid, IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT)
			);
		$result = $select->executeQuery();
		$rows = $result->fetchAll();
		$result->closeCursor();
		if (empty($rows)) {
			return null;
		}
		return (int)$rows[0]['id'];
	}

	/**
	 * @return Message[]
	 */
	public function findWithEmptyMessageId(): array {
		$qb = $this->db->getQueryBuilder();

		$select = $qb->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->isNull('message_id')
			);

		return $this->findEntities($select);
	}

	public function resetInReplyTo(): int {
		$qb = $this->db->getQueryBuilder();

		$update = $qb->update($this->tableName)
			->set('in_reply_to', $qb->createNamedParameter('NULL', IQueryBuilder::PARAM_NULL))
			->where(
				$qb->expr()->like('in_reply_to', $qb->createNamedParameter('<>', IQueryBuilder::PARAM_STR), IQueryBuilder::PARAM_STR)
			);
		return $update->executeStatement();
	}

	/**
	 * Get all iMIP messages from the last two weeks
	 * that haven't been processed yet
	 * @return Message[]
	 */
	public function findIMipMessagesAscending(): array {
		$time = $this->timeFactory->getTime() - 60 * 60 * 24 * 14;
		$qb = $this->db->getQueryBuilder();

		$select = $qb->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->eq('imip_message', $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL), IQueryBuilder::PARAM_BOOL),
				$qb->expr()->eq('imip_processed', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL), IQueryBuilder::PARAM_BOOL),
				$qb->expr()->eq('imip_error', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL), IQueryBuilder::PARAM_BOOL),
				$qb->expr()->eq('flag_junk', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL), IQueryBuilder::PARAM_BOOL),
				$qb->expr()->gt('sent_at', $qb->createNamedParameter($time, IQueryBuilder::PARAM_INT)),
			)->orderBy('sent_at', 'ASC'); // make sure we don't process newer messages first

		return $this->findEntities($select);
	}

	/**
	 * @return Message[]
	 *
	 * @throws \OCP\DB\Exception
	 */
	public function getUnanalyzed(int $lastRun, array $mailboxIds): array {
		$qb = $this->db->getQueryBuilder();

		$select = $qb->select('*')
			->from($this->getTableName())
			->where(
				$qb->expr()->gt('sent_at', $qb->createNamedParameter($lastRun, IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT),
				$qb->expr()->eq('structure_analyzed', $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL), IQueryBuilder::PARAM_BOOL),
				$qb->expr()->in('mailbox_id', $qb->createNamedParameter($mailboxIds, IQueryBuilder::PARAM_INT_ARRAY), IQueryBuilder::PARAM_INT_ARRAY),
			)->orderBy('sent_at', 'ASC');

		return $this->findEntities($select);
	}

	/**
	 * @param int $mailboxId
	 * @param int $before UNIX timestamp (seconds)
	 *
	 * @return Message[]
	 */
	public function findMessagesKnownSinceBefore(int $mailboxId, int $before): array {
		$qb = $this->db->getQueryBuilder();

		$select = $qb->select('m.*')
			->from($this->getTableName(), 'm')
			->join('m', 'mail_messages_retention', 'mr', $qb->expr()->andX(
				$qb->expr()->eq(
					'm.mailbox_id',
					'mr.mailbox_id',
					IQueryBuilder::PARAM_INT,
				),
				$qb->expr()->eq(
					'm.uid',
					'mr.uid',
					IQueryBuilder::PARAM_INT,
				),
			))
			->where(
				$qb->expr()->eq(
					'm.mailbox_id',
					$qb->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT),
					IQueryBuilder::PARAM_INT,
				),
				$qb->expr()->lt(
					'mr.known_since',
					$qb->createNamedParameter($before, IQueryBuilder::PARAM_INT),
					IQueryBuilder::PARAM_INT,
				),
			);

		return $this->findEntities($select);
	}

	/**
	 * Finds snoozed messages that are ready to wake since $time
	 *
	 * @param int $mailboxId
	 * @param int $time UNIX timestamp (seconds)
	 *
	 * @return Message[]
	 */
	public function findMessagesToUnSnooze(int $mailboxId, int $time): array {
		$qb = $this->db->getQueryBuilder();

		$select = $qb->select('m.*')
			->from($this->getTableName(), 'm')
			->join('m', 'mail_messages_snoozed', 'mr', $qb->expr()->andX(
				$qb->expr()->eq(
					'm.mailbox_id',
					'mr.mailbox_id',
					IQueryBuilder::PARAM_INT,
				),
				$qb->expr()->eq(
					'm.uid',
					'mr.uid',
					IQueryBuilder::PARAM_INT,
				),
			))
			->where(
				$qb->expr()->eq(
					'm.mailbox_id',
					$qb->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT),
					IQueryBuilder::PARAM_INT,
				),
				$qb->expr()->lt(
					'mr.snoozed_until',
					$qb->createNamedParameter($time, IQueryBuilder::PARAM_INT),
					IQueryBuilder::PARAM_INT,
				),
			);

		return $this->findEntities($select);
	}

	/**
	 * Delete all duplicated cached messages.
	 * Some messages (with the same mailbox_id and uid) where inserted twice and this method cleans
	 * up the duplicated rows.
	 *
	 * @throws \OCP\DB\Exception
	 */
	public function deleteDuplicateUids(): void {
		$qb = $this->db->getQueryBuilder();
		$result = $qb->select('t1.id', 't1.mailbox_id', 't1.uid')
			->from($this->getTableName(), 't1')
			->innerJoin('t1', $this->getTableName(), 't2', $qb->expr()->andX(
				$qb->expr()->eq('t1.mailbox_id', 't2.mailbox_id', IQueryBuilder::PARAM_INT),
				$qb->expr()->eq('t1.uid', 't2.uid', IQueryBuilder::PARAM_INT),
				$qb->expr()->neq('t1.id', 't2.id', IQueryBuilder::PARAM_INT),
			))
			->executeQuery();

		$deleteQb = $this->db->getQueryBuilder();
		$deleteQb->delete($this->getTableName())
			->where(
				$deleteQb->expr()->neq(
					'id',
					$deleteQb->createParameter('id'),
					IQueryBuilder::PARAM_INT,
				),
				$deleteQb->expr()->eq(
					'mailbox_id',
					$deleteQb->createParameter('mailbox_id'),
					IQueryBuilder::PARAM_INT,
				),
				$deleteQb->expr()->eq(
					'uid',
					$deleteQb->createParameter('uid'),
					IQueryBuilder::PARAM_INT,
				),
			);

		$handledMailboxIdUidPairs = [];
		while ($row = $result->fetch()) {
			$pair = $row['mailbox_id'] . ':' . $row['uid'];
			if (isset($handledMailboxIdUidPairs[$pair])) {
				continue;
			}

			$deleteQb->setParameter('id', $row['id'], IQueryBuilder::PARAM_INT);
			$deleteQb->setParameter('mailbox_id', $row['mailbox_id'], IQueryBuilder::PARAM_INT);
			$deleteQb->setParameter('uid', $row['uid'], IQueryBuilder::PARAM_INT);
			$deleteQb->executeStatement();

			$handledMailboxIdUidPairs[$pair] = true;
		}

		$result->closeCursor();
	}

	/**
	 * Find n message IDs that are higher than $afterId and sent after $sentAfter
	 * @param Mailbox $mailbox
	 * @param int $afterId
	 * @param int $sentAfter
	 * @param int $limit
	 * @return int[]
	 */
	public function findIdsAfter(Mailbox $mailbox, int $afterId, int $sentAfter, int $limit) : array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('m.id')
			->from($this->getTableName(), 'm')
			->where(
				$qb->expr()->eq('mailbox_id', $qb->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT)),
				$qb->expr()->gt('id', $qb->createNamedParameter($afterId, IQueryBuilder::PARAM_INT)),
				$qb->expr()->gt('sent_at', $qb->createNamedParameter($sentAfter, IQueryBuilder::PARAM_INT)),
			)
			->orderBy('id', 'asc')
			->setMaxResults($limit);

		return $this->findIds($qb);
	}
}
