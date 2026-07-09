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
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Db\TagMapper;
use OCA\Mail\Service\Search\Flag;
use OCA\Mail\Service\Search\SearchQuery;
use OCA\Mail\Support\PerformanceLogger;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use function array_map;
use function range;
use function time;

class MessageMapperTest extends TestCase {
	use DatabaseTransaction;

	/** @var IDBConnection */
	private $db;

	/** @var ITimeFactory */
	private $time;

	private int $timestamp = 1234567890;

	/** @var MessageMapper */
	private $mapper;

	protected function setUp(): void {
		parent::setUp();

		$this->db = \OCP\Server::get(\OCP\IDBConnection::class);
		$this->time = $this->createMock(ITimeFactory::class);
		$this->time->method('getTime')->willReturnCallback(fn () => $this->timestamp);
		$tagMapper = $this->createMock(TagMapper::class);
		$performanceLogger = $this->createMock(PerformanceLogger::class);
		$this->mapper = new MessageMapper(
			$this->db,
			$this->time,
			$tagMapper,
			$performanceLogger
		);

		$qb = $this->db->getQueryBuilder();

		$delete = $qb->delete($this->mapper->getTableName());
		$delete->executeStatement();
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
	 * any unseen message -- not just whether the loaded message itself is
	 * unseen -- so the frontend can show a thread's row as unread even when
	 * only an older message (not the one actually displayed) is unseen.
	 */
	public function testFindByIdsAnnotatesHasUnseenInThread(): void {
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
			],
		];

		foreach ($values as $value) {
			$insert = $qb->insert($this->mapper->getTableName())->values($value);
			$insert->executeStatement();
		}

		$messages = $this->mapper->findByIds('test-user', [20, 21, 22, 23, 24], 'ASC');
		$hasUnseenById = [];
		foreach ($messages as $message) {
			$hasUnseenById[$message->getId()] = $message->getHasUnseenInThread();
		}

		self::assertTrue($hasUnseenById[20], 'the older, actually-unseen message in thread A');
		self::assertTrue($hasUnseenById[21], "thread A's newest (seen) reply -- its thread still has an unseen message");
		self::assertTrue($hasUnseenById[22], 'the standalone unseen message');
		self::assertFalse($hasUnseenById[23], "thread C's older message -- thread C has no unseen message");
		self::assertFalse($hasUnseenById[24], "thread C's newest message -- thread C has no unseen message");
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

	public function testFindAllIdsOnAnEmptyMailboxReturnsNothing(): void {
		$mailbox = new Mailbox();
		$mailbox->setId(6);

		$this->assertEquals([], $this->mapper->findAllIds($mailbox, IMailSearch::ORDER_NEWEST_FIRST, 50));
	}
}
