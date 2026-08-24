<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2016-2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-FileCopyrightText: 2014-2016 ownCloud, Inc.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

namespace OCA\Mail\Controller;

use Exception;
use OC\Security\CSP\ContentSecurityPolicyNonceManager;
use OCA\Mail\Attachment;
use OCA\Mail\Contracts\IDkimService;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Contracts\IMailSearch;
use OCA\Mail\Contracts\IMailTransmission;
use OCA\Mail\Contracts\ITrustedSenderService;
use OCA\Mail\Contracts\IUserPreferences;
use OCA\Mail\Db\Message;
use OCA\Mail\Db\Tag;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\MessageSourceUnavailableException;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Http\AttachmentDownloadResponse;
use OCA\Mail\Http\HtmlResponse;
use OCA\Mail\Http\TrapError;
use OCA\Mail\IMAP\IMAPClientFactory;
use OCA\Mail\IMAP\ImapWorkClass;
use OCA\Mail\Model\SmimeData;
use OCA\Mail\Service\AccountService;
use OCA\Mail\Service\AiIntegrations\AiIntegrationsService;
use OCA\Mail\Service\ClientOperationService;
use OCA\Mail\Service\DelegationService;
use OCA\Mail\Service\InlineAttachmentCache;
use OCA\Mail\Service\ItineraryService;
use OCA\Mail\Service\SmimeService;
use OCA\Mail\Service\SnoozeService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\OpenAPI;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Http\ZipResponse;
use OCP\Files\Folder;
use OCP\Files\GenericFileException;
use OCP\Files\IFilenameValidator;
use OCP\Files\IMimeTypeDetector;
use OCP\Files\NotPermittedException;
use OCP\ICache;
use OCP\ICacheFactory;
use OCP\IL10N;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\Lock\LockedException;
use Psr\Log\LoggerInterface;
use Throwable;
use function array_map;

#[OpenAPI(scope: OpenAPI::SCOPE_IGNORE)]
class MessagesController extends Controller {
	// A message's body is immutable once received -- unlike the mailbox
	// listing or flags, there is nothing that invalidates it, so a long
	// TTL is safe. Matches the 24h convention getItineraries()/getDkim()
	// already use for their own (HTTP-level) response caching in this
	// same controller, rather than inventing a new number.
	private const BODY_CACHE_TTL = 24 * 60 * 60;
	/**
	 * Ceiling on one prefetch call. Ten is the point where the saving is
	 * already almost all of what it will ever be -- ten logins collapse to
	 * one -- while the request stays short enough that it cannot squat on a
	 * worker or an IMAP connection.
	 */
	private const PREFETCH_MAX_MESSAGES = 10;

	private IMimeTypeDetector $mimeTypeDetector;
	private IL10N $l10n;
	private IURLGenerator $urlGenerator;
	private ContentSecurityPolicyNonceManager $nonceManager;

	public function __construct(
		string $appName,
		IRequest $request,
		private AccountService $accountService,
		private IMailManager $mailManager,
		private IMailSearch $mailSearch,
		private ItineraryService $itineraryService,
		private ?string $userId,
		private ?Folder $userFolder,
		private IFilenameValidator $filenameValidator,
		private LoggerInterface $logger,
		IL10N $l10n,
		IMimeTypeDetector $mimeTypeDetector,
		IURLGenerator $urlGenerator,
		ContentSecurityPolicyNonceManager $nonceManager,
		private ITrustedSenderService $trustedSenderService,
		private IMailTransmission $mailTransmission,
		private SmimeService $smimeService,
		private IMAPClientFactory $clientFactory,
		private IDkimService $dkimService,
		private IUserPreferences $preferences,
		private SnoozeService $snoozeService,
		private AiIntegrationsService $aiIntegrationService,
		private ICacheFactory $cacheFactory,
		private DelegationService $delegationService,
		private InlineAttachmentCache $inlineAttachmentCache,
		private ?ClientOperationService $clientOperationService = null,
	) {
		parent::__construct($appName, $request);
		$this->l10n = $l10n;
		$this->mimeTypeDetector = $mimeTypeDetector;
		$this->urlGenerator = $urlGenerator;
		$this->nonceManager = $nonceManager;
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $mailboxId
	 * @param int $cursor
	 * @param string $filter
	 * @param int|null $limit
	 * @param string $view returns messages in requested view ('singleton' or 'threaded')
	 * @param string|null $v Cache buster version to guarantee unique urls (will trigger HTTP caching if set)
	 * @param bool $prioritySplit return one exact page per Priority Inbox section
	 * @param int|null $cursorId database-id tie breaker for the timestamp cursor
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function index(int $mailboxId,
		?int $cursor = null,
		?string $filter = null,
		?int $limit = null,
		?string $view = null,
		?string $v = null,
		bool $prioritySplit = false,
		?int $cursorId = null): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$limit = min(100, max(1, $limit));

		try {
			$effectiveUserId = $this->delegationService->resolveMailboxUserId($mailboxId, $this->userId);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $mailboxId);
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$this->logger->debug("loading messages of mailbox <$mailboxId>");
		$sort = $this->preferences->getPreference($this->userId, 'sort-order', 'newest') === 'newest' ? IMailSearch::ORDER_NEWEST_FIRST : IMailSearch::ORDER_OLDEST_FIRST;

		$view = $view === 'singleton' ? IMailSearch::VIEW_SINGLETON : IMailSearch::VIEW_THREADED;

		$messages = $this->mailSearch->findMessages(
			$account,
			$mailbox,
			$sort,
			$filter === '' ? null : $filter,
			$cursor,
			$limit,
			$effectiveUserId,
			$view,
			$prioritySplit,
			$cursorId,
		);

		$response = new JSONResponse($messages);
		if ($v !== null && $v !== '') {
			$response->cacheFor(7 * 24 * 3600, false, true);
		}
		return $response;
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function show(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$this->logger->debug("loading message <$id>");

		return new JSONResponse(
			$this->mailSearch->findMessage(
				$account,
				$mailbox,
				$message
			)
		);
	}

	/**
	 * Warm the body cache for several messages over ONE IMAP connection.
	 *
	 * PHP-FPM shares nothing between requests, so every getBody() opens its
	 * own connection and issues its own LOGIN. That is invisible until the
	 * account is Gmail and the user is working through a backlog: 212 distinct
	 * messages opened in a day cost 230 live IMAP fetches, each a separate
	 * login, and Gmail answers that rate by refusing to authenticate -- with
	 * the wording of a bad password, which is the trap .92 exists for. The
	 * body cache cannot help, because reading NEW mail is all first opens.
	 *
	 * So the saving is not fewer fetches, it is fewer *logins*. This opens one
	 * client per account+mailbox group and fetches each message over it, then
	 * writes the exact cache entry getBody() and getHtmlBody() already read.
	 * Ten messages become one login instead of ten.
	 *
	 * Deliberately sequential per message rather than one findByIds() with
	 * loadBody: the batch call would hold every body in memory at once, and a
	 * measured single body request already peaks near 30 MB on a NAS with 1.6
	 * GB of RAM. Fetching one at a time on the shared connection keeps the
	 * peak at one message while still costing a single login -- the whole
	 * point. Trading a throttle for an OOM would not be a fix.
	 *
	 * Best effort by contract: a message that cannot be fetched is skipped,
	 * never fatal. The caller is a prefetch and its failure must be invisible;
	 * the real getBody() will report any genuine problem when the user
	 * actually opens that message.
	 *
	 * @NoAdminRequired
	 *
	 * @param int[] $ids
	 *
	 * @return JSONResponse
	 */
	#[TrapError]
	public function prefetchBodies(array $ids): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		// Cap before doing any work. The list arrives from the browser, and an
		// unbounded one would hold a worker -- and an IMAP connection -- for
		// as long as the caller cared to ask for.
		$ids = array_slice(
			array_values(array_unique(array_filter($ids, static fn ($id) => is_int($id) || ctype_digit((string)$id)))),
			0,
			self::PREFETCH_MAX_MESSAGES,
		);
		if ($ids === []) {
			return new JSONResponse(['cached' => 0, 'skipped' => 0]);
		}

		/** @var array<string, array{account: \OCA\Mail\Account, mailbox: \OCA\Mail\Db\Mailbox, messages: Message[]}> $groups */
		$groups = [];
		$skipped = 0;
		foreach ($ids as $id) {
			$id = (int)$id;
			try {
				$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
				$message = $this->mailManager->getMessage($effectiveUserId, $id);
				$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
				$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
			} catch (DoesNotExistException|ClientException) {
				// Not ours, or gone. Prefetch never reports on someone else's
				// mail, not even by admitting it exists.
				$skipped++;
				continue;
			}

			$key = $account->getId() . ':' . $mailbox->getId();
			if (!isset($groups[$key])) {
				$groups[$key] = ['account' => $account, 'mailbox' => $mailbox, 'messages' => []];
			}
			$groups[$key]['messages'][] = $message;
		}

		$cached = 0;
		foreach ($groups as $group) {
			$account = $group['account'];
			$mailbox = $group['mailbox'];
			$cacheInstance = $this->getCacheForAccount($account->getId());

			// Skip the whole group if every message is already cached, so a
			// repeat prefetch over the same page costs no connection at all.
			$wanted = array_filter(
				$group['messages'],
				static fn (Message $m) => !is_array($cacheInstance->get('message_' . $m->getId())),
			);
			if ($wanted === []) {
				continue;
			}

			$client = $this->clientFactory->getClient($account, workClass: ImapWorkClass::ACTIVE_CONTENT);
			try {
				foreach ($wanted as $message) {
					try {
						$imapMessage = $this->mailManager->getImapMessage(
							$client,
							$account,
							$mailbox,
							$message->getUid(),
							true,
						);
						$json = $imapMessage->getFullMessage($message->getId());
						$json['smimeIsEncrypted'] = $imapMessage->isEncrypted();
						$json['smimeIsSigned'] = $imapMessage->isSigned();
						$json['smimeSignatureValid'] = $imapMessage->isSigned() && $imapMessage->isSignatureValid();
						$cacheInstance->set('message_' . $message->getId(), $json, self::BODY_CACHE_TTL);
						$cached++;
						// Release before the next one. The bound on this
						// endpoint's memory is one message, not the batch.
						unset($json, $imapMessage);
					} catch (Throwable $e) {
						// One unfetchable message must not cost the rest of
						// the group the connection they are sharing.
						$this->logger->debug('Could not prefetch a message body', ['exception' => $e]);
						$skipped++;
					}
				}
			} finally {
				$client->logout();
			}
		}

		return new JSONResponse(['cached' => $cached, 'skipped' => $skipped]);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function getBody(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$cacheInstance = $this->getCacheForAccount($account->getId());
		$imapMessageCacheKey = "message_$id";

		$json = $cacheInstance->get($imapMessageCacheKey);
		if (!is_array($json)) {
			// Confirmed live: every open of a message -- the first time or
			// the fiftieth -- previously cost its own full live IMAP fetch
			// regardless of how many times it had already been opened
			// (there was no check here at all; the cache below existed
			// only to serve getHtmlBody(), never consulted by this method
			// itself). The same message reloaded slowly (11-33s) 7 times
			// within 7 minutes in one observed window, each a fresh,
			// uncached round trip against a slow-responding account.
			$client = $this->clientFactory->getClient($account, workClass: ImapWorkClass::ACTIVE_CONTENT);
			try {
				$imapMessage = $this->mailManager->getImapMessage(
					$client,
					$account,
					$mailbox,
					$message->getUid(), true
				);

				$json = $imapMessage->getFullMessage($id);
				// The S/MIME properties below are derived from parsing the
				// live IMAP message, same as the body -- captured as plain
				// scalars here (not a cached SmimeData object: this array
				// may go through Redis's own serialization, and there is
				// no guarantee an object round-trips back as the same
				// class rather than a generic stdClass/array) so a cache
				// hit can reconstruct the exact same SmimeData below
				// without needing $imapMessage at all.
				$json['smimeIsEncrypted'] = $imapMessage->isEncrypted();
				$json['smimeIsSigned'] = $imapMessage->isSigned();
				$json['smimeSignatureValid'] = $imapMessage->isSigned() && $imapMessage->isSignatureValid();
				// Cache regardless of whether the message has an HTML part.
				// The gate here used to be hasHtmlMessage(), which meant a
				// plain-text message was re-fetched from IMAP on every single
				// open -- a fresh login each time, for content that never
				// changes. It was safe to remove: getHtmlBody() serves
				// $cached['body'] on a hit and computes the identical
				// $fullMessage['body'] on a miss, so the two paths already
				// produce the same bytes for a plain-text message.
				$cacheInstance->set($imapMessageCacheKey, $json, self::BODY_CACHE_TTL);
			} finally {
				$client->logout();
			}
		}

		$itineraries = $this->itineraryService->getCached($account, $mailbox, $message->getUid());
		if ($itineraries) {
			$json['itineraries'] = $itineraries;
		}
		$json['attachments'] = $this->enrichAttachments($id, $json['attachments']);
		$json['inlineAttachments'] = $this->enrichAttachments($id, $json['inlineAttachments']);
		$json['accountId'] = $account->getId();
		$json['mailboxId'] = $mailbox->getId();
		$json['databaseId'] = $message->getId();
		$json['isSenderTrusted'] = $this->isSenderTrusted($message);

		$smimeData = new SmimeData();
		$smimeData->setIsEncrypted($message->isEncrypted() || $json['smimeIsEncrypted']);
		if ($json['smimeIsSigned']) {
			$smimeData->setIsSigned(true);
			$smimeData->setSignatureIsValid($json['smimeSignatureValid']);
		}
		$json['smime'] = $smimeData;

		$dkimResult = $this->dkimService->getCached($account, $mailbox, $message->getUid());
		if (is_bool($dkimResult)) {
			$json['dkimValid'] = $dkimResult;
		}

		$response = new JSONResponse($json);

		// Enable caching
		$response->cacheFor(60 * 60, false, true);

		return $response;
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 */
	#[TrapError]
	public function getItineraries(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$response = new JsonResponse($this->itineraryService->extract($account, $mailbox, $message->getUid()));
		$response->cacheFor(24 * 60 * 60, false, true);
		return $response;
	}

	/**
	 * @NoAdminRequired
	 * @param int $id
	 * @return JSONResponse
	 */
	#[TrapError]
	public function getDkim(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		try {
			$valid = $this->dkimService->validate($account, $mailbox, $message->getUid());
		} catch (MessageSourceUnavailableException $e) {
			// 404, not the 500 that #[TrapError] produces from an uncaught
			// ServiceException. DKIM is decorative metadata: the client
			// already reads 404 as "no DKIM information" and renders nothing,
			// and the message body loads independently of this call.
			//
			// The 500 was logged at error level for what is an ordinary
			// outcome -- the user opened a message the server no longer has --
			// which is noise in exactly the place that should hold only real
			// problems. Any OTHER failure still propagates and is still an
			// error, so a genuinely broken IMAP connection stays visible.
			$this->logger->debug('Cannot validate DKIM: the message is no longer on the server', [
				'exception' => $e,
			]);
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}

		$response = new JSONResponse(['valid' => $valid]);
		$response->cacheFor(24 * 60 * 60, false, true);
		return $response;
	}

	private function isSenderTrusted(Message $message): bool {
		if ($this->userId === null) {
			return false;
		}
		$from = $message->getFrom();
		$first = $from->first();
		if ($first === null) {
			return false;
		}
		$email = $first->getEmail();
		if ($email === null) {
			return false;
		}
		return $this->trustedSenderService->isTrusted(
			$this->userId,
			$email
		);
	}

	/**
	 * @NoAdminRequired
	 * @NoCSRFRequired
	 *
	 * @param int $id
	 *
	 * @return JSONResponse
	 * @throws ClientException
	 */
	#[TrapError]
	public function getThread(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		if (empty($message->getThreadRootId())) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}

		return new JSONResponse($this->mailManager->getThread($account, (string)$message->getThreadRootId()));
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 * @param int $destFolderId
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function move(int $id, int $destFolderId): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$srcMailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$dstMailbox = $this->mailManager->getMailbox($effectiveUserId, $destFolderId);
			$srcAccount = $this->accountService->find($effectiveUserId, $srcMailbox->getAccountId());
			$dstAccount = $this->accountService->find($effectiveUserId, $dstMailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$this->mailManager->moveMessage(
			$srcAccount,
			$srcMailbox->getName(),
			$message->getUid(),
			$dstAccount,
			$dstMailbox->getName()
		);

		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId moved message <$id> to mailbox <$destFolderId> on behalf of $effectiveUserId");

		return new JSONResponse();
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 * @param int $unixTimestamp
	 * @param int $destMailboxId
	 *
	 * @return JSONResponse
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function snooze(int $id, int $unixTimestamp, int $destMailboxId): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$srcMailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$dstMailbox = $this->mailManager->getMailbox($effectiveUserId, $destMailboxId);
			$srcAccount = $this->accountService->find($effectiveUserId, $srcMailbox->getAccountId());
			$dstAccount = $this->accountService->find($effectiveUserId, $dstMailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$this->snoozeService->snoozeMessage($message, $unixTimestamp, $srcAccount, $srcMailbox, $dstAccount, $dstMailbox);
		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId snoozed message <$id> to <$unixTimestamp> on behalf of $effectiveUserId");

		return new JSONResponse();
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @return JSONResponse
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function unSnooze(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$this->snoozeService->unSnoozeMessage($message, $effectiveUserId);
		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId unsnoozed message <$id> on behalf of $effectiveUserId");

		return new JSONResponse();
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function mdn(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		if ($message->getFlagMdnsent()) {
			return new JSONResponse([], Http::STATUS_PRECONDITION_FAILED);
		}

		try {
			$this->mailTransmission->sendMdn($account, $mailbox, $message);
			$this->mailManager->flagMessage($account, $mailbox->getName(), $message->getUid(), '$mdnsent', true);
		} catch (ServiceException $ex) {
			$this->logger->error('Sending mdn failed: ' . $ex->getMessage());
			throw $ex;
		}

		return new JSONResponse();
	}

	/**
	 * @NoAdminRequired
	 * @NoCSRFRequired
	 *
	 * @throws ServiceException
	 */
	#[TrapError]
	public function getSource(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$client = $this->clientFactory->getClient($account, workClass: ImapWorkClass::ACTIVE_CONTENT);
		try {
			$response = new JSONResponse([
				'source' => $this->mailManager->getSource(
					$client,
					$account,
					$mailbox->getName(),
					$message->getUid()
				)
			]);
		} finally {
			$client->logout();
		}

		// Enable caching
		$response->cacheFor(60 * 60, false, true);

		return $response;
	}

	/**
	 * Export a whole message as an .eml file.
	 *
	 * @NoAdminRequired
	 * @NoCSRFRequired
	 *
	 * @param int $id
	 * @return Response
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function export(int $id): Response {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$client = $this->clientFactory->getClient($account, workClass: ImapWorkClass::ACTIVE_CONTENT);
		try {
			$source = $this->mailManager->getSource(
				$client,
				$account,
				$mailbox->getName(),
				$message->getUid()
			);
		} finally {
			$client->logout();
		}

		return new AttachmentDownloadResponse(
			$source ?? '',
			$message->getSubject() . '.eml',
			'message/rfc822',
		);
	}

	/**
	 * Save a whole message as an .eml file in the local storage
	 *
	 * @NoAdminRequired
	 *
	 * @param int $id
	 * @param string $targetPath
	 *
	 * @return Response
	 *
	 * @throws ClientException
	 * @throws GenericFileException
	 * @throws NotPermittedException
	 * @throws LockedException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function saveFile(int $id, string $targetPath): Response {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		if ($this->userFolder === null) {
			return new JSONResponse([], Http::STATUS_INTERNAL_SERVER_ERROR);
		}
		if (!$this->userFolder->nodeExists($targetPath)) {
			return new JSONResponse([], Http::STATUS_BAD_REQUEST);
		}
		if (!($this->userFolder->get($targetPath) instanceof Folder)) {
			return new JSONResponse([], Http::STATUS_BAD_REQUEST);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$client = $this->clientFactory->getClient($account);
		try {
			$source = $this->mailManager->getSource(
				$client,
				$account,
				$mailbox->getName(),
				$message->getUid()
			);
		} finally {
			$client->logout();
		}

		if ($source === null) {
			return new JSONResponse([], Http::STATUS_INTERNAL_SERVER_ERROR);
		}

		$fileName = $this->filenameValidator->sanitizeFilename($message->getSubject());
		$fileExtension = 'eml';
		$fullPath = "$targetPath/$fileName.$fileExtension";
		$counter = 2;
		while ($this->userFolder->nodeExists($fullPath)) {
			$fullPath = "$targetPath/$fileName ($counter).$fileExtension";
			$counter++;
		}

		$newFile = $this->userFolder->newFile($fullPath);
		$newFile->putContent($source);

		return new JSONResponse();
	}

	/**
	 * @NoAdminRequired
	 * @NoCSRFRequired
	 *
	 * @param int $id
	 * @param bool $plain do not inject scripts if true (default=false)
	 *
	 * @return HtmlResponse|TemplateResponse
	 *
	 * @throws ClientException
	 */
	#[TrapError]
	public function getHtmlBody(int $id, bool $plain = false): Response {
		if ($this->userId === null) {
			return new TemplateResponse(
				$this->appName,
				'error',
				['message' => 'Not authenticated'],
				TemplateResponse::RENDER_AS_BLANK,
				Http::STATUS_UNAUTHORIZED,
			);
		}
		try {
			try {
				$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
				$message = $this->mailManager->getMessage($effectiveUserId, $id);
				$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
				$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
			} catch (DoesNotExistException) {
				return new TemplateResponse(
					$this->appName,
					'error',
					['message' => 'Not allowed'],
					TemplateResponse::RENDER_AS_BLANK,
					Http::STATUS_NOT_FOUND,
				);
			}

			$cacheInstance = $this->getCacheForAccount($account->getId());
			$imapMessageCacheKey = "message_$id";

			// Same cache getBody() populates with the full message
			// (including this same html body) -- reuse it here rather
			// than keeping a second, separate cache entry for the same
			// content, which opened this endpoint would repopulate on
			// its own if getBody() hasn't already been fetched for this
			// message yet.
			$cached = $cacheInstance->get($imapMessageCacheKey);
			$cachedBody = is_array($cached) ? ($cached['body'] ?? null) : null;
			if (is_string($cachedBody)) {
				$html = $cachedBody;
				$cachedInlineAttachments = $cached['inlineAttachments'] ?? [];
				$inlineAttachments = is_array($cachedInlineAttachments)
					? $cachedInlineAttachments
					: [];
			} else {
				$client = $this->clientFactory->getClient($account, workClass: ImapWorkClass::ACTIVE_CONTENT);
				try {
					$imapMessage = $this->mailManager->getImapMessage(
						$client,
						$account,
						$mailbox,
						$message->getUid(),
						true
					);
					$fullMessage = $imapMessage->getFullMessage($id);
					$fullMessageBody = $fullMessage['body'] ?? null;
					$html = is_string($fullMessageBody)
						? $fullMessageBody
						: $imapMessage->getHtmlBody($id);
					$fullMessageInlineAttachments = $fullMessage['inlineAttachments'] ?? [];
					$inlineAttachments = is_array($fullMessageInlineAttachments)
						? $fullMessageInlineAttachments
						: [];
					// Unconditional for the same reason as getBody(): the
					// hasHtmlMessage() gate only ever bought a repeat IMAP
					// login for plain-text mail.
					$cacheInstance->set($imapMessageCacheKey, $fullMessage, self::BODY_CACHE_TTL);
				} finally {
					$client->logout();
				}
			}

			if (!$plain) {
				// Convert every eligible inline <img> into an inert data
				// marker. htmlresponse.js hydrates all markers through one
				// bounded JSON bundle request. This response-time transform
				// also upgrades already-cached .19 HTML, so the 24-hour body
				// cache does not preserve the old one-request-per-image
				// waterfall after deployment.
				$html = $this->deferInlineAttachmentImages($id, $html, $inlineAttachments);
			}

			$htmlResponse = $plain
				? HtmlResponse::plain($html)
				: HtmlResponse::withResizer(
					$html,
					$this->nonceManager->getNonce(),
					$this->urlGenerator->getAbsoluteURL(
						$this->urlGenerator->linkTo('mail', 'js/htmlresponse.js')
					)
				);

			// Harden the default security policy
			$policy = new ContentSecurityPolicy();
			$policy->disallowScriptDomain('\'self\'');
			if ($plain) {
				$policy->disallowConnectDomain('\'self\'');
			}
			$policy->disallowFontDomain('\'self\'');
			$policy->disallowMediaDomain('\'self\'');
			$htmlResponse->setContentSecurityPolicy($policy);

			// Enable caching
			$htmlResponse->cacheFor(60 * 60, false, true);

			return $htmlResponse;
		} catch (Exception $ex) {
			return new TemplateResponse(
				$this->appName,
				'error',
				['message' => $ex->getMessage()],
				TemplateResponse::RENDER_AS_BLANK,
				Http::STATUS_INTERNAL_SERVER_ERROR
			);
		}
	}

	/**
	 * @param array<array-key, mixed> $inlineAttachments
	 */
	private function deferInlineAttachmentImages(
		int $messageId,
		string $html,
		array $inlineAttachments,
	): string {
		$candidateIds = $this->inlineAttachmentCache->getCandidateIds($inlineAttachments);
		if ($candidateIds === []) {
			return $html;
		}

		$bundleUrl = $this->urlGenerator->linkToRouteAbsolute(
			'mail.messages.getInlineAttachments',
			['id' => $messageId],
		);
		$encodedBundleUrl = htmlspecialchars($bundleUrl, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

		foreach ($candidateIds as $attachmentId) {
			$attachmentUrl = $this->urlGenerator->linkToRouteAbsolute(
				'mail.messages.downloadAttachment',
				[
					'id' => $messageId,
					'attachmentId' => $attachmentId,
				],
			);
			$encodedAttachmentUrl = htmlspecialchars(
				$attachmentUrl,
				ENT_QUOTES | ENT_SUBSTITUTE,
				'UTF-8',
			);
			$encodedAttachmentId = htmlspecialchars(
				$attachmentId,
				ENT_QUOTES | ENT_SUBSTITUTE,
				'UTF-8',
			);

			// HTMLPurifier emits normalized double-quoted attributes. Remove
			// src entirely so the parser cannot start thirteen HTTP requests
			// before the trusted iframe helper has a chance to coalesce them.
			$html = str_replace(
				'src="' . $encodedAttachmentUrl . '"',
				'data-mail-inline-id="' . $encodedAttachmentId . '"'
					. ' data-mail-inline-bundle="' . $encodedBundleUrl . '"'
					. ' data-mail-inline-fallback="' . $encodedAttachmentUrl . '"',
				$html,
			);
		}

		return $html;
	}

	/**
	 * Return every eligible small inline image in one bounded response.
	 *
	 * @NoAdminRequired
	 * @NoCSRFRequired
	 */
	#[TrapError]
	public function getInlineAttachments(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$parts = [];
		foreach ($this->inlineAttachmentCache->getBundle($account, $mailbox, $message, $id) as $attachmentId => $attachment) {
			$parts[$attachmentId] = [
				'mime' => $attachment->getType(),
				'content' => base64_encode($attachment->getContent()),
			];
		}

		$response = new JSONResponse(['parts' => $parts]);
		$response->addHeader('X-Mail-Inline-Part-Count', (string)count($parts));
		$response->cacheFor(InlineAttachmentCache::getBrowserCacheTtl(), false, true);
		return $response;
	}

	/**
	 * @NoAdminRequired
	 * @NoCSRFRequired
	 *
	 * @param int $id
	 * @param string $attachmentId
	 *
	 * @return Response
	 *
	 * @throws ClientException
	 */
	#[TrapError]
	public function downloadAttachment(int $id,
		string $attachmentId): Response {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$attachment = $this->inlineAttachmentCache->get(
			$account,
			$mailbox,
			$message,
			$id,
			$attachmentId,
		);
		$fromInlineBundle = $attachment !== null;

		$attachment ??= $this->mailManager->getMailAttachment(
			$account,
			$mailbox,
			$message,
			$attachmentId,
		);

		// Body party and embedded messages do not have a name
		$attachmentName = $attachment->getName();
		if ($attachmentName === null) {
			$response = new AttachmentDownloadResponse(
				$attachment->getContent(),
				$this->l10n->t('Embedded message %s', [
					$attachmentId,
				]) . '.eml',
				$attachment->getType()
			);
		} else {
			$response = new AttachmentDownloadResponse(
				$attachment->getContent(),
				$attachmentName,
				$attachment->getType()
			);
		}

		if ($fromInlineBundle) {
			// Private browser caching removes even the cheap HTTP/Redis work
			// on a reopen while never making authenticated mail content
			// publicly cacheable.
			$response->cacheFor(InlineAttachmentCache::getBrowserCacheTtl(), false, true);
		}

		return $response;
	}

	/**
	 * @NoAdminRequired
	 * @NoCSRFRequired
	 *
	 * @param int $id the message id
	 *
	 * @return ZipResponse|JSONResponse
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 * @throws DoesNotExistException
	 */
	#[TrapError]
	public function downloadAttachments(int $id): Response {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$attachments = $this->mailManager->getMailAttachments($account, $mailbox, $message);
		if ($attachments === []) {
			return new JSONResponse([
				'message' => $this->l10n->t('This message has no downloadable attachments'),
			], Http::STATUS_NOT_FOUND);
		}
		$zip = new ZipResponse($this->request, 'attachments');

		foreach ($attachments as $attachment) {
			$fileName = $attachment->getName();
			if ($fileName === null || $fileName === '') {
				$fileName = $this->l10n->t('Embedded message %s', [
					$attachment->getId(),
				]) . '.eml';
			}
			$fh = fopen('php://temp', 'r+');
			if ($fh === false) {
				continue;
			}
			$content = $attachment->getContent();
			fputs($fh, $content);
			$size = strlen($content);
			rewind($fh);
			$zip->addResource($fh, $fileName, $size);
		}
		return $zip;
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 * @param string $attachmentId
	 * @param string $targetPath
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 * @throws GenericFileException
	 * @throws NotPermittedException
	 * @throws LockedException
	 */
	#[TrapError]
	public function saveAttachment(int $id,
		string $attachmentId,
		string $targetPath) {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		if ($this->userFolder === null) {
			return new JSONResponse([], Http::STATUS_INTERNAL_SERVER_ERROR);
		}
		if (!$this->userFolder->nodeExists($targetPath)) {
			return new JSONResponse([], Http::STATUS_BAD_REQUEST);
		}
		if (!($this->userFolder->get($targetPath) instanceof Folder)) {
			return new JSONResponse([], Http::STATUS_BAD_REQUEST);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		/** @var Attachment[] $attachments */
		$attachments = [];
		if ($attachmentId === '0') {
			$attachments = $this->mailManager->getMailAttachments(
				$account,
				$mailbox,
				$message,
			);
		} else {
			$attachments[] = $this->mailManager->getMailAttachment(
				$account,
				$mailbox,
				$message,
				$attachmentId,
			);
		}

		foreach ($attachments as $attachment) {
			$fileName = $attachment->getName() ?? $this->l10n->t('Embedded message %s', [
				$attachment->getId(),
			]) . '.eml';
			$fileParts = pathinfo($fileName);
			$fileName = $fileParts['filename'];
			$fileExtension = $fileParts['extension'] ?? '';
			$fullPath = "$targetPath/$fileName.$fileExtension";
			$counter = 2;
			while ($this->userFolder->nodeExists($fullPath)) {
				$fullPath = "$targetPath/$fileName ($counter).$fileExtension";
				$counter++;
			}

			$newFile = $this->userFolder->newFile($fullPath);
			$newFile->putContent($attachment->getContent());
		}
		return new JSONResponse();
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 * @param array $flags
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function setFlags(int $id, array $flags, ?string $operationId = null): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		return $this->runIdempotentFlagOperation(
			$operationId,
			['ids' => [$id], 'flags' => $flags],
			function () use ($account, $mailbox, $message, $flags, $effectiveUserId, $id): array {
				$flagChanges = [];
				foreach ($flags as $flag => $value) {
					$value = filter_var($value, FILTER_VALIDATE_BOOLEAN);
					$this->mailManager->flagMessage($account, $mailbox->getName(), $message->getUid(), $flag, $value);
					$flagChanges[] = "$flag=" . ($value ? 'true' : 'false');
				}
				$flagsSummary = implode(', ', $flagChanges);
				$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId updated flags on message <$id> with [$flagsSummary] on behalf of $effectiveUserId");

				// Re-fetch: only the server knows whether another message in
				// this thread remains unseen.
				$updated = $this->mailManager->getMessage($effectiveUserId, $id);
				$response = [
					'hasUnseenInThread' => $updated->getHasUnseenInThread(),
				];

				// flagMessages() now maintains the importance tag row itself,
				// so this response carries the tag the browser used to fetch
				// with a second request. A session that has not seen the tag
				// yet still needs its id to update the badge.
				if (array_key_exists(Tag::LABEL_IMPORTANT, $flags)) {
					try {
						$response['importantTag'] = $this->mailManager->getTagByImapLabel(
							Tag::LABEL_IMPORTANT,
							$effectiveUserId,
						);
					} catch (ClientException $e) {
						// No importance tag for this user. The flag itself
						// still landed and already drives the badge and the
						// Priority sections; nothing here should fail.
						$this->logger->warning('Importance flag written without a tag to report back', ['exception' => $e]);
					}
				}

				return $response;
			},
		);
	}

	/**
	 * Set the same explicit flag target on many cached messages.
	 *
	 * Messages are grouped by account and mailbox so one IMAP STORE handles
	 * all UIDs in a group. This replaces the browser's previous N serialized
	 * HTTP requests without changing the optimistic UI contract.
	 *
	 * @NoAdminRequired
	 *
	 * @param int[] $ids
	 * @param array<string, bool> $flags
	 */
	#[TrapError]
	public function setFlagsBatch(array $ids, array $flags, ?string $operationId = null): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$ids = array_values(array_unique(array_map(static fn ($id) => (int)$id, $ids)));
		if ($ids === [] || count($ids) > 200 || $flags === []) {
			return new JSONResponse([], Http::STATUS_BAD_REQUEST);
		}

		return $this->runIdempotentFlagOperation(
			$operationId,
			['ids' => $ids, 'flags' => $flags],
			function () use ($ids, $flags): array {
				$groups = [];
				$effectiveUsers = [];
				foreach ($ids as $id) {
					try {
						$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
						$message = $this->mailManager->getMessage($effectiveUserId, $id);
						$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
						$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
					} catch (DoesNotExistException $e) {
						// Skip it; do NOT fail the batch. One id that has since
						// been purged -- moved, expunged elsewhere, dropped by a
						// sync between the browser reading the list and clicking
						// -- used to abort the whole request, so opening a
						// six-message thread marked NONE of it read and put a red
						// "Could not update read status" on screen. Confirmed
						// live on 2026-07-29: "Message 1597153 does not exist"
						// from a mark-on-open batch.
						//
						// "Gone" is also not a failure for a flag write, the way
						// it is not for a delete: there is no message left to
						// carry the flag, so the caller's intent is already
						// satisfied. Same reasoning as reconcileOrRevert()'s
						// authoritative-is-undefined branch on the client.
						$this->logger->debug("Skipping message $id in a flag batch: it no longer exists", [
							'exception' => $e,
						]);
						continue;
					}
					$key = $account->getId() . ':' . $mailbox->getId();
					$groups[$key] ??= [
						'account' => $account,
						'mailbox' => $mailbox,
						'uids' => [],
					];
					$groups[$key]['uids'][] = $message->getUid();
					$effectiveUsers[$id] = $effectiveUserId;
				}

				$normalizedFlags = [];
				foreach ($flags as $flag => $value) {
					$normalizedFlags[$flag] = filter_var($value, FILTER_VALIDATE_BOOLEAN);
				}
				foreach ($groups as $group) {
					$this->mailManager->flagMessages(
						$group['account'],
						$group['mailbox']->getName(),
						$group['uids'],
						$normalizedFlags,
					);
				}

				$response = [];
				foreach ($effectiveUsers as $id => $effectiveUserId) {
					try {
						$updated = $this->mailManager->getMessage($effectiveUserId, $id);
					} catch (DoesNotExistException $e) {
						// A message can still vanish between the STORE above and
						// this read. The flag write already happened, so this is
						// a reporting gap, not a failure -- and the browser
						// treats a missing entry as "no authoritative value",
						// which is exactly right.
						$this->logger->debug("Message $id vanished before its flag batch could be reported", [
							'exception' => $e,
						]);
						continue;
					}
					$response[(string)$id] = [
						'hasUnseenInThread' => $updated->getHasUnseenInThread(),
					];
				}
				$flagsSummary = implode(', ', array_map(
					static fn ($flag, $value) => "$flag=" . ($value ? 'true' : 'false'),
					array_keys($normalizedFlags),
					array_values($normalizedFlags),
				));
				$this->logger->info('User updated flags on a message batch', [
					'userId' => $this->userId,
					// What was actually written, not what was asked for: the two
					// differ whenever an id has been purged, and a count that
					// silently includes skipped ones makes the log useless for
					// noticing that.
					'messageCount' => count($effectiveUsers),
					'requestedCount' => count($ids),
					'flags' => $flagsSummary,
				]);

				// Same contract as setFlags(): the flag write maintains the
				// importance tag row, so report the tag back rather than
				// making the browser fetch it separately.
				$result = ['messages' => $response];
				if (array_key_exists(Tag::LABEL_IMPORTANT, $flags)) {
					try {
						$result['importantTag'] = $this->mailManager->getTagByImapLabel(
							Tag::LABEL_IMPORTANT,
							$this->userId,
						);
					} catch (ClientException $e) {
						$this->logger->warning('Importance flags written without a tag to report back', ['exception' => $e]);
					}
				}
				return $result;
			},
		);
	}

	/**
	 * @param array<string, mixed> $fingerprint
	 * @param \Closure(): array $operation
	 */
	private function runIdempotentFlagOperation(
		?string $operationId,
		array $fingerprint,
		\Closure $operation,
	): JSONResponse {
		ksort($fingerprint['flags']);
		$result = $this->clientOperationService?->execute(
			$this->userId,
			$operationId,
			hash('sha256', json_encode($fingerprint, JSON_THROW_ON_ERROR)),
			$operation,
		) ?? [
			'state' => 'complete',
			'response' => $operation(),
		];
		if ($result['state'] === 'pending') {
			$response = new JSONResponse([
				'message' => 'Operation is still in progress',
			], Http::STATUS_CONFLICT);
			$response->addHeader('Retry-After', '1');
			return $response;
		}
		return new JSONResponse($result['response']);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 * @param string $imapLabel
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function setTag(int $id, string $imapLabel): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		try {
			$tag = $this->mailManager->getTagByImapLabel($imapLabel, $this->userId);
		} catch (ClientException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$this->mailManager->tagMessage($account, $mailbox->getName(), $message, $tag, true);
		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId added tag <$imapLabel> on message <$id> on behalf of $effectiveUserId");
		return new JSONResponse($tag);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 * @param string $imapLabel
	 *
	 * @return JSONResponse
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function removeTag(int $id, string $imapLabel): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		try {
			$tag = $this->mailManager->getTagByImapLabel($imapLabel, $this->userId);
		} catch (ClientException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$this->mailManager->tagMessage($account, $mailbox->getName(), $message, $tag, false);
		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId removed tag <$imapLabel> on message <$id> on behalf of $effectiveUserId");
		return new JSONResponse($tag);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $id
	 *
	 * @throws ClientException
	 * @throws ServiceException
	 */
	#[TrapError]
	public function destroy(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($id, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $id);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		$this->logger->debug("deleting message <$id>");

		$this->mailManager->deleteMessage(
			$account,
			$mailbox->getName(),
			$message->getUid()
		);
		$this->delegationService->logDelegatedAction($this->userId, $effectiveUserId, "$this->userId deleted message <$id> on behalf of $effectiveUserId");
		return new JSONResponse();
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $messageId
	 *
	 * @return JSONResponse
	 */
	#[TrapError]
	public function smartReply(int $messageId):JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($messageId, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $messageId);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		try {
			$replies = array_values($this->aiIntegrationService->getSmartReply($account, $mailbox, $message, $effectiveUserId) ?? []);
		} catch (ServiceException $e) {
			$this->logger->error('Smart reply failed: ' . $e->getMessage(), [
				'exception' => $e,
			]);
			return new JSONResponse([], Http::STATUS_NO_CONTENT);
		}
		return new JSONResponse($replies);
	}

	/**
	 * @NoAdminRequired
	 *
	 * @param int $messageId
	 *
	 * @return JSONResponse
	 */
	#[TrapError]
	public function needsTranslation(int $messageId): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}
		try {
			$effectiveUserId = $this->delegationService->resolveMessageUserId($messageId, $this->userId);
			$message = $this->mailManager->getMessage($effectiveUserId, $messageId);
			$mailbox = $this->mailManager->getMailbox($effectiveUserId, $message->getMailboxId());
			$account = $this->accountService->find($effectiveUserId, $mailbox->getAccountId());
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_FORBIDDEN);
		}

		if (!$this->aiIntegrationService->isLlmProcessingEnabled()) {
			$response = new JSONResponse([], Http::STATUS_NOT_IMPLEMENTED);
			$response->cacheFor(60 * 60 * 24, false, true);
			return $response;
		}

		try {
			$requiresTranslation = $this->aiIntegrationService->requiresTranslation(
				$account,
				$mailbox,
				$message,
				$effectiveUserId
			);
			$response = new JSONResponse(['requiresTranslation' => $requiresTranslation === true]);
			$response->cacheFor(60 * 60 * 24, false, true);
			return $response;
		} catch (ServiceException $e) {
			$this->logger->error('Translation check failed: ' . $e->getMessage(), [
				'exception' => $e,
			]);
			return new JSONResponse([], Http::STATUS_NO_CONTENT);
		}
	}

	private function enrichAttachments(int $id, array $attachments): array {
		return array_map(
			fn ($attachment) => $this->enrichAttachment($id, $attachment),
			$attachments
		);
	}

	/**
	 * @param int $id
	 * @param array $attachment
	 *
	 * @return array
	 */
	private function enrichAttachment(int $id, array $attachment): array {
		$downloadUrl = $this->urlGenerator->linkToRouteAbsolute('mail.messages.downloadAttachment', [
			'id' => $id,
			'attachmentId' => $attachment['id'],
		]);
		$attachment['downloadUrl'] = $downloadUrl;
		$attachment['mimeUrl'] = $this->mimeTypeDetector->mimeTypeIcon($attachment['mime']);

		$attachment['isImage'] = $this->attachmentIsImage($attachment);
		$attachment['isCalendarEvent'] = $this->attachmentIsCalendarEvent($attachment);

		return $attachment;
	}

	/**
	 * Determines if the content of this attachment is an image
	 *
	 * @param array $attachment
	 *
	 * @return boolean
	 */
	private function attachmentIsImage(array $attachment): bool {
		return in_array(
			$attachment['mime'], [
				'image/jpeg',
				'image/png',
				'image/gif'
			]);
	}

	/**
	 * @param array $attachment
	 *
	 * @return boolean
	 */
	private function attachmentIsCalendarEvent(array $attachment): bool {
		return in_array($attachment['mime'], ['text/calendar', 'application/ics'], true);
	}

	private function getCacheForAccount(int $accountId): ICache {
		return $this->cacheFactory->createDistributed("mail_account_$accountId");
	}
}
