<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\BackgroundJob;

use ChristophWurst\Nextcloud\Testing\ServiceMockObject;
use ChristophWurst\Nextcloud\Testing\TestCase;
use Horde_Imap_Client_Socket;
use OC\BackgroundJob\JobList;
use OCA\Mail\Account;
use OCA\Mail\BackgroundJob\BackfillJob;
use OCA\Mail\Db\MailAccount;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Exception\IncompleteSyncException;
use OCA\Mail\Exception\MailboxLockedException;
use OCA\Mail\IMAP\ImapWorkClass;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\IUser;

class BackfillJobTest extends TestCase {
	/** @var ServiceMockObject */
	private $serviceMock;

	/** @var BackfillJob */
	private $job;

	protected function setUp(): void {
		parent::setUp();

		$this->serviceMock = $this->createServiceMock(BackfillJob::class);
		$this->job = $this->serviceMock->getService();

		// 15-minute interval + 1s, so the job is actually run.
		$this->serviceMock->getParameter('time')
			->method('getTime')
			->willReturn(15 * 60 + 1);

		$this->job->setArgument([
			'accountId' => 123,
		]);
	}

	// Mailbox::getId()/setSelectable() are magic accessors (Entity's
	// __call(), backed by addType()-declared properties) -- not real
	// declared methods, so createMock() can't configure them directly.
	// Real instances with real setters, same as ImapToDbSynchronizerTest's
	// own buildPartialSyncMailbox().
	//
	// Background sync is on by default here because that is what makes a
	// mailbox eligible for backfill at all -- see
	// ImapToDbSynchronizer::isInBackgroundSyncScope().
	private function mailbox(
		int $id,
		bool $cached,
		bool $selectable = true,
		bool $syncInBackground = true,
		?string $name = null,
	): Mailbox {
		$mailbox = new Mailbox();
		$mailbox->setId($id);
		$mailbox->setName($name ?? "folder{$id}");
		$mailbox->setSelectable($selectable);
		$mailbox->setSyncInBackground($syncInBackground);
		if ($cached) {
			$mailbox->setSyncNewToken('token');
			$mailbox->setSyncChangedToken('token');
			$mailbox->setSyncVanishedToken('token');
		}
		return $mailbox;
	}

	private function account(): Account&\PHPUnit\Framework\MockObject\MockObject {
		$mailAccount = $this->createConfiguredMock(MailAccount::class, [
			'canAuthenticateImap' => true,
		]);
		return $this->createConfiguredMock(Account::class, [
			'getId' => 123,
			'getUserId' => 'user123',
			'getMailAccount' => $mailAccount,
		]);
	}

	public function testAccountDoesntExist(): void {
		$this->serviceMock->getParameter('accountService')
			->expects(self::once())
			->method('findById')
			->with(123)
			->willThrowException(new DoesNotExistException(''));
		$this->serviceMock->getParameter('logger')
			->expects(self::once())
			->method('debug')
			->with('Could not find account <123> removing from jobs');
		$this->serviceMock->getParameter('jobList')
			->expects(self::once())
			->method('remove')
			->with(BackfillJob::class, ['accountId' => 123]);
		$this->serviceMock->getParameter('mailboxMapper')
			->expects(self::never())
			->method('findAll');

		$this->job->setLastRun(0);
		$this->job->start($this->createMock(JobList::class));
	}

	public function testNoImapAuthentication(): void {
		$mailAccount = $this->createConfiguredMock(MailAccount::class, [
			'canAuthenticateImap' => false,
		]);
		$account = $this->createConfiguredMock(Account::class, [
			'getId' => 123,
			'getMailAccount' => $mailAccount,
		]);
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($account);
		$this->serviceMock->getParameter('mailboxMapper')
			->expects(self::never())
			->method('findAll');

		$this->job->start($this->createMock(JobList::class));
	}

	public function testUserDisabled(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$user = $this->createConfiguredMock(IUser::class, ['isEnabled' => false]);
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->with('user123')
			->willReturn($user);
		$this->serviceMock->getParameter('mailboxMapper')
			->expects(self::never())
			->method('findAll');

		$this->job->start($this->createMock(JobList::class));
	}

	public function testSkipsTheTickWhenTheServerIsBusy(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(true);
		$this->serviceMock->getParameter('mailboxMapper')
			->expects(self::never())
			->method('findAll');

		$this->job->start($this->createMock(JobList::class));
	}

	/**
	 * isServerBusy() only sees CONCURRENCY instance-wide and never caught
	 * this job's own IMAP activity in the first place (it calls the
	 * synchronizer directly, bypassing SyncService::syncMailbox() and its
	 * load counter entirely). This second, per-account check catches
	 * LATENCY instead -- confirmed live (account 13/Gmail, 2026-07-12):
	 * mailbox 149's own sync regularly ran 15-38s while this job kept
	 * adding its own connections against the same account regardless.
	 */
	public function testSkipsTheTickWhenTheAccountIsRespondingSlowly(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$this->serviceMock->getParameter('syncService')
			->expects(self::once())
			->method('isAccountResponseSlow')
			->with(123)
			->willReturn(true);
		$this->serviceMock->getParameter('mailboxMapper')
			->expects(self::never())
			->method('findAll');

		$this->job->start($this->createMock(JobList::class));
	}

	public function testNothingToBackfillTouchesNoMailbox(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$this->serviceMock->getParameter('mailboxMapper')
			->method('findAll')
			->willReturn([
				$this->mailbox(1, true),
				$this->mailbox(2, true),
			]);
		$this->serviceMock->getParameter('clientFactory')
			->expects(self::never())
			->method('getClient');

		$this->job->start($this->createMock(JobList::class));
	}

	/**
	 * No cursor persisted yet (a fresh account, or one that just finished
	 * a full rotation) -- picks the lowest-id incomplete mailbox first.
	 */
	public function testPicksTheFirstIncompleteMailboxWhenNoCursorIsSet(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$mailboxA = $this->mailbox(50, false);
		$mailboxB = $this->mailbox(190, false);
		$this->serviceMock->getParameter('mailboxMapper')
			->method('findAll')
			->willReturn([$mailboxB, $mailboxA]);
		$this->serviceMock->getParameter('config')
			->method('getUserValue')
			->with('user123', 'mail', 'backfill-last-mailbox-123', '0')
			->willReturn('0');
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->serviceMock->getParameter('clientFactory')
			->method('getClient')
			->willReturn($client);
		$this->serviceMock->getParameter('synchronizer')
			->expects(self::once())
			->method('sync')
			->with(
				self::anything(),
				$client,
				$mailboxA,
				self::anything(),
				self::anything(),
				self::anything(),
				self::anything(),
				// batchSync. Without it every tick ends by dispatching
				// SynchronizationEvent, whose listener rebuilds the whole
				// account's thread tree: measured live at 274MB and ~6s for
				// 169,970 messages, in cron, every 15 minutes, for one batch
				// of old mail nobody is waiting on. syncAccount() already
				// passes this for its own per-mailbox calls.
				true,
			)
			->willThrowException(new IncompleteSyncException('still going'));
		$this->serviceMock->getParameter('config')
			->expects(self::once())
			->method('setUserValue')
			->with('user123', 'mail', 'backfill-last-mailbox-123', '50');

		$this->job->start($this->createMock(JobList::class));
	}

	/**
	 * Round robin: the cursor points at the mailbox already advanced last
	 * time, so this tick must move on to the NEXT incomplete one, not
	 * repeat the same one.
	 */
	public function testAdvancesToTheNextMailboxAfterTheCursor(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$mailboxA = $this->mailbox(50, false);
		$mailboxB = $this->mailbox(190, false);
		$this->serviceMock->getParameter('mailboxMapper')
			->method('findAll')
			->willReturn([$mailboxA, $mailboxB]);
		$this->serviceMock->getParameter('config')
			->method('getUserValue')
			->with('user123', 'mail', 'backfill-last-mailbox-123', '0')
			->willReturn('50');
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->serviceMock->getParameter('clientFactory')
			->method('getClient')
			->willReturn($client);
		$this->serviceMock->getParameter('synchronizer')
			->expects(self::once())
			->method('sync')
			->with(self::anything(), $client, $mailboxB, self::anything())
			->willThrowException(new IncompleteSyncException('still going'));
		$this->serviceMock->getParameter('config')
			->expects(self::once())
			->method('setUserValue')
			->with('user123', 'mail', 'backfill-last-mailbox-123', '190');

		$this->job->start($this->createMock(JobList::class));
	}

	/**
	 * The cursor points past every remaining incomplete mailbox (the one
	 * it pointed at finished, or was the highest id) -- wrap back to the
	 * start of the rotation instead of doing nothing.
	 */
	public function testWrapsAroundWhenTheCursorIsPastEveryRemainingMailbox(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$mailboxA = $this->mailbox(50, false);
		$this->serviceMock->getParameter('mailboxMapper')
			->method('findAll')
			->willReturn([$mailboxA]);
		$this->serviceMock->getParameter('config')
			->method('getUserValue')
			->willReturn('190');
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->serviceMock->getParameter('clientFactory')
			->method('getClient')
			->willReturn($client);
		$this->serviceMock->getParameter('synchronizer')
			->expects(self::once())
			->method('sync')
			->with(self::anything(), $client, $mailboxA, self::anything())
			->willThrowException(new IncompleteSyncException('still going'));

		$this->job->start($this->createMock(JobList::class));
	}

	/**
	 * Confirmed live: a mailbox this job picked was concurrently being
	 * synced by a leftover manual process, hitting MailboxLockedException.
	 * No progress was made on that mailbox, so the cursor must NOT
	 * advance past it -- otherwise it would be skipped for an entire
	 * rotation instead of retried on the very next (soon) tick.
	 */
	public function testRetriesALockedMailboxWithoutAdvancingTheCursor(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$mailboxA = $this->mailbox(50, false);
		$this->serviceMock->getParameter('mailboxMapper')
			->method('findAll')
			->willReturn([$mailboxA]);
		$this->serviceMock->getParameter('config')
			->method('getUserValue')
			->willReturn('0');
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->serviceMock->getParameter('clientFactory')
			->method('getClient')
			->willReturn($client);
		$this->serviceMock->getParameter('synchronizer')
			->expects(self::once())
			->method('sync')
			->willThrowException(MailboxLockedException::from($mailboxA));
		$client->expects(self::once())->method('logout');
		$this->serviceMock->getParameter('config')
			->expects(self::never())
			->method('setUserValue');

		$this->job->start($this->createMock(JobList::class));
	}

	/**
	 * sync() returning without IncompleteSyncException means this
	 * mailbox just finished its initial sync -- must not crash, and the
	 * cursor still advances normally (the mailbox naturally drops out of
	 * the rotation next tick since isCached() will be true by then).
	 */
	public function testMailboxFinishingDoesNotCrash(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$mailboxA = $this->mailbox(50, false);
		$this->serviceMock->getParameter('mailboxMapper')
			->method('findAll')
			->willReturn([$mailboxA]);
		$this->serviceMock->getParameter('config')
			->method('getUserValue')
			->willReturn('0');
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->serviceMock->getParameter('clientFactory')
			->method('getClient')
			->willReturn($client);
		$this->serviceMock->getParameter('synchronizer')
			->expects(self::once())
			->method('sync')
			->willReturn(true);
		$client->expects(self::once())->method('logout');
		$this->serviceMock->getParameter('config')
			->expects(self::once())
			->method('setUserValue')
			->with('user123', 'mail', 'backfill-last-mailbox-123', '50');

		$this->job->start($this->createMock(JobList::class));
	}

	/**
	 * This job never goes through SyncService::syncMailbox(), so it's the
	 * only place its own IMAP activity gets timed for
	 * isAccountResponseSlow() -- feeds the very signal
	 * testSkipsTheTickWhenTheAccountIsRespondingSlowly() checks, so a slow
	 * tick here makes the NEXT one (for this account) back off too.
	 * Recorded regardless of outcome (an IncompleteSyncException here is
	 * still a real, completed IMAP round trip, just as informative as a
	 * finished one).
	 */
	public function testRecordsItsOwnSyncDurationRegardlessOfOutcome(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$mailboxA = $this->mailbox(50, false);
		$this->serviceMock->getParameter('mailboxMapper')
			->method('findAll')
			->willReturn([$mailboxA]);
		$this->serviceMock->getParameter('config')
			->method('getUserValue')
			->willReturn('0');
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->serviceMock->getParameter('clientFactory')
			->method('getClient')
			->willReturn($client);
		$this->serviceMock->getParameter('synchronizer')
			->method('sync')
			->willThrowException(new IncompleteSyncException('still going'));
		$this->serviceMock->getParameter('syncService')
			->expects(self::once())
			->method('recordSyncDuration')
			->with(123, self::isType('float'));

		$this->job->start($this->createMock(JobList::class));
	}

	/**
	 * A mailbox that isn't selectable (can't be opened at all) must never
	 * be handed to the synchronizer, cached or not.
	 */
	public function testSkipsNonSelectableMailboxes(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$this->serviceMock->getParameter('mailboxMapper')
			->method('findAll')
			->willReturn([
				$this->mailbox(1, false, false),
			]);
		$this->serviceMock->getParameter('clientFactory')
			->expects(self::never())
			->method('getClient');

		$this->job->start($this->createMock(JobList::class));
	}

	/**
	 * Finishing the initial sync of a mailbox that syncAccount() then skips
	 * on every tick buys a copy nothing keeps fresh, at the price of one IMAP
	 * login and one 5000-message batch per rotation slot. On the account that
	 * exposed this, every incomplete mailbox was of this kind -- 5.9M messages,
	 * led by a 3.1M-message Gmail "All Mail" that can never complete.
	 */
	/**
	 * MAINTENANCE work is granted zero wait, so this job used to ask for a
	 * connection slot, find the sync lane busy and abandon the whole tick --
	 * for fifteen minutes, with nothing to show for it.
	 *
	 * Confirmed live on 2026-07-28, minutes after background sync was enabled
	 * for six large folders: every tick logged "IMAP account concurrency limit
	 * reached" while the incremental sync of those same folders held the lane,
	 * and the backfill advanced nothing at all.
	 *
	 * The work class must stay MAINTENANCE: waiting buys patience in the sync
	 * lane, never a borrowed slot from what the user is looking at.
	 */
	public function testWaitsForAConnectionSlotInTheSyncLane(): void {
		$account = $this->account();
		$this->serviceMock->getParameter('accountService')->method('findById')->willReturn($account);
		$this->serviceMock->getParameter('userManager')->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')->method('isServerBusy')->willReturn(false);
		$this->serviceMock->getParameter('mailboxMapper')->method('findAll')
			->willReturn([$this->mailbox(1, false)]);
		$this->serviceMock->getParameter('clientFactory')
			->expects(self::once())
			->method('getClient')
			->with($account, true, false, true, ImapWorkClass::MAINTENANCE)
			->willReturn($this->createMock(Horde_Imap_Client_Socket::class));

		$this->job->start($this->createMock(JobList::class));
	}

	public function testSkipsMailboxesExcludedFromBackgroundSync(): void {
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($this->account());
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$this->serviceMock->getParameter('mailboxMapper')
			->method('findAll')
			->willReturn([
				$this->mailbox(1, false, true, false),
			]);
		$this->serviceMock->getParameter('clientFactory')
			->expects(self::never())
			->method('getClient');

		$this->job->start($this->createMock(JobList::class));
	}

	/**
	 * The INBOX is always in scope, whether or not the per-mailbox background
	 * sync toggle was ever touched -- so the scope check above must not stop
	 * the one mailbox this job most needs to finish.
	 */
	public function testBackfillsAnIncompleteInboxWithoutTheBackgroundSyncFlag(): void {
		$account = $this->account();
		$inbox = $this->mailbox(1, false, true, false, 'INBOX');
		$this->serviceMock->getParameter('accountService')
			->method('findById')
			->willReturn($account);
		$this->serviceMock->getParameter('userManager')
			->method('get')
			->willReturn($this->createConfiguredMock(IUser::class, ['isEnabled' => true]));
		$this->serviceMock->getParameter('syncService')
			->method('isServerBusy')
			->willReturn(false);
		$this->serviceMock->getParameter('mailboxMapper')
			->method('findAll')
			->willReturn([$inbox]);
		$client = $this->createMock(Horde_Imap_Client_Socket::class);
		$this->serviceMock->getParameter('clientFactory')
			->method('getClient')
			->willReturn($client);
		$this->serviceMock->getParameter('synchronizer')
			->expects(self::once())
			->method('sync')
			->with($account, $client, $inbox);

		$this->job->start($this->createMock(JobList::class));
	}
}
