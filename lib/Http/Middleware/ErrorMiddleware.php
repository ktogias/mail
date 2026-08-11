<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2017 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Http\Middleware;

use Exception;
use Horde_Imap_Client_Exception;
use OCA\Mail\Exception\ClientException;
use OCA\Mail\Exception\ImapCapacityException;
use OCA\Mail\Exception\NotImplemented;
use OCA\Mail\Exception\ServiceException;
use OCA\Mail\Http\JsonResponse;
use OCA\Mail\Http\TrapError;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Middleware;
use OCP\IConfig;
use Psr\Log\LoggerInterface;
use ReflectionMethod;
use Throwable;

class ErrorMiddleware extends Middleware {
	/** @var IConfig */
	private $config;

	/**
	 * @param IConfig $config
	 * @param LoggerInterface $logger
	 */
	public function __construct(
		IConfig $config,
		private LoggerInterface $logger,
	) {
		$this->config = $config;
	}

	/**
	 * @param Controller $controller
	 * @param string $methodName
	 * @param Exception $exception
	 *
	 * @return Response
	 * @throws Exception
	 */
	#[\Override]
	public function afterException($controller, $methodName, Exception $exception) {
		$reflectionMethod = new ReflectionMethod($controller, $methodName);
		$attributes = $reflectionMethod->getAttributes(TrapError::class);
		if ($attributes === []) {
			return parent::afterException($controller, $methodName, $exception);
		}

		if ($exception instanceof ClientException) {
			// Confirmed live: a recurring "could not open folder" report
			// traced to a 400 from this exact branch, but ClientException
			// was never logged anywhere -- by the time anyone looked, the
			// underlying condition (whatever threw) had already cleared
			// and there was no server-side trace of what it actually was.
			// Warning, not error: most ClientExceptions are routine client
			// input problems, not server bugs, but they still need to be
			// visible under this app's default production log level so a
			// recurrence can actually be diagnosed instead of vanishing
			// again.
			$this->logger->warning($exception->getMessage(), [
				'exception' => $exception,
			]);
			return JsonResponse::failWith($exception);
		}

		if ($exception instanceof DoesNotExistException) {
			return JSONResponse::fail([], Http::STATUS_NOT_FOUND);
		}

		if ($exception instanceof NotImplemented) {
			return JSONResponse::fail([], Http::STATUS_NOT_IMPLEMENTED);
		}

		if ($this->containsImapCapacityException($exception)) {
			$this->logger->warning($exception->getMessage(), [
				'exception' => $exception,
			]);
			$response = JsonResponse::error(
				'Mail account is busy',
				Http::STATUS_TOO_MANY_REQUESTS,
			);
			$response->addHeader('Retry-After', '1');
			return $response;
		}

		$temporary = $this->isTemporaryException($exception);
		if ($temporary) {
			$this->logger->warning($exception->getMessage(), [
				'exception' => $exception,
			]);
		} else {
			$this->logger->error($exception->getMessage(), [
				'exception' => $exception,
			]);
		}
		if ($this->config->getSystemValue('debug', false)) {
			return JsonResponse::errorFromThrowable(
				$exception,
				$temporary ? Http::STATUS_SERVICE_UNAVAILABLE : Http::STATUS_INTERNAL_SERVER_ERROR,
				[
					'debug' => true,
				]
			);
		}

		return JsonResponse::error(
			'Server error',
			$temporary ? Http::STATUS_SERVICE_UNAVAILABLE : Http::STATUS_INTERNAL_SERVER_ERROR
		);
	}

	private function isTemporaryException(Throwable $ex): bool {
		if ($ex instanceof ServiceException && $ex->getPrevious() !== null) {
			$ex = $ex->getPrevious();
		}

		if ($ex instanceof Horde_Imap_Client_Exception) {
			return in_array(
				$ex->getCode(),
				[
					Horde_Imap_Client_Exception::DISCONNECT,
					Horde_Imap_Client_Exception::SERVER_READERROR,
					Horde_Imap_Client_Exception::SERVER_WRITEERROR,
					// Gmail refuses a connection it is throttling with
					// "Mail server denied authentication", which is
					// indistinguishable from a bad password at this layer.
					// Observed live: opening one message returned 500 and the
					// UI said "Not found", and the SAME message opened fine
					// seconds later -- nothing was wrong with the credentials,
					// there was simply no connection slot free while the
					// fan-out and a sync held theirs.
					//
					// Reporting that as a server error is wrong twice over: it
					// tells the user something final about a message that is
					// still there, and it denies the client the 429 +
					// Retry-After it already knows how to act on.
					//
					// The trade-off is deliberate. Credentials that are
					// genuinely broken fail every other request too, and the
					// account carries its own auth-error state for that (see
					// SyncJob, which checks this same code to disable an
					// account) -- so nothing here hides a real problem, while
					// a transient refusal stops looking like a missing message.
					Horde_Imap_Client_Exception::LOGIN_AUTHENTICATIONFAILED,
				],
				true
			);
		}

		return false;
	}

	private function containsImapCapacityException(Throwable $exception): bool {
		do {
			if ($exception instanceof ImapCapacityException) {
				return true;
			}
			$exception = $exception->getPrevious();
		} while ($exception !== null);

		return false;
	}
}
