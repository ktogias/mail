<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Search;

use Horde_Imap_Client;
use OCA\Mail\Account;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Contracts\IUserPreferences;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\IMAP\PreviewEnhancer;
use OCA\Mail\IMAP\Search\Provider as ImapSearchProvider;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IUser;
use Throwable;
use function array_map;
use function array_values;
use function count;
use function hrtime;
use function mb_strlen;

class MailSearch implements IMailSearch {
	/**
	 * Past this many candidates the OR search has not narrowed enough for the
	 * per-word restricted searches to be worth their round trips.
	 *
	 * Generous on purpose. Falling back is the expensive outcome, not the
	 * cheap one: the OR round trip has already been paid and is then thrown
	 * away, so the combined search runs on top of it. Measured at a ceiling of
	 * 2,000 with 2,234 candidates -- 22.5 s, against 3.5 s for doing none of
	 * this. At 5,000 the same search took 6.5 s cold and 2.0 s warm.
	 *
	 * So the ceiling exists only to stop a pathological mailbox, not to tune
	 * the common case. Gmail's own variance -- the same search measured at
	 * 6.5 s and at 47 s minutes apart -- makes finer tuning meaningless.
	 */
	private const CANDIDATE_CEILING = 5000;

	/** @var ITimeFactory */
	private $timeFactory;

	public function __construct(
		private FilterStringParser $filterStringParser,
		private ImapSearchProvider $imapSearchProvider,
		private MessageMapper $messageMapper,
		private PreviewEnhancer $previewEnhancer,
		private SearchTelemetry $searchTelemetry,
		private IUserPreferences $preferences,
		ITimeFactory $timeFactory,
	) {
		$this->timeFactory = $timeFactory;
	}

	#[\Override]
	public function findMessage(Account $account,
		Mailbox $mailbox,
		Message $message): Message {
		$processed = $this->previewEnhancer->process(
			$account,
			$mailbox,
			[$message]
		);
		if ($processed === []) {
			throw new DoesNotExistException('Message does not exist');
		}
		return $processed[0];
	}

	/**
	 * @param Account $account
	 * @param Mailbox $mailbox
	 * @param string $sortOrder
	 * @param string|null $filter
	 * @param int|null $cursor
	 * @param int|null $limit
	 * @param string|null $view
	 * @param bool $prioritySplit return an exact page for each Priority Inbox section
	 *
	 * @return Message[]
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[\Override]
	public function findMessages(Account $account,
		Mailbox $mailbox,
		string $sortOrder,
		?string $filter,
		?int $cursor,
		?int $limit,
		?string $userId,
		?string $view,
		bool $prioritySplit = false,
		?int $cursorId = null): array {
		// A mailbox sync lock coordinates concurrent *writes* (two sync
		// attempts racing on the same mailbox). It was never a correctness
		// requirement for a *read* -- this method only ever reads from the
		// local DB below (aside from an unrelated body-text-search path),
		// so a mailbox mid-sync, or one whose lock happens to still be
		// genuinely fresh (not just a stale bug), can still be listed from
		// its already-cached messages instead of failing outright. Fixing
		// hasLocks() itself (see Mailbox.php) only stops a *stale* lock
		// from blocking forever -- it doesn't stop a legitimately fresh
		// one from unnecessarily blocking a read that never needed it.
		//
		// The same reasoning applies to isCached() itself, which used to
		// throw MailboxNotCachedException here and block EVERY read until
		// the entire mailbox finished its initial sync. Confirmed live: a
		// 773k-message mailbox needing ~155 batches to finish showed
		// "Could not open folder" for hours, even though a real (partial)
		// chunk of it -- everything a batch had already persisted -- sat
		// right there in the DB, perfectly readable. isCached() still
		// gates whether SyncService allows a partial-only *sync* (there's
		// no valid diff token yet, so that guard is legitimate), but a
		// *read* was never unsafe against a partial cache: findByIds()/
		// findIdsByQuery() just return however many matching rows
		// currently exist, same as they would for any other filtered
		// query that happens to match fewer messages than expected.
		$query = $this->buildQuery($mailbox, $filter, $cursor, $cursorId, $view);

		$started = hrtime(true);
		$resultCount = null;
		$status = 'ok';
		try {
			// liveEnhance=false: a folder listing must not block on live IMAP
			// work (structure analysis, attachment lookups) the way opening one
			// specific message (findMessage(), above) reasonably still does.
			$messages = $this->previewEnhancer->process(
				$account,
				$mailbox,
				$this->messageMapper->findByIds($account->getUserId(),
					$this->getIdsLocally($account, $mailbox, $query, $sortOrder, $limit, $prioritySplit),
					$sortOrder,
				),
				true,
				$userId,
				false
			);
			$resultCount = count($messages);
			return $messages;
		} catch (Throwable $e) {
			$status = 'error';
			throw $e;
		} finally {
			$this->searchTelemetry->record(
				$query,
				$mailbox,
				$sortOrder,
				$prioritySplit,
				$limit,
				hrtime(true) - $started,
				$resultCount,
				$status,
			);
		}
	}

	/**
	 * The mailbox's implicit conditions, on top of whatever the user typed.
	 *
	 * Extracted so that findUnmatchedTexts() probes the very same query the
	 * search it explains used. A probe that quietly omitted, say, the trash
	 * folder's deleted-message rule could report a word as unmatched while the
	 * real search would have matched it, which is worse than saying nothing.
	 */
	private function buildQuery(Mailbox $mailbox,
		?string $filter,
		?int $cursor,
		?int $cursorId,
		?string $view): SearchQuery {
		$query = $this->filterStringParser->parse($filter);
		if ($cursor !== null) {
			$query->setCursor($cursor);
			if ($cursorId !== null) {
				$query->setCursorId($cursorId);
			}
		}
		if ($view !== null) {
			$query->setThreaded($view === self::VIEW_THREADED);
		}
		// In flagged we don't want anything but flagged messages
		if ($mailbox->isSpecialUse(Horde_Imap_Client::SPECIALUSE_FLAGGED)) {
			$query->addFlag(Flag::is(Flag::FLAGGED));
		}
		// Don't show deleted messages except for trash folders
		if (!$mailbox->isSpecialUse(Horde_Imap_Client::SPECIALUSE_TRASH)) {
			$query->addFlag(Flag::not(Flag::DELETED));
		}
		return $query;
	}

	/**
	 * How many free-text words are worth probing.
	 *
	 * A search with more words than this is not a user wondering which one is
	 * wrong, and the probes are one query each.
	 */
	private const MAX_PROBED_TEXTS = 6;

	#[\Override]
	public function findUnmatchedTexts(Mailbox $mailbox,
		?string $filter,
		?string $view): array {
		$query = $this->buildQuery($mailbox, $filter, null, null, $view);
		$texts = $query->getTexts();
		// One word is its own explanation: the list is empty because that word
		// matched nothing, which the user can already see.
		if (count($texts) < 2 || count($texts) > self::MAX_PROBED_TEXTS) {
			return [];
		}

		$unmatched = [];
		foreach ($texts as $text) {
			$ids = $this->messageMapper->findIdsByQuery(
				$mailbox,
				$query->withOnlyText($text),
				self::ORDER_NEWEST_FIRST,
				1,
				null,
				false,
				// Never split into priority sections: the question is whether the
				// word occurs at all, not where it would be filed.
				false,
			);
			if ($ids === []) {
				$unmatched[] = $text;
			}
		}
		return $unmatched;
	}

	/**
	 * Find messages across all mailboxes for a user
	 *
	 * @return Message[]
	 *
	 * @throws ServiceException
	 */
	#[\Override]
	public function findMessagesGlobally(
		IUser $user,
		SearchQuery $query,
		?int $limit): array {
		return $this->messageMapper->findByIds($user->getUID(),
			$this->getIdsGlobally($user, $query, $limit),
			'DESC'
		);
	}

	/**
	 * We combine local flag and headers merge with UIDs that match the body search if necessary
	 *
	 * @throws ServiceException
	 */
	private function getIdsLocally(Account $account, Mailbox $mailbox, SearchQuery $query, string $sortOrder, ?int $limit, bool $prioritySplit): array {
		if (empty($query->getBodies()) || !$this->searchesBodies($account)) {
			return $this->messageMapper->findIdsByQuery($mailbox, $query, $sortOrder, $limit, null, false, $prioritySplit);
		}

		// A free-text search wants the body per WORD, so that a message with
		// `review` in its subject and `report` in its body matches
		// "review report". One combined SEARCH cannot express that: it means
		// "every word is in the body".
		//
		// Asking per word costs one full round trip each. Instead: one OR
		// search for the candidates, then one UID-RESTRICTED search per word
		// over them. Restricting by UID is the cheap axis -- measured at
		// ~1.25 ms per candidate against 6,507 ms for a full-mailbox search,
		// where restricting by DATE changes nothing at all.
		//
		// The candidate count is only known after the OR, so the decision is
		// made here rather than guessed: past the threshold the narrowing has
		// not paid for itself and the combined set is used as before.
		$resolutionStarted = hrtime(true);
		$termLengths = array_map(static fn (string $text) => mb_strlen($text), $query->getTexts());

		$texts = $query->getTexts();
		if ($texts !== []) {
			$candidates = $this->imapSearchProvider->findAnyMatch($account, $mailbox, $texts);
			if ($candidates !== [] && count($candidates) <= self::CANDIDATE_CEILING) {
				$uidsByText = [];
				foreach ($texts as $text) {
					$uidsByText[$text] = $this->imapSearchProvider->findMatchesWithinCandidates(
						$account, $mailbox, $text, $candidates,
					);
				}
				$this->searchTelemetry->recordBodyResolution(
					$mailbox,
					'two_step',
					count($candidates),
					$termLengths,
					array_map(static fn (array $uids) => count($uids), array_values($uidsByText)),
					0,
					hrtime(true) - $resolutionStarted,
				);
				return $this->messageMapper->findIdsByQuery(
					$mailbox, $query, $sortOrder, $limit, null, false, $prioritySplit, $uidsByText,
				);
			}
		}

		$fromImap = $this->imapSearchProvider->findMatches(
			$account,
			$mailbox,
			$query
		);
		$this->searchTelemetry->recordBodyResolution(
			$mailbox,
			$texts === [] ? 'no_free_text' : 'combined_fallback',
			isset($candidates) ? count($candidates) : 0,
			$termLengths,
			[],
			count($fromImap),
			hrtime(true) - $resolutionStarted,
		);
		return $this->messageMapper->findIdsByQuery($mailbox, $query, $sortOrder, $limit, $fromImap, false, $prioritySplit);
	}

	/**
	 * We combine local flag and headers merge with UIDs that match the body search if necessary
	 *
	 * @todo find a way to search across all mailboxes efficiently without iterating over each of them and include IMAP results
	 *
	 * @throws ServiceException
	 */
	private function getIdsGlobally(IUser $user, SearchQuery $query, ?int $limit): array {
		return $this->messageMapper->findIdsGloballyByQuery($user, $query, $limit);
	}

	/**
	 * Whether this account's bodies may be searched over IMAP.
	 *
	 * Until now this was decided in the client alone, which worked while a
	 * search only ever addressed one account. The unified inbox breaks that:
	 * one filter string fans out to every account, so either the client sent
	 * `body:` to all of them or -- what it actually did -- to none, and an
	 * account with the setting explicitly enabled silently never had its
	 * bodies searched there. A real search on 2026-08-28 returned nothing for
	 * a word that was in the message body of exactly such an account.
	 *
	 * Deciding it here instead lets the client ask for bodies unconditionally
	 * and each account answer for itself, which is the only place that knows.
	 * A body search is a full-mailbox IMAP SEARCH whose cost is the same for
	 * any date window (see the .107/.108 work), so this is a real protection
	 * and not a formality: fanning one out to an account that opted out would
	 * add seconds to every keystroke's worth of search.
	 *
	 * The user-level preference stays an override, because it is what the
	 * priority-inbox toggle promises: turn it on and bodies are searched
	 * there, whatever the individual accounts say.
	 */
	private function searchesBodies(Account $account): bool {
		if ($account->getMailAccount()->getSearchBody()) {
			return true;
		}

		return $this->preferences->getPreference(
			$account->getUserId(),
			'search-priority-body',
			'false',
		) === 'true';
	}
}
