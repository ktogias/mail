<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2017 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\IMAP\Sync;

use Horde_Imap_Client;
use Horde_Imap_Client_Base;
use Horde_Imap_Client_Exception;
use Horde_Imap_Client_Exception_Sync;
use Horde_Imap_Client_Ids;
use Horde_Imap_Client_Mailbox;
use OCA\Mail\Cache\HordeSyncTokenParser;
use OCA\Mail\Exception\MailboxDoesNotSupportModSequencesException;
use OCA\Mail\Exception\UidValidityChangedException;
use OCA\Mail\IMAP\MessageMapper;
use Psr\Log\LoggerInterface;
use function array_intersect;
use function array_map;
use function array_merge;
use function array_values;
use function OCA\Mail\chunk_uid_sequence;

class Synchronizer {
	/**
	 * This determines how many UIDs we send to IMAP for a check of changed or
	 * vanished messages. The number needs a balance between good performance
	 * (few chunks) and staying below the IMAP command size limits. 15k has
	 * shown to cause IMAP errors for some accounts where the UID list can't be
	 * compressed much by Horde.
	 */
	private const UID_CHUNK_MAX_BYTES = 10000;

	private ?string $requestId = null;
	private ?Response $response = null;

	public function __construct(
		private MessageMapper $messageMapper,
		private HordeSyncTokenParser $syncTokenParser,
	) {
	}

	/**
	 * @return Response
	 * @throws Horde_Imap_Client_Exception
	 * @throws Horde_Imap_Client_Exception_Sync
	 * @throws UidValidityChangedException
	 * @throws MailboxDoesNotSupportModSequencesException
	 */
	public function sync(Horde_Imap_Client_Base $imapClient,
		Request $request,
		string $userId,
		bool $hasQresync, // TODO: query client directly, but could be unsafe because login has to happen prior
		LoggerInterface $logger,
		int $criteria = Horde_Imap_Client::SYNC_NEWMSGSUIDS | Horde_Imap_Client::SYNC_FLAGSUIDS | Horde_Imap_Client::SYNC_VANISHEDUIDS): Response {
		// Return cached response from last full sync when QRESYNC is enabled
		if ($hasQresync && $this->response !== null && $request->getId() === $this->requestId) {
			$logger->debug('Reusing cached sync response');
			return $this->response;
		}

		$mailbox = new Horde_Imap_Client_Mailbox($request->getMailbox());
		try {
			// Do a full sync and cache the response when QRESYNC is enabled
			[$newUids, $changedUids, $vanishedUids] = match ($hasQresync) {
				true => $this->doCombinedSync($imapClient, $mailbox, $request, $logger),
				false => $this->doSplitSync($imapClient, $mailbox, $request, $criteria, $logger),
			};
		} catch (Horde_Imap_Client_Exception_Sync $e) {
			$logger->info('UID validity changed');
			if ($e->getCode() === Horde_Imap_Client_Exception_Sync::UIDVALIDITY_CHANGED) {
				throw new UidValidityChangedException();
			}
			throw $e;
		} catch (Horde_Imap_Client_Exception $e) {
			if ($e->getCode() === Horde_Imap_Client_Exception::MBOXNOMODSEQ) {
				throw new MailboxDoesNotSupportModSequencesException($e->getMessage(), $e->getCode(), $e);
			}
			throw $e;
		}

		$logger->debug('Fetching new and changed messages after sync');
		$newMessages = $this->messageMapper->findByIds($imapClient, $request->getMailbox(), $newUids, $userId);
		$nNew = count($newMessages);
		$logger->debug("Found {$nNew} new messages");
		$changedMessages = $this->messageMapper->findByIds($imapClient, $request->getMailbox(), $changedUids, $userId);
		$nChanged = count($changedMessages);
		$logger->debug("Found {$nChanged} changed messages");
		$vanishedMessageUids = $vanishedUids;

		$this->requestId = $request->getId();
		$this->response = new Response($newMessages, $changedMessages, $vanishedMessageUids, null);
		return $this->response;
	}

	/**
	 * @psalm-return list{Horde_Imap_Client_Ids, Horde_Imap_Client_Ids, int[]} [$newUids, $changedUids, $vanishedUids]
	 * @throws Horde_Imap_Client_Exception
	 * @throws Horde_Imap_Client_Exception_Sync
	 */
	private function doCombinedSync(Horde_Imap_Client_Base $imapClient,
		Horde_Imap_Client_Mailbox $mailbox,
		Request $request,
		LoggerInterface $logger): array {
		$logger->debug('Performing a combined sync');

		$syncData = $imapClient->sync($mailbox, $request->getToken(), [
			'criteria' => Horde_Imap_Client::SYNC_ALL,
		]);

		$logger->debug('Combined sync finished');

		return [
			$syncData->newmsgsuids,
			$syncData->flagsuids,
			$syncData->vanisheduids->ids,
		];
	}

	/**
	 * @psalm-return list{Horde_Imap_Client_Ids|array, Horde_Imap_Client_Ids|array, int[]} [$newUids, $changedUids, $vanishedUids]
	 * @throws Horde_Imap_Client_Exception
	 * @throws Horde_Imap_Client_Exception_Sync
	 */
	private function doSplitSync(Horde_Imap_Client_Base $imapClient,
		Horde_Imap_Client_Mailbox $mailbox,
		Request $request,
		int $criteria,
		LoggerInterface $logger): array {
		$logger->debug('Performing a split sync');

		if ($criteria & Horde_Imap_Client::SYNC_NEWMSGSUIDS) {
			$newUids = $this->getNewMessageUids($imapClient, $mailbox, $request);
		} else {
			$newUids = [];
		}
		if ($criteria & Horde_Imap_Client::SYNC_FLAGSUIDS) {
			$changedUids = $this->getChangedMessageUids($imapClient, $mailbox, $request);
		} else {
			$changedUids = [];
		}
		if ($criteria & Horde_Imap_Client::SYNC_VANISHEDUIDS) {
			$vanishedUids = $this->getVanishedMessageUids($imapClient, $mailbox, $request);
		} else {
			$vanishedUids = [];
		}

		return [$newUids, $changedUids, $vanishedUids];
	}

	/**
	 * @param Horde_Imap_Client_Base $imapClient
	 * @param Horde_Imap_Client_Mailbox $mailbox
	 * @param Request $request
	 *
	 * @return Horde_Imap_Client_Ids
	 * @throws Horde_Imap_Client_Exception
	 * @throws Horde_Imap_Client_Exception_Sync
	 */
	private function getNewMessageUids(Horde_Imap_Client_Base $imapClient, Horde_Imap_Client_Mailbox $mailbox, Request $request): Horde_Imap_Client_Ids {
		return $imapClient->sync($mailbox, $request->getToken(), [
			'criteria' => Horde_Imap_Client::SYNC_NEWMSGSUIDS,
		])->newmsgsuids;
	}

	/**
	 * @param Horde_Imap_Client_Base $imapClient
	 * @param Horde_Imap_Client_Mailbox $mailbox
	 * @param Request $request
	 *
	 * @return Horde_Imap_Client_Ids
	 */
	private function getChangedMessageUids(Horde_Imap_Client_Base $imapClient, Horde_Imap_Client_Mailbox $mailbox, Request $request): Horde_Imap_Client_Ids {
		// With CONDSTORE enabled and a HIGHESTMODSEQ-bearing sync token, the
		// server can compute the changed set itself: Horde turns an
		// unrestricted FLAGSUIDS sync into a single SEARCH MODSEQ round
		// trip. The result is not limited to the UIDs we know about, so it
		// is intersected with them locally -- an unknown changed UID is a
		// new message, which is the new-messages phase's job. The chunked
		// fallback below instead ships every known UID to the server in
		// ~10KB slices, one command per slice: measured at ~10s per poll
		// for a 26.9k-message Gmail INBOX, entirely round-trip-bound.
		if ($imapClient->capability->isEnabled('CONDSTORE')
			&& $this->syncTokenParser->parseSyncToken($request->getToken())->getHighestModSeq() !== null) {
			$chunks = chunk_uid_sequence($request->getUids(), self::UID_CHUNK_MAX_BYTES);
			if (count($chunks) === 1) {
				// The whole known-UID set fits one command: restrict the
				// MODSEQ search to it. Crucial for the web path, whose sync
				// token only advances on background (full-list) syncs -- an
				// unrestricted search there re-covered the entire window
				// since the last background sync on EVERY poll (measured:
				// 14-16s Horde time plus 6-7s persisting thousands of rows,
				// back to back, on the busy Gmail INBOX).
				return $imapClient->sync($mailbox, $request->getToken(), [
					'criteria' => Horde_Imap_Client::SYNC_FLAGSUIDS,
					'ids' => $chunks[0],
				])->flagsuids;
			}
			// Large known set (background sync): one unrestricted search
			// plus a local intersect still beats one command per ~10KB
			// UID chunk.
			$changed = $imapClient->sync($mailbox, $request->getToken(), [
				'criteria' => Horde_Imap_Client::SYNC_FLAGSUIDS,
			])->flagsuids;
			return new Horde_Imap_Client_Ids(array_values(array_intersect(
				array_map('intval', $changed->ids),
				$request->getUids(),
			)));
		}

		// Without QRESYNC we need to specify the known ids and in order to avoid
		// overly long IMAP commands they have to be chunked.
		$combined = new Horde_Imap_Client_Ids();
		foreach (chunk_uid_sequence($request->getUids(), self::UID_CHUNK_MAX_BYTES) as $chunk) {
			$syncResult = $imapClient->sync($mailbox, $request->getToken(), [
				'criteria' => Horde_Imap_Client::SYNC_FLAGSUIDS,
				'ids' => $chunk,
			]);
			$combined->add($syncResult->flagsuids);
		}
		return $combined;
	}

	/**
	 * @param Horde_Imap_Client_Base $imapClient
	 * @param Horde_Imap_Client_Mailbox $mailbox
	 * @param Request $request
	 *
	 * @return array
	 */
	private function getVanishedMessageUids(Horde_Imap_Client_Base $imapClient, Horde_Imap_Client_Mailbox $mailbox, Request $request): array {
		// Without QRESYNC we need to specify the known ids and in order to avoid
		// overly long IMAP commands they have to be chunked.
		return array_merge(
			[], // for php<7.4 https://www.php.net/manual/en/function.array-merge.php
			...array_map(
				static fn (Horde_Imap_Client_Ids $uids) => $imapClient->sync($mailbox, $request->getToken(), [
					'criteria' => Horde_Imap_Client::SYNC_VANISHEDUIDS,
					'ids' => $uids,
				])->vanisheduids->ids,
				chunk_uid_sequence($request->getUids(), self::UID_CHUNK_MAX_BYTES)
			)
		);
	}
}
