<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2021 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Integration\Db;

use ChristophWurst\Nextcloud\Testing\DatabaseTransaction;
use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Db\Tag;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Service\Search\Flag;
use OCA\Mail\Service\Search\SearchQuery;
use OCA\Mail\Support\PerformanceLogger;
use OCA\Mail\Support\PerformanceLoggerTask;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\ICacheFactory;
use OCP\IDBConnection;
use OCP\IL10N;
use OCP\IMemcache;
use Psr\Log\LoggerInterface;
use function array_map;
use function range;
use function time;

/**
 * Minimal, real (not a dumb mock) in-memory IMemcache: the
 * flag_important grace-window logic under test is driven by comparing
 * a stored confirmation timestamp against the (mockable) ITimeFactory,
 * not by the cache backend's own physical TTL -- a get()/set() round
 * trip that actually stores the value is what these tests need, and
 * whatever this disposable container's real ICacheFactory happens to
 * resolve to (possibly a no-op NullCache without Redis configured) is
 * not guaranteed to provide that.
 */
class ArrayMemcache implements IMemcache {
	private array $values = [];

	public function get($key) {
		return $this->values[$key] ?? null;
	}

	public function set($key, $value, $ttl = 0) {
		$this->values[$key] = $value;
		return true;
	}

	public function hasKey($key) {
		return array_key_exists($key, $this->values);
	}

	public function remove($key) {
		unset($this->values[$key]);
		return true;
	}

	public function clear($prefix = '') {
		$this->values = [];
		return true;
	}

	public static function isAvailable(): bool {
		return true;
	}

	public function add($key, $value, $ttl = 0) {
		if ($this->hasKey($key)) {
			return false;
		}
		return $this->set($key, $value, $ttl);
	}

	public function inc($key, $step = 1) {
		$value = ($this->values[$key] ?? 0) + $step;
		$this->values[$key] = $value;
		return $value;
	}

	public function dec($key, $step = 1) {
		if (!$this->hasKey($key)) {
			return false;
		}
		$value = $this->values[$key] - $step;
		$this->values[$key] = $value;
		return $value;
	}

	public function cas($key, $old, $new) {
		if (($this->values[$key] ?? null) !== $old) {
			return false;
		}
		$this->values[$key] = $new;
		return true;
	}

	public function cad($key, $old) {
		if (($this->values[$key] ?? null) !== $old) {
			return false;
		}
		unset($this->values[$key]);
		return true;
	}

	public function ncad(string $key, mixed $old): bool {
		if (($this->values[$key] ?? null) === $old) {
			return false;
		}
		unset($this->values[$key]);
		return true;
	}
}

class MessageMapperTest extends TestCase {
	use DatabaseTransaction;

	/** @var IDBConnection */
	private $db;

	/** @var ITimeFactory */
	private $time;

	private int $timestamp = 1234567890;

	/** @var MessageMapper */
	private $mapper;

	private TagMapper $tagMapper;

	private ArrayMemcache $flagImportantCache;

	protected function setUp(): void {
		parent::setUp();

		$this->db = \OCP\Server::get(\OCP\IDBConnection::class);
		$this->time = $this->createMock(ITimeFactory::class);
		$this->time->method('getTime')->willReturnCallback(fn () => $this->timestamp);
		// A real TagMapper, not a mock: the important-tag protection tests
		// below (see updateTags()) need genuine get/insert/delete
		// round-trips against mail_tags/mail_message_tags, the same
		// reasoning ArrayMemcache above exists for IMemcache. IL10N is
		// only ever touched by createDefaultTags(), which nothing here
		// calls.
		$this->tagMapper = new TagMapper($this->db, $this->createMock(IL10N::class), $this->time);
		$performanceLogger = $this->createMock(PerformanceLogger::class);
		// start() has a non-nullable PerformanceLoggerTask return type --
		// updateBulk() (used by the tests below) calls ->step() on
		// whatever it gets back, so an unconfigured mock's default null
		// return would fatal. A real instance is cheap and side-effect
		// free enough (it only logs, via the also-mocked logger below).
		$performanceLogger->method('start')->willReturn(
			new PerformanceLoggerTask('test', $this->time, $this->createMock(LoggerInterface::class))
		);
		$this->flagImportantCache = new ArrayMemcache();
		$cacheFactory = $this->createMock(ICacheFactory::class);
		$cacheFactory->method('createDistributed')->willReturn($this->flagImportantCache);
		$this->mapper = new MessageMapper(
			$this->db,
			$this->time,
			$this->tagMapper,
			$performanceLogger,
			$cacheFactory,
		);

		$qb = $this->db->getQueryBuilder();

		$delete = $qb->delete($this->mapper->getTableName());
		$delete->executeStatement();

		// Cleaned the same way as mail_messages above -- the important-tag
		// protection tests below leave real rows in these two tables.
		$this->db->getQueryBuilder()->delete('mail_message_tags')->executeStatement();
		$this->db->getQueryBuilder()->delete('mail_tags')->executeStatement();
	}

	private function insertMessage(int $uid, int $mailbox_id): void {
		$qb = $this->db->getQueryBuilder();
		$insert = $qb->insert($this->mapper->getTableName())
			->values([
				'uid' => $qb->createNamedParameter($uid, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<abc' . $uid . $mailbox_id . '@123.com>'),
				'mailbox_id' => $qb->createNamedParameter($mailbox_id, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('TEST'),
				'sent_at' => $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT),
				'in_reply_to' => $qb->createNamedParameter('<>')
			]);
		$insert->executeStatement();
	}

	private function insertMessageWithId(int $id, int $mailbox_id): void {
		$qb = $this->db->getQueryBuilder();
		$insert = $qb->insert($this->mapper->getTableName())
			->values([
				'id' => $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT),
				'uid' => $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<abc' . $id . $mailbox_id . '@123.com>'),
				'mailbox_id' => $qb->createNamedParameter($mailbox_id, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('TEST'),
				'sent_at' => $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT),
				'in_reply_to' => $qb->createNamedParameter('<>')
			]);
		$insert->executeStatement();
	}

	public function testPriorityInboxStatsAreExactForThreadedAndSingletonViews(): void {
		$rows = [
			// One conversation: its newest row is read+favorite, while an
			// older member makes the whole thread unread+important.
			[1, 1, 'thread-a', 100, false, false, true, false],
			[2, 1, 'thread-a', 200, true, true, false, false],
			[3, 1, 'thread-b', 300, false, false, true, false],
			[4, 1, 'thread-c', 400, true, false, false, false],
			// Deleted rows do not contribute to either totals or flags.
			[5, 1, 'thread-deleted', 500, false, true, true, true],
			// A different mailbox proves the mailbox-id restriction.
			[6, 2, 'thread-other-mailbox', 600, false, true, true, false],
		];

		foreach ($rows as [$id, $mailboxId, $threadRoot, $sentAt, $seen, $flagged, $important, $deleted]) {
			$qb = $this->db->getQueryBuilder();
			$qb->insert($this->mapper->getTableName())->values([
				'id' => $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT),
				'uid' => $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter("<priority-stats-$id@example.test>"),
				'thread_root_id' => $qb->createNamedParameter($threadRoot),
				'mailbox_id' => $qb->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('priority stats'),
				'sent_at' => $qb->createNamedParameter($sentAt, IQueryBuilder::PARAM_INT),
				'flag_seen' => $qb->createNamedParameter($seen, IQueryBuilder::PARAM_BOOL),
				'flag_flagged' => $qb->createNamedParameter($flagged, IQueryBuilder::PARAM_BOOL),
				'flag_important' => $qb->createNamedParameter($important, IQueryBuilder::PARAM_BOOL),
				'flag_deleted' => $qb->createNamedParameter($deleted, IQueryBuilder::PARAM_BOOL),
			])->executeStatement();
		}

		self::assertSame([
			'favorite' => ['total' => 1, 'unread' => 1],
			'important' => ['total' => 1, 'unread' => 1],
			'other' => ['total' => 1, 'unread' => 0],
		], $this->mapper->getPriorityInboxStats([1], true, true));

		self::assertSame([
			'favorite' => ['total' => 1, 'unread' => 0],
			'important' => ['total' => 2, 'unread' => 2],
			'other' => ['total' => 1, 'unread' => 0],
		], $this->mapper->getPriorityInboxStats([1], false, true));

		self::assertSame([
			'favorite' => ['total' => 0, 'unread' => 0],
			'important' => ['total' => 2, 'unread' => 2],
			'other' => ['total' => 1, 'unread' => 0],
		], $this->mapper->getPriorityInboxStats([1], true, false));

		self::assertSame([
			'favorite' => ['total' => 0, 'unread' => 0],
			'important' => ['total' => 0, 'unread' => 0],
			'other' => ['total' => 0, 'unread' => 0],
		], $this->mapper->getPriorityInboxStats([], true, true));
	}

	public function testFindSyncStatesTracksThreadWideFlagsAndTagChangesWithoutHydratingEnvelopes(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		$threadRoot = '<sync-state-thread@example.test>';

		foreach ([
			[801, 1801, '<sync-state-a@example.test>', false],
			[802, 1802, '<sync-state-b@example.test>', true],
		] as [$id, $uid, $messageId, $seen]) {
			$qb = $this->db->getQueryBuilder();
			$qb->insert($this->mapper->getTableName())->values([
				'id' => $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT),
				'uid' => $qb->createNamedParameter($uid, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter($messageId),
				'thread_root_id' => $qb->createNamedParameter($threadRoot),
				'mailbox_id' => $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('sync state'),
				'sent_at' => $qb->createNamedParameter($uid, IQueryBuilder::PARAM_INT),
				'flag_seen' => $qb->createNamedParameter($seen, IQueryBuilder::PARAM_BOOL),
				'updated_at' => $qb->createNamedParameter(100, IQueryBuilder::PARAM_INT),
			])->executeStatement();
		}

		$initial = $this->mapper->findSyncStatesForIds($mailbox, [802, 999]);
		self::assertSame([802], array_keys($initial));

		// Changing the older sibling changes the representative row's
		// thread-wide unread state.
		$qb = $this->db->getQueryBuilder();
		$qb->update($this->mapper->getTableName())
			->set('flag_seen', $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL))
			->set('updated_at', $qb->createNamedParameter(101, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('id', $qb->createNamedParameter(801, IQueryBuilder::PARAM_INT)))
			->executeStatement();
		$afterThreadChange = $this->mapper->findSyncStatesForIds($mailbox, [802]);
		self::assertNotSame($initial[802], $afterThreadChange[802]);

		// Tags live in a separate relation; TagMapper deliberately touches
		// the message revision so the narrow state query sees that change.
		$tag = new Tag();
		$tag->setImapLabel('$sync-state-test');
		$tag->setDisplayName('Sync state test');
		$tag->setUserId('sync-state-user');
		$this->tagMapper->tagMessage($tag, '<sync-state-b@example.test>', 'sync-state-user');
		$afterTagChange = $this->mapper->findSyncStatesForIds($mailbox, [802]);
		self::assertNotSame($afterThreadChange[802], $afterTagChange[802]);
	}

	public function testResetInReplyTo() : void {
		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(13);
		array_map(function ($i) {
			$qb = $this->db->getQueryBuilder();
			$insert = $qb->insert($this->mapper->getTableName())
				->values([
					'uid' => $qb->createNamedParameter($i, IQueryBuilder::PARAM_INT),
					'message_id' => $qb->createNamedParameter('<abc' . $i . '@123.com>'),
					'mailbox_id' => $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT),
					'subject' => $qb->createNamedParameter('TEST'),
					'sent_at' => $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT),
					'in_reply_to' => $qb->createNamedParameter('<>')
				]);
			$insert->executeStatement();
		}, range(1, 10));

		array_map(function ($i) {
			$qb = $this->db->getQueryBuilder();
			$insert = $qb->insert($this->mapper->getTableName())
				->values([
					'uid' => $qb->createNamedParameter($i, IQueryBuilder::PARAM_INT),
					'message_id' => $qb->createNamedParameter('<abc' . $i . '@123.com>'),
					'mailbox_id' => $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT),
					'subject' => $qb->createNamedParameter('TEST'),
					'sent_at' => $qb->createNamedParameter(time(), IQueryBuilder::PARAM_INT),
					'in_reply_to' => $qb->createNamedParameter('<abc@dgf.com>')
				]);
			$insert->executeStatement();
		}, range(11, 20));

		$result = $this->mapper->resetInReplyTo();

		$this->assertEquals(10, $result);

		$qb2 = $this->db->getQueryBuilder();
		$select = $qb2->select('*')
			->from($this->mapper->getTableName())
			->where(
				$qb2->expr()->like('in_reply_to', $qb2->createNamedParameter('<>', IQueryBuilder::PARAM_STR), IQueryBuilder::PARAM_STR)
			);

		$result = $select->executeQuery();
		$rows = $result->fetchAll();

		$this->assertEmpty($rows);
	}

	public function testResetPreviewDataFlag(): void {
		$uid = time();
		$qb = $this->db->getQueryBuilder();
		$insert = $qb->insert($this->mapper->getTableName())
			->values([
				'uid' => $qb->createNamedParameter($uid, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<abc@123.com>'),
				'mailbox_id' => $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('TEST'),
				'sent_at' => $qb->createNamedParameter(time(), IQueryBuilder::PARAM_INT),
			]);
		$insert->executeStatement();

		$this->mapper->resetPreviewDataFlag();

		$qb2 = $this->db->getQueryBuilder();
		$result = $qb2->select($qb2->func()->count('*'))
			->from($this->mapper->getTableName())
			->where(
				$qb2->expr()->eq('uid', $qb2->createNamedParameter($uid, IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT),
				$qb2->expr()->eq('structure_analyzed', $qb2->createNamedParameter(true, IQueryBuilder::PARAM_BOOL), IQueryBuilder::PARAM_BOOL)
			)
			->executeQuery();
		$cnt = $result->fetchOne();
		$result->closeCursor();
		self::assertEquals(0, $cnt);
	}

	/**
	 * @param bool $flagImportant the fresh value a live IMAP fetch reported for
	 *                            this fetch cycle -- what toDbMessage() would
	 *                            have produced
	 */
	private function freshlyFetchedMessage(int $uid, int $mailboxId, bool $flagImportant): Message {
		$message = new Message();
		$message->setUid($uid);
		$message->setMailboxId($mailboxId);
		$message->setFlagAnswered(false);
		$message->setFlagDeleted(false);
		$message->setFlagDraft(false);
		$message->setFlagFlagged(false);
		$message->setFlagSeen(false);
		$message->setFlagForwarded(false);
		$message->setFlagJunk(false);
		$message->setFlagNotjunk(false);
		$message->setFlagMdnsent(false);
		$message->setFlagImportant($flagImportant);
		return $message;
	}

	private function selectFlagImportant(int $uid, int $mailboxId): bool {
		$qb = $this->db->getQueryBuilder();
		$result = $qb->select('flag_important')
			->from($this->mapper->getTableName())
			->where(
				$qb->expr()->eq('uid', $qb->createNamedParameter($uid, IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT),
				$qb->expr()->eq('mailbox_id', $qb->createNamedParameter($mailboxId, IQueryBuilder::PARAM_INT), IQueryBuilder::PARAM_INT)
			)
			->executeQuery();
		$value = $result->fetchOne();
		$result->closeCursor();
		return (bool)$value;
	}

	/**
	 * flag_important represents this app's own importance classification
	 * (see ImportanceClassifier.php), not a genuine externally-synced IMAP
	 * flag with shared, multi-client meaning the way \Seen/\Flagged/
	 * \Answered are. Confirmed live: NewMessagesClassifier locally decides
	 * a message is important and tries to propagate that back to Gmail
	 * via IMAP, but if that propagation hasn't landed yet (or Gmail's own
	 * backend has a moment of eventual-consistency lag for it, plausible
	 * under the slow/unreliable IMAP conditions documented elsewhere for
	 * this account) by the time the next routine resync re-fetches the
	 * message, toDbMessage() recomputes flag_important fresh from
	 * whatever Gmail's own keyword state says right now -- still false --
	 * and updateBulk() used to blindly overwrite the classifier's local
	 * decision back to false. The Priority Inbox's "Important" section
	 * visibly lost and regained messages with no user action involved.
	 */
	public function testUpdateBulkProtectsARecentTrueConfirmationFromAContradictingFalseReading(): void {
		$mailboxId = 1;
		$uid = 42;
		$this->insertMessage($uid, $mailboxId);
		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(13);
		$account->method('getName')->willReturn('test account');

		// Confirms flag_important true and starts the grace window (see
		// shouldTrustFlagImportantReading()).
		$this->mapper->updateBulk($account, false, $this->freshlyFetchedMessage($uid, $mailboxId, true));
		self::assertTrue($this->selectFlagImportant($uid, $mailboxId));

		// A routine resync re-fetching this same message moments later,
		// with Gmail's own IMAP keyword state (still) not reporting it
		// as important -- exactly what happens while that same write is
		// still settling.
		$this->mapper->updateBulk($account, false, $this->freshlyFetchedMessage($uid, $mailboxId, false));

		self::assertTrue($this->selectFlagImportant($uid, $mailboxId));
	}

	/**
	 * The exact symmetric counterpart of the test above -- deliberately,
	 * since shouldTrustFlagImportantReading() has no separate "upgrade"
	 * or "downgrade" branch, only one check applied to both directions.
	 * Without this direction also being protected, a user's own
	 * markEnvelopeImportantOrUnimportant() (removing importance) could be
	 * silently reverted by a stale/concurrent sync still reporting
	 * Gmail's pre-removal state -- caught on review, since an earlier
	 * version of this fix only ever protected the true -> false direction.
	 */
	public function testUpdateBulkProtectsARecentFalseConfirmationFromAContradictingTrueReading(): void {
		$mailboxId = 1;
		$uid = 46;
		$this->insertMessage($uid, $mailboxId);
		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(13);
		$account->method('getName')->willReturn('test account');

		// Confirms flag_important false -- e.g. the user just removed
		// importance via markEnvelopeImportantOrUnimportant() and that
		// propagated to IMAP, and this is the sync that first observes it.
		$this->mapper->updateBulk($account, false, $this->freshlyFetchedMessage($uid, $mailboxId, false));
		self::assertFalse($this->selectFlagImportant($uid, $mailboxId));

		// A different, concurrent sync that happened to read IMAP just
		// before the removal took effect there, still reporting the old
		// "important" state.
		$this->mapper->updateBulk($account, false, $this->freshlyFetchedMessage($uid, $mailboxId, true));

		self::assertFalse($this->selectFlagImportant($uid, $mailboxId));
	}

	/**
	 * The flip side of the first test: once the grace window has
	 * genuinely elapsed, a contradicting reading is trusted rather than
	 * dismissed forever -- otherwise a message whose importance was
	 * deliberately removed directly in Gmail would stay stuck important
	 * in this app permanently, which is exactly the concern that
	 * motivated a time-bounded grace period over a flat "never downgrade".
	 */
	public function testUpdateBulkTrustsAContradictingFalseReadingOnceTheGracePeriodHasElapsed(): void {
		$mailboxId = 1;
		$uid = 44;
		$this->insertMessage($uid, $mailboxId);
		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(13);
		$account->method('getName')->willReturn('test account');

		$this->mapper->updateBulk($account, false, $this->freshlyFetchedMessage($uid, $mailboxId, true));
		self::assertTrue($this->selectFlagImportant($uid, $mailboxId));

		// Past FLAG_IMPORTANT_GRACE_SECONDS (120s, the same scale as
		// RECENT_FLAG_CHANGE_GRACE_MS client-side).
		$this->timestamp += 130;

		$this->mapper->updateBulk($account, false, $this->freshlyFetchedMessage($uid, $mailboxId, false));

		self::assertFalse($this->selectFlagImportant($uid, $mailboxId));
	}

	public function testUpdateBulkAppliesAMatchingReadingNormally(): void {
		$mailboxId = 1;
		$uid = 43;
		$this->insertMessage($uid, $mailboxId);
		self::assertFalse($this->selectFlagImportant($uid, $mailboxId));

		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(13);
		$account->method('getName')->willReturn('test account');

		// Gmail's own IMAP keyword state genuinely reports this message
		// as important now (e.g. the user starred it as important
		// directly in Gmail, or Gmail's own classifier flagged it) --
		// nothing was previously confirmed for this message, so this is
		// trusted immediately.
		$this->mapper->updateBulk($account, false, $this->freshlyFetchedMessage($uid, $mailboxId, true));

		self::assertTrue($this->selectFlagImportant($uid, $mailboxId));
	}

	/**
	 * insertBulk() (a message's very first sync) seeds flag_important
	 * from Gmail's own state at that point -- correct and unchanged by
	 * this fix. It must also start the SAME grace window an updateBulk()
	 * confirmation does, or a routine resync landing moments after the
	 * initial sync could immediately undo a message that arrived
	 * already marked important.
	 */
	public function testInsertBulkAlsoStartsTheGracePeriodForAMessageThatArrivesAlreadyImportant(): void {
		$mailboxId = 1;
		$uid = 45;
		$message = new Message();
		$message->setUid($uid);
		$message->setMessageId('<initial-sync-' . $uid . '@test.com>');
		$message->setMailboxId($mailboxId);
		$message->setSubject('TEST');
		$message->setSentAt($this->time->getTime());
		$message->setFlagAnswered(false);
		$message->setFlagDeleted(false);
		$message->setFlagDraft(false);
		$message->setFlagFlagged(false);
		$message->setFlagSeen(false);
		$message->setFlagForwarded(false);
		$message->setFlagJunk(false);
		$message->setFlagNotjunk(false);
		$message->setFlagMdnsent(false);
		$message->setFlagImportant(true);

		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(13);
		$account->method('getName')->willReturn('test account');

		$this->mapper->insertBulk($account, $message);
		self::assertTrue($this->selectFlagImportant($uid, $mailboxId));

		// A routine resync landing moments after the initial sync, with
		// Gmail's own IMAP keyword state not (yet?) reporting it as
		// important on this particular fetch.
		$this->mapper->updateBulk($account, false, $this->freshlyFetchedMessage($uid, $mailboxId, false));

		self::assertTrue($this->selectFlagImportant($uid, $mailboxId));
	}

	/**
	 * @param Tag[] $imapTags whatever this fetch's toDbMessage() derived
	 *                        the message's tags to be, right now
	 */
	private function freshlyFetchedMessageWithTags(int $uid, int $mailboxId, bool $flagImportant, array $imapTags): Message {
		$message = $this->freshlyFetchedMessage($uid, $mailboxId, $flagImportant);
		$message->setMessageId($this->messageIdFor($uid, $mailboxId));
		$message->setTags($imapTags);
		return $message;
	}

	private function messageIdFor(int $uid, int $mailboxId): string {
		return '<abc' . $uid . $mailboxId . '@123.com>';
	}

	private function importantTag(): Tag {
		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);
		$tag->setUserId('testuser');
		$tag->setDisplayName('Important');
		return $tag;
	}

	private function workTag(): Tag {
		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_WORK);
		$tag->setUserId('testuser');
		$tag->setDisplayName('Work');
		return $tag;
	}

	private function messageIsTagged(int $uid, int $mailboxId, string $imapLabel): bool {
		$qb = $this->db->getQueryBuilder();
		$result = $qb->select($qb->func()->count('*'))
			->from('mail_message_tags', 'mt')
			->join('mt', 'mail_tags', 't', $qb->expr()->eq('mt.tag_id', 't.id', IQueryBuilder::PARAM_INT))
			->where(
				$qb->expr()->eq('mt.imap_message_id', $qb->createNamedParameter($this->messageIdFor($uid, $mailboxId))),
				$qb->expr()->eq('t.imap_label', $qb->createNamedParameter($imapLabel))
			)
			->executeQuery();
		$count = (int)$result->fetchOne();
		$result->closeCursor();
		return $count > 0;
	}

	/**
	 * The important TAG ($label1, read by Envelope.vue's isImportant() to
	 * show the badge) is flag_important's own value stored a second time,
	 * historically (see MigrateImportantFromImapAndDb.php). Both are
	 * derived from the exact same IMAP fetch in toDbMessage(), yet before
	 * this fix only flag_important was protected from a fresh-but-not-
	 * yet-settled IMAP read -- updateTags() untagged a message the
	 * classifier had just tagged important the moment the very next
	 * flags-resync (often the same poll, since the classifier's own IMAP
	 * write already bumps HIGHESTMODSEQ) re-fetched it before Gmail's own
	 * backend made the keyword visible. Confirmed live: the important
	 * badge disappearing right after appearing, with flag_important
	 * itself staying correctly true throughout.
	 */
	public function testUpdateBulkProtectsARecentlyAddedImportantTagFromBeingRemovedByAContradictingReading(): void {
		$mailboxId = 1;
		$uid = 47;
		$this->insertMessage($uid, $mailboxId);
		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(13);
		$account->method('getName')->willReturn('test account');
		$account->method('getUserId')->willReturn('testuser');

		// The classifier's own write: flag_important true, tag applied --
		// confirms the grace window for both at once.
		$this->mapper->updateBulk(
			$account,
			true,
			$this->freshlyFetchedMessageWithTags($uid, $mailboxId, true, [$this->importantTag()]),
		);
		self::assertTrue($this->selectFlagImportant($uid, $mailboxId));
		self::assertTrue($this->messageIsTagged($uid, $mailboxId, Tag::LABEL_IMPORTANT));

		// A routine resync re-fetching this same message moments later,
		// with Gmail's own IMAP keyword state not yet reporting either
		// the flag or the label -- exactly what happens while that same
		// write is still settling.
		$this->mapper->updateBulk(
			$account,
			true,
			$this->freshlyFetchedMessageWithTags($uid, $mailboxId, false, []),
		);

		self::assertTrue($this->selectFlagImportant($uid, $mailboxId));
		self::assertTrue($this->messageIsTagged($uid, $mailboxId, Tag::LABEL_IMPORTANT));
	}

	/**
	 * The symmetric counterpart: a user removing importance via
	 * markEnvelopeImportantOrUnimportant() shouldn't have the tag
	 * silently re-added by a stale/concurrent sync still reporting
	 * Gmail's pre-removal state -- same reasoning as
	 * shouldTrustFlagImportantReading() itself having no separate
	 * "upgrade"/"downgrade" branch.
	 */
	public function testUpdateBulkProtectsARecentlyRemovedImportantTagFromBeingReAddedByAContradictingReading(): void {
		$mailboxId = 1;
		$uid = 48;
		$this->insertMessage($uid, $mailboxId);
		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(13);
		$account->method('getName')->willReturn('test account');
		$account->method('getUserId')->willReturn('testuser');

		// Confirms flag_important+tag false immediately -- e.g. the user
		// just removed importance via markEnvelopeImportantOrUnimportant()
		// and that propagated to IMAP, and this is the sync that first
		// observes it. No prior confirmation exists yet for this uid, so
		// (mirroring testUpdateBulkProtectsARecentFalseConfirmationFrom
		// AContradictingTrueReading() above) this is trusted immediately
		// rather than needing a separate earlier "confirm true" step,
		// which -- within the same grace window -- would itself have been
		// protected and left both the flag and the tag at true.
		$this->mapper->updateBulk(
			$account,
			true,
			$this->freshlyFetchedMessageWithTags($uid, $mailboxId, false, []),
		);
		self::assertFalse($this->selectFlagImportant($uid, $mailboxId));
		self::assertFalse($this->messageIsTagged($uid, $mailboxId, Tag::LABEL_IMPORTANT));

		// A different, concurrent sync that happened to read IMAP just
		// before the removal took effect there, still reporting the old
		// "important" state for both the flag and the tag.
		$this->mapper->updateBulk(
			$account,
			true,
			$this->freshlyFetchedMessageWithTags($uid, $mailboxId, true, [$this->importantTag()]),
		);

		self::assertFalse($this->selectFlagImportant($uid, $mailboxId));
		self::assertFalse($this->messageIsTagged($uid, $mailboxId, Tag::LABEL_IMPORTANT));
	}

	/**
	 * Once the grace period has genuinely elapsed, a contradicting
	 * reading is trusted for the tag exactly as it already is for
	 * flag_important -- otherwise a message manually untagged important
	 * directly in Gmail would stay stuck tagged in this app permanently.
	 */
	public function testUpdateBulkTrustsAContradictingTagReadingOnceTheGracePeriodHasElapsed(): void {
		$mailboxId = 1;
		$uid = 49;
		$this->insertMessage($uid, $mailboxId);
		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(13);
		$account->method('getName')->willReturn('test account');
		$account->method('getUserId')->willReturn('testuser');

		$this->mapper->updateBulk(
			$account,
			true,
			$this->freshlyFetchedMessageWithTags($uid, $mailboxId, true, [$this->importantTag()]),
		);
		self::assertTrue($this->messageIsTagged($uid, $mailboxId, Tag::LABEL_IMPORTANT));

		// Past FLAG_IMPORTANT_GRACE_SECONDS (120s).
		$this->timestamp += 130;

		$this->mapper->updateBulk(
			$account,
			true,
			$this->freshlyFetchedMessageWithTags($uid, $mailboxId, false, []),
		);

		self::assertFalse($this->selectFlagImportant($uid, $mailboxId));
		self::assertFalse($this->messageIsTagged($uid, $mailboxId, Tag::LABEL_IMPORTANT));
	}

	/**
	 * The important-tag protection above must not turn into blanket
	 * protection for every tag on a message -- an ordinary, unrelated tag
	 * (e.g. a user-applied "Work" label, with no flag_important
	 * involvement at all) keeps following IMAP's fresh reading normally,
	 * added and removed immediately, exactly as before this fix.
	 */
	public function testUpdateBulkStillUpdatesUnrelatedTagsNormallyWhenTheImportantTagIsProtected(): void {
		$mailboxId = 1;
		$uid = 50;
		$this->insertMessage($uid, $mailboxId);
		$account = $this->createMock(Account::class);
		$account->method('getId')->willReturn(13);
		$account->method('getName')->willReturn('test account');
		$account->method('getUserId')->willReturn('testuser');

		$this->mapper->updateBulk(
			$account,
			true,
			$this->freshlyFetchedMessageWithTags($uid, $mailboxId, true, [$this->importantTag(), $this->workTag()]),
		);
		self::assertTrue($this->messageIsTagged($uid, $mailboxId, Tag::LABEL_IMPORTANT));
		self::assertTrue($this->messageIsTagged($uid, $mailboxId, Tag::LABEL_WORK));

		// A stale reading missing both tags: the important tag is
		// protected by the still-active grace window, but Work -- having
		// nothing to do with flag_important -- is removed immediately,
		// same as any ordinary flag/tag sync always has been.
		$this->mapper->updateBulk(
			$account,
			true,
			$this->freshlyFetchedMessageWithTags($uid, $mailboxId, false, []),
		);

		self::assertTrue($this->messageIsTagged($uid, $mailboxId, Tag::LABEL_IMPORTANT));
		self::assertFalse($this->messageIsTagged($uid, $mailboxId, Tag::LABEL_WORK));
	}

	public function testFindIdsByQuery(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		$searchQuery = new SearchQuery();
		$sortOrder = 'DESC';
		$qb = $this->db->getQueryBuilder();

		$values = [
			[
				'id' => 1,
				'uid' => $qb->createNamedParameter(267, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<abc@123.com>'),
				'mailbox_id' => $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('TEST 1'),
				'sent_at' => $qb->createNamedParameter(1641216000, IQueryBuilder::PARAM_INT),
			],
			[
				'id' => 2,
				'uid' => $qb->createNamedParameter(268, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<def@456.com>'),
				'mailbox_id' => $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('TEST 2'),
				'sent_at' => $qb->createNamedParameter(1641216001, IQueryBuilder::PARAM_INT),
			],
			[
				'id' => 3,
				'uid' => $qb->createNamedParameter(269, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<ghi@789.com>'),
				'mailbox_id' => $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('TEST 3'),
				'sent_at' => $qb->createNamedParameter(1641216003, IQueryBuilder::PARAM_INT),
			],
		];

		foreach ($values as $value) {
			$insert = $qb->insert($this->mapper->getTableName())->values($value);
			$insert->executeStatement();
		}

		$result = $this->mapper->findIdsByQuery($mailbox, $searchQuery, $sortOrder, 3, null);

		self::assertEquals([3,2,1], $result);
	}

	/**
	 * Same regression as testFindAllIdsBreaksSentAtTiesDeterministically(),
	 * for the other LIMIT-bound path: findIdsByQuery() backs both the
	 * message-list endpoint and (via SyncService's cold-start branch,
	 * findAllIds()) a bucket's first sync -- either way, a plain
	 * ORDER BY sent_at with a LIMIT smaller than a tied group is free to
	 * return a different subset of that group on each call.
	 */
	public function testFindIdsByQueryBreaksSentAtTiesDeterministically(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(21);
		$searchQuery = new SearchQuery();
		$qb = $this->db->getQueryBuilder();

		foreach (range(1, 10) as $i) {
			$qb->insert($this->mapper->getTableName())->values([
				'id' => $i,
				'uid' => $qb->createNamedParameter(1000 + $i, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter("<tie{$i}@123.com>"),
				'mailbox_id' => $qb->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter("TEST $i"),
				'sent_at' => $qb->createNamedParameter(1641216000, IQueryBuilder::PARAM_INT),
			])->executeStatement();
		}

		$first = $this->mapper->findIdsByQuery($mailbox, $searchQuery, 'DESC', 3, null);
		for ($i = 0; $i < 5; $i++) {
			$this->assertEquals($first, $this->mapper->findIdsByQuery($mailbox, $searchQuery, 'DESC', 3, null), 'the same tied rows should be returned on every repeated call');
		}
		$this->assertEquals([10, 9, 8], $first);
	}

	public function testFindIdsByQueryCompositeCursorDoesNotSkipSentAtTies(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(22);
		$qb = $this->db->getQueryBuilder();
		foreach (range(1, 5) as $id) {
			$qb->insert($this->mapper->getTableName())->values([
				'id' => $id,
				'uid' => $qb->createNamedParameter(2000 + $id, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter("<cursor-tie{$id}@example.com>"),
				'mailbox_id' => $qb->createNamedParameter($mailbox->getId(), IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter("CURSOR $id"),
				'sent_at' => $qb->createNamedParameter(1700000000, IQueryBuilder::PARAM_INT),
			])->executeStatement();
		}

		$firstQuery = new SearchQuery();
		self::assertSame([5, 4], $this->mapper->findIdsByQuery($mailbox, $firstQuery, 'DESC', 2));
		$secondQuery = new SearchQuery();
		$secondQuery->setCursor(1700000000);
		$secondQuery->setCursorId(4);
		self::assertSame([3, 2, 1], $this->mapper->findIdsByQuery($mailbox, $secondQuery, 'DESC', 3));

		$oldestQuery = new SearchQuery();
		$oldestQuery->setCursor(1700000000);
		$oldestQuery->setCursorId(2);
		self::assertSame([3, 4, 5], $this->mapper->findIdsByQuery($mailbox, $oldestQuery, 'ASC', 3));
	}

	/**
	 * A thread's newest message represents the whole thread in threaded
	 * view (see the m2 self-join in findIdsByQuery()). An unread filter
	 * must match that representative if ANY message in its thread is
	 * unread -- not only if the representative itself is -- otherwise a
	 * thread whose newest reply has already been read hides a genuinely
	 * unread older message entirely.
	 */
	public function testFindIdsByQueryThreadedUnreadMatchesAnyMessageInThread(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$searchQuery = new SearchQuery();
		$searchQuery->addFlag(Flag::not(Flag::SEEN));
		$sortOrder = 'DESC';
		$qb = $this->db->getQueryBuilder();

		$values = [
			// Thread A: older message unread, newest reply already read.
			[
				'id' => 10,
				'uid' => $qb->createNamedParameter(310, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<a1@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Thread A'),
				'sent_at' => $qb->createNamedParameter(1000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-a'),
				'flag_seen' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			],
			[
				'id' => 11,
				'uid' => $qb->createNamedParameter(311, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<a2@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Re: Thread A'),
				'sent_at' => $qb->createNamedParameter(2000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-a'),
				'flag_seen' => $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL),
			],
			// Standalone, already-read message -- must not match.
			[
				'id' => 12,
				'uid' => $qb->createNamedParameter(312, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<b1@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Unrelated'),
				'sent_at' => $qb->createNamedParameter(3000, IQueryBuilder::PARAM_INT),
				'flag_seen' => $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL),
			],
		];

		foreach ($values as $value) {
			$insert = $qb->insert($this->mapper->getTableName())->values($value);
			$insert->executeStatement();
		}

		$result = $this->mapper->findIdsByQuery($mailbox, $searchQuery, $sortOrder, null, null);

		// Only thread A's newest message (11) is returned, representing a
		// thread that genuinely contains an unread message -- even though
		// message 11 itself has already been read.
		self::assertEquals([11], $result);
	}

	/**
	 * The reconciliation query behind ReconcileImportanceTagJob: only
	 * flag-important messages of the given account that have NO mapping
	 * row for the given tag, bounded by the limit. Uses real rows in all
	 * three tables (messages, mailboxes for the account join, and
	 * message_tags for the NOT EXISTS probe).
	 */
	public function testFindImportantMessageIdsWithoutTag(): void {
		$qb = $this->db->getQueryBuilder();
		// Idempotent re-runs against the shared container DB.
		$qb->delete('mail_mailboxes')->where($qb->expr()->eq('account_id', $qb->createNamedParameter(7001, IQueryBuilder::PARAM_INT)))->executeStatement();
		$qb2 = $this->db->getQueryBuilder();
		$qb2->delete('mail_message_tags')->where($qb2->expr()->like('imap_message_id', $qb2->createNamedParameter('%@reconcile.test%')))->executeStatement();

		$qb3 = $this->db->getQueryBuilder();
		$qb3->insert('mail_mailboxes')->values([
			'id' => $qb3->createNamedParameter(7002, IQueryBuilder::PARAM_INT),
			'name' => $qb3->createNamedParameter('INBOX'),
			'name_hash' => $qb3->createNamedParameter(md5('INBOX')),
			'account_id' => $qb3->createNamedParameter(7001, IQueryBuilder::PARAM_INT),
			'delimiter' => $qb3->createNamedParameter('.'),
			'messages' => $qb3->createNamedParameter(0, IQueryBuilder::PARAM_INT),
			'unseen' => $qb3->createNamedParameter(0, IQueryBuilder::PARAM_INT),
		])->executeStatement();

		$rows = [
			// Important, untagged -- the divergence signature, must be found.
			['id' => 30, 'message_id' => '<a@reconcile.test>', 'flag_important' => true],
			// Important, tagged -- healthy, must NOT be found.
			['id' => 31, 'message_id' => '<b@reconcile.test>', 'flag_important' => true],
			// Not important, untagged -- irrelevant, must NOT be found.
			['id' => 32, 'message_id' => '<c@reconcile.test>', 'flag_important' => false],
		];
		foreach ($rows as $row) {
			$insert = $this->db->getQueryBuilder();
			$insert->insert($this->mapper->getTableName())->values([
				'id' => $insert->createNamedParameter($row['id'], IQueryBuilder::PARAM_INT),
				'uid' => $insert->createNamedParameter(700 + $row['id'], IQueryBuilder::PARAM_INT),
				'message_id' => $insert->createNamedParameter($row['message_id']),
				'mailbox_id' => $insert->createNamedParameter(7002, IQueryBuilder::PARAM_INT),
				'subject' => $insert->createNamedParameter('s'),
				'sent_at' => $insert->createNamedParameter(1000 + $row['id'], IQueryBuilder::PARAM_INT),
				'flag_important' => $insert->createNamedParameter($row['flag_important'], IQueryBuilder::PARAM_BOOL),
			])->executeStatement();
		}

		$tag = new Tag();
		$tag->setImapLabel(Tag::LABEL_IMPORTANT);
		$tag->setDisplayName('Important');
		$tag->setUserId('reconcile-test-user');
		$this->tagMapper->tagMessage($tag, '<b@reconcile.test>', 'reconcile-test-user');
		$tagId = $this->tagMapper->getTagByImapLabel(Tag::LABEL_IMPORTANT, 'reconcile-test-user')->getId();

		self::assertEquals(
			['<a@reconcile.test>'],
			$this->mapper->findImportantMessageIdsWithoutTag(7001, $tagId, 100),
		);
		// The limit is honored (0 keeps even the divergent row out).
		self::assertEquals([], $this->mapper->findImportantMessageIdsWithoutTag(7001, $tagId, 0));
	}

	/**
	 * Partition semantics for the priority inbox: "Other" must be the
	 * REMAINDER of "Important" (Gmail's "everything else" model), not an
	 * independent attribute bucket. Under the plain thread-wide EXISTS
	 * match, a mixed thread (one important member, one not) matched BOTH
	 * is:pi-important (some member important) and the old
	 * is:pi-other = Flag::not(IMPORTANT) (some member not important) --
	 * confirmed live, the same conversation listed in both sections at
	 * once. is:pi-other now parses to a thread-EXCLUDED flag (see
	 * SearchQuery::getThreadExcludedFlags()): NOT EXISTS a member with
	 * flag_important, so a thread belongs to exactly one of the two.
	 */
	public function testFindIdsByQueryThreadedOtherExcludesThreadsWithAnyImportantMember(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$sortOrder = 'DESC';
		$qb = $this->db->getQueryBuilder();

		$values = [
			// Thread A (mixed): older message important, newest reply not.
			[
				'id' => 20,
				'uid' => $qb->createNamedParameter(420, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<pa1@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Thread A'),
				'sent_at' => $qb->createNamedParameter(1000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-pa'),
				'flag_important' => $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL),
			],
			[
				'id' => 21,
				'uid' => $qb->createNamedParameter(421, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<pa2@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Re: Thread A'),
				'sent_at' => $qb->createNamedParameter(2000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-pa'),
				'flag_important' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			],
			// Thread B: no important member at all.
			[
				'id' => 22,
				'uid' => $qb->createNamedParameter(422, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<pb1@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Thread B'),
				'sent_at' => $qb->createNamedParameter(3000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-pb'),
				'flag_important' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			],
		];

		foreach ($values as $value) {
			$insert = $qb->insert($this->mapper->getTableName())->values($value);
			$insert->executeStatement();
		}

		// "Other": only thread B -- the mixed thread A is excluded because
		// one of its members is important, even though its newest (and
		// representative) message is not.
		$otherQuery = new SearchQuery();
		$otherQuery->addThreadExcludedFlag(Flag::is(Flag::IMPORTANT));
		self::assertEquals([22], $this->mapper->findIdsByQuery($mailbox, $otherQuery, $sortOrder, null, null));

		// "Important": exactly the complement -- thread A's representative
		// (its newest message, itself NOT important), via the existing
		// thread-wide EXISTS match. Together the two sections partition
		// the mailbox: every thread in exactly one.
		$importantQuery = new SearchQuery();
		$importantQuery->addFlag(Flag::is(Flag::IMPORTANT));
		self::assertEquals([21], $this->mapper->findIdsByQuery($mailbox, $importantQuery, $sortOrder, null, null));
	}

	/**
	 * A bounded generic over-fetch cannot guarantee a page for a rare
	 * section: the first favorite can be older than any fixed shared limit.
	 * The priority split ranks the one content-match relation per section,
	 * so the result remains exact without evaluating the text predicate three
	 * times. The favorite thread also proves classification is thread-wide.
	 */
	public function testFindIdsByQueryPrioritySplitReturnsAnExactPagePerSection(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$qb = $this->db->getQueryBuilder();
		$rows = [
			// Favorite thread: only its older member is flagged. The newest
			// representative (111) must still rank in Favorites.
			[110, 510, 100, true, false, 'priority-favorite'],
			[111, 511, 200, false, false, 'priority-favorite'],
			// Second favorite and two important messages.
			[112, 512, 150, true, false, null],
			[120, 520, 300, false, true, null],
			[121, 521, 400, false, true, null],
		];
		// Seven newer Other messages ensure that the rare favorites lie
		// beyond a naive 3 * page-size generic prefix when page size is 2.
		foreach (range(130, 136) as $id) {
			$rows[] = [$id, 500 + $id, 500 + (($id - 130) * 100), false, false, null];
		}

		foreach ($rows as [$id, $uid, $sentAt, $flagged, $important, $threadRootId]) {
			$values = [
				'id' => $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT),
				'uid' => $qb->createNamedParameter($uid, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter("<priority-$id@example.test>"),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Priority split needle'),
				'sent_at' => $qb->createNamedParameter($sentAt, IQueryBuilder::PARAM_INT),
				'flag_flagged' => $qb->createNamedParameter($flagged, IQueryBuilder::PARAM_BOOL),
				'flag_important' => $qb->createNamedParameter($important, IQueryBuilder::PARAM_BOOL),
			];
			if ($threadRootId !== null) {
				$values['thread_root_id'] = $qb->createNamedParameter($threadRootId);
			}
			$qb->insert($this->mapper->getTableName())->values($values)->executeStatement();
		}

		$query = new SearchQuery();
		$query->addSubject('needle');

		$expected = [136, 135, 121, 120, 111, 112];
		self::assertSame($expected, $this->mapper->findIdsByQuery($mailbox, $query, 'DESC', 2, null, false, true));
		// Body searches supply UID hits in bounded parameter chunks. A
		// subject OR body query repeats the subject matches in every chunk;
		// the final merge must de-duplicate them and retain the same exact
		// per-section ordering.
		self::assertSame($expected, $this->mapper->findIdsByQuery($mailbox, $query, 'DESC', 2, range(1, 1001), false, true));
	}

	/**
	 * The priority inbox's "Other" section (is:pi-other = Flag::not(IMPORTANT))
	 * is fetched in threaded view (view=threaded), then its known ids are
	 * re-checked on every background sync via findIdsByQuery(...,
	 * $uidsRestrict=true) to see which are "still known" (see
	 * SyncService::getDatabaseSyncChanges) -- anything NOT returned is
	 * reported vanished and removed from the client store entirely
	 * (MailboxThread reported the whole section disappearing after a
	 * background tick, working again only after a hard refresh). This
	 * proves the SAME threaded representative id that was originally
	 * returned is ALSO returned by the restricted re-check, with no
	 * thread changes in between -- i.e. the vanish-check must not be
	 * spuriously stricter than the original match for the ordinary,
	 * nothing-changed case.
	 */
	public function testFindIdsByQueryThreadedNegatedFlagSurvivesUidsRestrictRecheck(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$searchQuery = new SearchQuery();
		$searchQuery->addFlag(Flag::not(Flag::IMPORTANT));
		$sortOrder = 'DESC';
		$qb = $this->db->getQueryBuilder();

		$values = [
			// Thread A: older message not important, newest reply IS
			// important -- the thread still matches is:pi-other because
			// some message in it isn't important, same as the unread case.
			[
				'id' => 20,
				'uid' => $qb->createNamedParameter(320, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<a1@other.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Thread A'),
				'sent_at' => $qb->createNamedParameter(1000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-other-a'),
				'flag_important' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			],
			[
				'id' => 21,
				'uid' => $qb->createNamedParameter(321, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<a2@other.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Re: Thread A'),
				'sent_at' => $qb->createNamedParameter(2000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-other-a'),
				'flag_important' => $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL),
			],
			// Standalone, not-important message.
			[
				'id' => 22,
				'uid' => $qb->createNamedParameter(322, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<b1@other.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Standalone'),
				'sent_at' => $qb->createNamedParameter(3000, IQueryBuilder::PARAM_INT),
				'flag_important' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			],
		];

		foreach ($values as $value) {
			$insert = $qb->insert($this->mapper->getTableName())->values($value);
			$insert->executeStatement();
		}

		// The original (unrestricted) fetch: representative of thread A
		// (21) plus the standalone message (22).
		$original = $this->mapper->findIdsByQuery($mailbox, $searchQuery, $sortOrder, null, null);
		self::assertEquals([22, 21], $original);

		// The sync-diff re-check: restrict to exactly the uids the client
		// already knows about (321 for id 21, 322 for id 22), nothing has
		// changed server-side. Every one of them must still come back --
		// if not, that's precisely the "known ids silently vanish" bug.
		$recheck = $this->mapper->findIdsByQuery($mailbox, $searchQuery, $sortOrder, null, [321, 322], true);
		self::assertEquals([22, 21], $recheck);
	}

	/**
	 * Recipient matches run as EXISTS probes against mail_recipients
	 * instead of INNER JOINs (see recipientTermsMatchExists()): the JOINs
	 * multiplied the row set by the recipients per message and needed a
	 * SELECT DISTINCT to fold the duplicates back out. Same results, one
	 * row per message from the start.
	 */
	public function testFindIdsByQueryMatchesRecipientsWithoutDuplicates(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(3);
		$searchQuery = new SearchQuery();
		$searchQuery->setThreaded(false);
		$searchQuery->addFrom('alice');
		$sortOrder = 'DESC';

		$messages = [
			// Two FROM rows both matching "alice" -- with the old JOIN this
			// message appeared twice before DISTINCT.
			['id' => 20, 'uid' => 320, 'message_id' => '<r1@rcpt.com>', 'subject' => 'From Alice', 'sent_at' => 1000],
			// "alice" appears only as TO -- must NOT match a from: search.
			['id' => 21, 'uid' => 321, 'message_id' => '<r2@rcpt.com>', 'subject' => 'To Alice', 'sent_at' => 2000],
			// No recipients at all -- must not match either.
			['id' => 22, 'uid' => 322, 'message_id' => '<r3@rcpt.com>', 'subject' => 'No recipients', 'sent_at' => 3000],
		];
		foreach ($messages as $value) {
			$qb = $this->db->getQueryBuilder();
			$qb->insert($this->mapper->getTableName())->values([
				'id' => $qb->createNamedParameter($value['id'], IQueryBuilder::PARAM_INT),
				'uid' => $qb->createNamedParameter($value['uid'], IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter($value['message_id']),
				'mailbox_id' => $qb->createNamedParameter(3, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter($value['subject']),
				'sent_at' => $qb->createNamedParameter($value['sent_at'], IQueryBuilder::PARAM_INT),
			])->executeStatement();
		}

		$recipients = [
			// TYPE_FROM = 0, TYPE_TO = 1 (Recipient::TYPE_*)
			['message_id' => 20, 'type' => 0, 'label' => 'Alice One', 'email' => 'alice@example.com'],
			['message_id' => 20, 'type' => 0, 'label' => 'Alice Two', 'email' => 'alice@elsewhere.com'],
			['message_id' => 21, 'type' => 1, 'label' => 'Alice One', 'email' => 'alice@example.com'],
			['message_id' => 21, 'type' => 0, 'label' => 'Bob', 'email' => 'bob@example.com'],
		];
		foreach ($recipients as $value) {
			$rqb = $this->db->getQueryBuilder();
			$rqb->insert('mail_recipients')->values([
				'message_id' => $rqb->createNamedParameter($value['message_id'], IQueryBuilder::PARAM_INT),
				'type' => $rqb->createNamedParameter($value['type'], IQueryBuilder::PARAM_INT),
				'label' => $rqb->createNamedParameter($value['label']),
				'email' => $rqb->createNamedParameter($value['email']),
			])->executeStatement();
		}

		$result = $this->mapper->findIdsByQuery($mailbox, $searchQuery, $sortOrder, null, null);

		self::assertEquals([20], $result);
	}

	/**
	 * The sync-diff path restricts its result to candidate UIDs
	 * ($uidsRestrict = true): a search bucket's background sync asks
	 * "which of these NEW uids match the bucket's filter". Without the
	 * flag, a query with a subject term OR-ed the candidates in, so
	 * every new message "matched" and ordinary mail flooded the active
	 * search's results on the next background tick (confirmed live).
	 */
	public function testFindIdsByQueryRestrictUidsAlwaysLimitsToCandidates(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(3);
		$searchQuery = new SearchQuery();
		$searchQuery->setThreaded(false);
		$searchQuery->setMatch('anyof');
		$searchQuery->addSubject('euseful');
		$sortOrder = 'DESC';

		$messages = [
			// Matches the filter AND is a candidate: the only valid result.
			['id' => 40, 'uid' => 340, 'message_id' => '<u1@sync.com>', 'subject' => 'EUseful weekly', 'sent_at' => 1000],
			// Candidate uid but does NOT match the filter -- the exact
			// message class that used to leak into search results.
			['id' => 41, 'uid' => 341, 'message_id' => '<u2@sync.com>', 'subject' => 'Ordinary new mail', 'sent_at' => 2000],
			// Matches the filter but is NOT a candidate (already known).
			['id' => 42, 'uid' => 342, 'message_id' => '<u3@sync.com>', 'subject' => 'EUseful older', 'sent_at' => 3000],
		];
		foreach ($messages as $value) {
			$qb = $this->db->getQueryBuilder();
			$qb->insert($this->mapper->getTableName())->values([
				'id' => $qb->createNamedParameter($value['id'], IQueryBuilder::PARAM_INT),
				'uid' => $qb->createNamedParameter($value['uid'], IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter($value['message_id']),
				'mailbox_id' => $qb->createNamedParameter(3, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter($value['subject']),
				'sent_at' => $qb->createNamedParameter($value['sent_at'], IQueryBuilder::PARAM_INT),
			])->executeStatement();
		}

		$candidates = [340, 341];

		// Sync-diff semantics: only candidates that match the filter.
		$restricted = $this->mapper->findIdsByQuery($mailbox, $searchQuery, $sortOrder, null, $candidates, true);
		self::assertEquals([40], $restricted);

		// Search semantics (default): body-search hits combine with
		// subject hits, so both candidates AND the non-candidate
		// subject match are returned.
		$combined = $this->mapper->findIdsByQuery($mailbox, $searchQuery, $sortOrder, null, $candidates, false);
		self::assertEquals([42, 41, 40], $combined);
	}

	/**
	 * The 'anyof' match combines recipient and subject terms with OR
	 * instead of AND -- the free-text search path.
	 */
	public function testFindIdsByQueryAnyofMatchesRecipientOrSubject(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(3);
		$searchQuery = new SearchQuery();
		$searchQuery->setThreaded(false);
		$searchQuery->setMatch('anyof');
		$searchQuery->addFrom('alice');
		$searchQuery->addSubject('alice');
		$sortOrder = 'DESC';

		$messages = [
			// Matches via sender.
			['id' => 30, 'uid' => 330, 'message_id' => '<s1@any.com>', 'subject' => 'Nothing relevant', 'sent_at' => 1000],
			// Matches via subject only.
			['id' => 31, 'uid' => 331, 'message_id' => '<s2@any.com>', 'subject' => 'About alice, again', 'sent_at' => 2000],
			// Matches neither.
			['id' => 32, 'uid' => 332, 'message_id' => '<s3@any.com>', 'subject' => 'Unrelated', 'sent_at' => 3000],
		];
		foreach ($messages as $value) {
			$qb = $this->db->getQueryBuilder();
			$qb->insert($this->mapper->getTableName())->values([
				'id' => $qb->createNamedParameter($value['id'], IQueryBuilder::PARAM_INT),
				'uid' => $qb->createNamedParameter($value['uid'], IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter($value['message_id']),
				'mailbox_id' => $qb->createNamedParameter(3, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter($value['subject']),
				'sent_at' => $qb->createNamedParameter($value['sent_at'], IQueryBuilder::PARAM_INT),
			])->executeStatement();
		}

		$rqb = $this->db->getQueryBuilder();
		$rqb->insert('mail_recipients')->values([
			'message_id' => $rqb->createNamedParameter(30, IQueryBuilder::PARAM_INT),
			'type' => $rqb->createNamedParameter(0, IQueryBuilder::PARAM_INT),
			'label' => $rqb->createNamedParameter('Alice'),
			'email' => $rqb->createNamedParameter('alice@example.com'),
		])->executeStatement();

		$result = $this->mapper->findIdsByQuery($mailbox, $searchQuery, $sortOrder, null, null);

		self::assertEquals([31, 30], $result);
	}

	/**
	 * The non-threaded path is unaffected by the above: a flag filter still
	 * applies to each message individually, not thread-wide.
	 */
	public function testFindIdsByQueryNonThreadedUnreadMatchesOnlyThatMessage(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(2);
		$searchQuery = new SearchQuery();
		$searchQuery->setThreaded(false);
		$searchQuery->addFlag(Flag::not(Flag::SEEN));
		$sortOrder = 'DESC';
		$qb = $this->db->getQueryBuilder();

		$values = [
			[
				'id' => 10,
				'uid' => $qb->createNamedParameter(310, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<a1@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Thread A'),
				'sent_at' => $qb->createNamedParameter(1000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-a'),
				'flag_seen' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			],
			[
				'id' => 11,
				'uid' => $qb->createNamedParameter(311, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<a2@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(2, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Re: Thread A'),
				'sent_at' => $qb->createNamedParameter(2000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-a'),
				'flag_seen' => $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL),
			],
		];

		foreach ($values as $value) {
			$insert = $qb->insert($this->mapper->getTableName())->values($value);
			$insert->executeStatement();
		}

		$result = $this->mapper->findIdsByQuery($mailbox, $searchQuery, $sortOrder, null, null);

		self::assertEquals([10], $result);
	}

	/**
	 * findByIds() (used to load full envelopes, e.g. for a folder listing)
	 * must annotate each loaded message with whether ITS thread contains
	 * any unseen, flagged, or important message -- not just the flags of the
	 * one row displayed for that thread.
	 */
	public function testFindByIdsAnnotatesThreadWideFlags(): void {
		$qb = $this->db->getQueryBuilder();

		$values = [
			// Thread A: older unseen, newest reply already seen.
			[
				'id' => 20,
				'uid' => $qb->createNamedParameter(320, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<a1@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(3, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Thread A'),
				'sent_at' => $qb->createNamedParameter(1000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-a'),
				'flag_seen' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
				'flag_flagged' => $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL),
				'flag_important' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			],
			[
				'id' => 21,
				'uid' => $qb->createNamedParameter(321, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<a2@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(3, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Re: Thread A'),
				'sent_at' => $qb->createNamedParameter(2000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-a'),
				'flag_seen' => $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL),
				'flag_flagged' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
				'flag_important' => $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL),
			],
			// Standalone, unseen -- must annotate itself as unseen.
			[
				'id' => 22,
				'uid' => $qb->createNamedParameter(322, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<b1@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(3, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Standalone'),
				'sent_at' => $qb->createNamedParameter(3000, IQueryBuilder::PARAM_INT),
				'flag_seen' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
				'flag_flagged' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
				'flag_important' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			],
			// Thread C: both seen -- must not be annotated as unseen.
			[
				'id' => 23,
				'uid' => $qb->createNamedParameter(323, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<c1@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(3, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Thread C'),
				'sent_at' => $qb->createNamedParameter(4000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-c'),
				'flag_seen' => $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL),
				'flag_flagged' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
				'flag_important' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			],
			[
				'id' => 24,
				'uid' => $qb->createNamedParameter(324, IQueryBuilder::PARAM_INT),
				'message_id' => $qb->createNamedParameter('<c2@thread.com>'),
				'mailbox_id' => $qb->createNamedParameter(3, IQueryBuilder::PARAM_INT),
				'subject' => $qb->createNamedParameter('Re: Thread C'),
				'sent_at' => $qb->createNamedParameter(5000, IQueryBuilder::PARAM_INT),
				'thread_root_id' => $qb->createNamedParameter('thread-c'),
				'flag_seen' => $qb->createNamedParameter(true, IQueryBuilder::PARAM_BOOL),
				'flag_flagged' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
				'flag_important' => $qb->createNamedParameter(false, IQueryBuilder::PARAM_BOOL),
			],
		];

		foreach ($values as $value) {
			$insert = $qb->insert($this->mapper->getTableName())->values($value);
			$insert->executeStatement();
		}

		$messages = $this->mapper->findByIds('test-user', [20, 21, 22, 23, 24], 'ASC');
		$hasUnseenById = [];
		$hasFlaggedById = [];
		$hasImportantById = [];
		foreach ($messages as $message) {
			$hasUnseenById[$message->getId()] = $message->getHasUnseenInThread();
			$hasFlaggedById[$message->getId()] = $message->getHasFlaggedInThread();
			$hasImportantById[$message->getId()] = $message->getHasImportantInThread();
		}

		self::assertTrue($hasUnseenById[20], 'the older, actually-unseen message in thread A');
		self::assertTrue($hasUnseenById[21], "thread A's newest (seen) reply -- its thread still has an unseen message");
		self::assertTrue($hasUnseenById[22], 'the standalone unseen message');
		self::assertFalse($hasUnseenById[23], "thread C's older message -- thread C has no unseen message");
		self::assertFalse($hasUnseenById[24], "thread C's newest message -- thread C has no unseen message");
		self::assertTrue($hasFlaggedById[20]);
		self::assertTrue($hasFlaggedById[21], "thread A's newest reply inherits the older member's favorite status");
		self::assertTrue($hasImportantById[20], "thread A's older message inherits the newest member's importance");
		self::assertTrue($hasImportantById[21]);
		self::assertFalse($hasFlaggedById[22]);
		self::assertFalse($hasImportantById[22]);
		self::assertFalse($hasFlaggedById[23]);
		self::assertFalse($hasImportantById[24]);
	}

	public function testDeleteByUid(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(1);
		array_map(function ($i) {
			$this->insertMessage($i, 1);
		}, range(1, 10));

		$this->mapper->deleteByUid($mailbox, 1, 5);

		$messages = $this->mapper->findByUids($mailbox, range(1, 10));
		self::assertCount(8, $messages);
	}

	public function testDeleteDuplicateUids(): void {
		$mailbox1 = new Mailbox();
		$mailbox1->setId(1);
		$mailbox2 = new Mailbox();
		$mailbox2->setId(2);
		$mailbox3 = new Mailbox();
		$mailbox3->setId(3);
		$this->insertMessage(100, 1);
		$this->insertMessage(101, 1);
		$this->insertMessage(101, 1);
		$this->insertMessage(102, 1);
		$this->insertMessage(102, 1);
		$this->insertMessage(102, 1);
		$this->insertMessage(103, 2);
		$this->insertMessage(104, 2);
		$this->insertMessage(104, 2);
		$this->insertMessage(105, 3);

		$this->mapper->deleteDuplicateUids();

		self::assertCount(1, $this->mapper->findByUids($mailbox1, [100]));
		self::assertCount(1, $this->mapper->findByUids($mailbox1, [101]));
		self::assertCount(1, $this->mapper->findByUids($mailbox1, [102]));
		self::assertCount(1, $this->mapper->findByUids($mailbox2, [103]));
		self::assertCount(1, $this->mapper->findByUids($mailbox2, [104]));
		self::assertCount(1, $this->mapper->findByUids($mailbox3, [105]));
	}

	public function testFindIdsAfter() : void {
		$mailbox = new Mailbox();
		$mailbox->setId(4);
		$this->timestamp = 1234567890;
		array_map(function ($i) use ($mailbox) {
			$this->insertMessageWithId($i, $mailbox->getId());
		}, range(1, 5));
		$this->timestamp = 1234567891 + 100;
		array_map(function ($i) use ($mailbox) {
			$this->insertMessageWithId($i, $mailbox->getId());
		}, range(6, 10));

		$mails = $this->mapper->findIdsAfter($mailbox, 2, 0, 5);
		$this->assertEquals([3,4,5,6,7], $mails);

		$mails = $this->mapper->findIdsAfter($mailbox, 2, 1234567890, 5);
		$this->assertEquals([6,7,8,9,10], $mails);

		$mails = $this->mapper->findIdsAfter($mailbox, 2, 1234567890 + 200, 5);
		$this->assertEquals([], $mails);
	}

	public function testFindAllIdsCapsAndOrdersInsteadOfDumpingTheWholeMailbox(): void {
		// A cold-start sync (empty knownIds) has nothing to diff against --
		// this is the bounded replacement for what used to be an
		// unconditional "return every message the mailbox has ever
		// received" (see SyncService::COLD_START_SYNC_LIMIT).
		$mailbox = new Mailbox();
		$mailbox->setId(5);
		foreach (range(1, 10) as $i) {
			$this->timestamp = 1234567890 + $i;
			$this->insertMessageWithId($i, $mailbox->getId());
		}

		$newest3 = $this->mapper->findAllIds($mailbox, IMailSearch::ORDER_NEWEST_FIRST, 3);
		$this->assertEquals([10, 9, 8], $newest3);

		$oldest3 = $this->mapper->findAllIds($mailbox, IMailSearch::ORDER_OLDEST_FIRST, 3);
		$this->assertEquals([1, 2, 3], $oldest3);

		// A limit larger than the mailbox's actual message count returns
		// everything, not an error or a padded/truncated result.
		$all = $this->mapper->findAllIds($mailbox, IMailSearch::ORDER_NEWEST_FIRST, 100);
		$this->assertCount(10, $all);
	}

	/**
	 * Regression: ORDER BY sent_at alone, with no secondary/tiebreaker
	 * column, combined with a LIMIT smaller than the number of tied
	 * rows, is free under Postgres/MySQL to return a DIFFERENT subset of
	 * those tied rows on each otherwise-identical call -- since nothing
	 * about the query changed between calls, only the database's own
	 * arbitrary tie-resolution did. Confirmed live: Priority Inbox
	 * sections (Important, Favorites, and the unbounded-display "Other"
	 * section alike) visibly cycling between different message sets on
	 * every sync tick, completely unrelated to any new mail arriving and
	 * unrelated to threading -- exactly the signature of this bug, once
	 * these sections started actually syncing on every tick instead of
	 * rarely at all.
	 */
	public function testFindAllIdsBreaksSentAtTiesDeterministically(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(7);
		// All ten messages share the exact same sent_at -- a plausible,
		// ordinary occurrence (a mailing-list digest, several recipients
		// on one send), not a contrived edge case.
		$this->timestamp = 1234567890;
		foreach (range(1, 10) as $i) {
			$this->insertMessageWithId($i, $mailbox->getId());
		}

		$first = $this->mapper->findAllIds($mailbox, IMailSearch::ORDER_NEWEST_FIRST, 3);
		for ($i = 0; $i < 5; $i++) {
			$this->assertEquals($first, $this->mapper->findAllIds($mailbox, IMailSearch::ORDER_NEWEST_FIRST, 3), 'the same tied rows should be returned on every repeated call');
		}
		// The tiebreaker (id, same direction as sent_at) makes "newest
		// first" among same-second messages mean "highest id first" --
		// deterministic, not merely stable.
		$this->assertEquals([10, 9, 8], $first);
	}

	public function testFindAllIdsOnAnEmptyMailboxReturnsNothing(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(6);

		$this->assertEquals([], $this->mapper->findAllIds($mailbox, IMailSearch::ORDER_NEWEST_FIRST, 50));
	}
}
