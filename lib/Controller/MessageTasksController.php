<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Controller;

use OCA\Mail\Db\MessageTask;
use OCA\Mail\Db\MessageTaskMapper;
use OCA\Mail\Http\TrapError;
use OCA\Mail\Service\MailManager;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IRequest;
use Psr\Log\LoggerInterface;
use function trim;

/**
 * The reverse index between a message and the tasks made from it.
 *
 * The link a user follows lives in the VTODO's URL property; CalDAV owns that
 * and this controller never touches it. What CalDAV cannot answer is the other
 * direction -- "does this conversation have a task" -- so the browser records
 * the pairing here when it creates one, and asks here when it opens a thread.
 *
 * Everything served from this table is a HINT. A task deleted in the Tasks app
 * leaves a row behind, and nothing tells us. Callers are expected to find that
 * out when they follow the link and to say so, which is what destroy() is for.
 */
class MessageTasksController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private ?string $userId,
		private MessageTaskMapper $mapper,
		private MailManager $mailManager,
		private ITimeFactory $timeFactory,
		private LoggerInterface $logger,
	) {
		parent::__construct($appName, $request);
	}

	/**
	 * Every task made from any message in this message's thread.
	 *
	 * Thread-scoped rather than message-scoped because that is the question
	 * the UI asks: the header chip is about the conversation. A message with
	 * no thread root of its own falls back to its own Message-ID.
	 */
	#[NoAdminRequired]
	#[TrapError]
	public function index(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$message = $this->mailManager->getMessage($this->userId, $id);
		} catch (DoesNotExistException $e) {
			// Consistent with the rest of the app: a message that is gone is
			// not an error, it simply has nothing to report.
			$this->logger->debug("No task index for message $id: it no longer exists", ['exception' => $e]);
			return new JSONResponse(['tasks' => []]);
		}

		$threadRootId = $message->getThreadRootId();
		$tasks = $threadRootId !== null && trim($threadRootId) !== ''
			? $this->mapper->findByThreadRootId($this->userId, $threadRootId)
			: $this->mapper->findByMessageId($this->userId, (string)$message->getMessageId());

		return new JSONResponse(['tasks' => $tasks]);
	}

	/**
	 * Record that a task was made from this message.
	 *
	 * Called after the browser has created the VTODO, so a failure here costs
	 * the indicator and nothing else -- the task exists and still carries its
	 * URL back to the message.
	 */
	#[NoAdminRequired]
	#[TrapError]
	// $taskUri is appended rather than slotted in beside $taskUid on
	// purpose: the request maps parameters by NAME, but every existing
	// positional caller -- the tests among them -- would silently start
	// passing its summary as the URI.
	public function create(int $id, string $calendarUri, string $taskUid, ?string $summary = null, ?string $taskUri = null): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		if (trim($calendarUri) === '' || trim($taskUid) === '') {
			return new JSONResponse([], Http::STATUS_BAD_REQUEST);
		}
		try {
			$message = $this->mailManager->getMessage($this->userId, $id);
		} catch (DoesNotExistException $e) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		$messageId = $message->getMessageId();
		if ($messageId === null || trim($messageId) === '') {
			// Nothing durable to key on. Better to have no indicator than one
			// keyed on a row id that a re-index will invalidate.
			$this->logger->debug("Not indexing a task for message $id: it has no Message-ID");
			return new JSONResponse([], Http::STATUS_UNPROCESSABLE_ENTITY);
		}

		$task = new MessageTask();
		$task->setUserId($this->userId);
		$task->setMessageId($messageId);
		$task->setThreadRootId($message->getThreadRootId());
		$task->setCalendarUri($calendarUri);
		$task->setTaskUid($taskUid);
		// The CalDAV object name is what the deep link needs; the UID is kept
		// because it is what identifies the task itself, and the two differ.
		$task->setTaskUri($taskUri === null || trim($taskUri) === '' ? null : $taskUri);
		$task->setSummary($summary === null ? null : mb_substr($summary, 0, 255));
		$task->setCreatedAt($this->timeFactory->getTime());

		return new JSONResponse(['task' => $this->mapper->insert($task)], Http::STATUS_CREATED);
	}

	/**
	 * Forget a task. Used when following the link finds it gone, which is the
	 * only way we ever learn that it was deleted elsewhere.
	 */
	#[NoAdminRequired]
	#[TrapError]
	public function destroy(string $taskUid): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$this->mapper->deleteByTaskUid($this->userId, $taskUid);
		return new JSONResponse([]);
	}
}
