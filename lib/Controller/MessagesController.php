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
use OCA\Mail\Exception\ClientException;
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
use OCP\Files\IMimeTypeDetector;
use OCP\Files\NotPermittedException;
use OCP\ICache;
use OCP\ICacheFactory;
use OCP\IL10N;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\Lock\LockedException;
use Psr\Log\LoggerInterface;
use function array_map;

#[OpenAPI(scope: OpenAPI::SCOPE_IGNORE)]
class MessagesController extends Controller {
	// A message's body is immutable once received -- unlike the mailbox
	// listing or flags, there is nothing that invalidates it, so a long
	// TTL is safe. Matches the 24h convention getItineraries()/getDkim()
	// already use for their own (HTTP-level) response caching in this
	// same controller, rather than inventing a new number.
	private const BODY_CACHE_TTL = 24 * 60 * 60;

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
				if ($imapMessage->hasHtmlMessage()) {
					$cacheInstance->set($imapMessageCacheKey, $json, self::BODY_CACHE_TTL);
				}
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

		$response = new JSONResponse(['valid' => $this->dkimService->validate($account, $mailbox, $message->getUid())]);
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
			if (is_array($cached) && array_key_exists('body', $cached)) {
				$html = $cached['body'];
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
					$html = $imapMessage->getHtmlBody($id);
					if ($imapMessage->hasHtmlMessage()) {
						$cacheInstance->set($imapMessageCacheKey, $imapMessage->getFullMessage($id), self::BODY_CACHE_TTL);
					}
				} finally {
					$client->logout();
				}
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
			$policy->disallowConnectDomain('\'self\'');
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

		$attachment = $this->mailManager->getMailAttachment(
			$account,
			$mailbox,
			$message,
			$attachmentId,
		);

		// Body party and embedded messages do not have a name
		$attachmentName = $attachment->getName();
		if ($attachmentName === null) {
			return new AttachmentDownloadResponse(
				$attachment->getContent(),
				$this->l10n->t('Embedded message %s', [
					$attachmentId,
				]) . '.eml',
				$attachment->getType()
			);
		}
		return new AttachmentDownloadResponse(
			$attachment->getContent(),
			$attachmentName,
			$attachment->getType()
		);
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
				return [
					'hasUnseenInThread' => $updated->getHasUnseenInThread(),
				];
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
						throw new ClientException("Message $id does not exist", 0, $e);
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
				foreach ($ids as $id) {
					$updated = $this->mailManager->getMessage($effectiveUsers[$id], $id);
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
					'messageCount' => count($ids),
					'flags' => $flagsSummary,
				]);
				return ['messages' => $response];
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
