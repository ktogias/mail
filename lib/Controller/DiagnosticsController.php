<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Controller;

use OCA\Mail\Http\TrapError;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;
use function is_scalar;
use function mb_substr;

/**
 * A drain for client-side diagnostics.
 *
 * @nextcloud/logger writes to the browser console and nowhere else, which is
 * fine until the problem only reproduces on a phone. Firefox on Android has no
 * console a person can reasonably read, so a fault that lives entirely in the
 * client's store -- which list key was written, by which source, and whether a
 * replace actually cleared it -- is invisible from every other angle: it shows
 * in neither the HTTP trace nor the database.
 *
 * Deliberately narrow, and deliberately temporary. It records a short event
 * name and a flat bag of scalars at INFO, so it survives the production log
 * level without needing debug turned on. Values are truncated and non-scalars
 * dropped: this endpoint accepts whatever a browser sends it, so it must not
 * become a way to write arbitrary volume into the log.
 */
class DiagnosticsController extends Controller {
	private const MAX_VALUE = 200;
	private const MAX_FIELDS = 20;

	public function __construct(
		string $appName,
		IRequest $request,
		private ?string $userId,
		private LoggerInterface $logger,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	#[TrapError]
	public function log(string $event, array $context = []): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		$safe = [];
		foreach ($context as $key => $value) {
			if (count($safe) >= self::MAX_FIELDS) {
				break;
			}
			if (!is_scalar($value) && $value !== null) {
				continue;
			}
			$safe[(string)$key] = is_string($value) ? mb_substr($value, 0, self::MAX_VALUE) : $value;
		}

		$this->logger->info('mail-client-diagnostic: ' . mb_substr($event, 0, self::MAX_VALUE), $safe);

		return new JSONResponse([]);
	}
}
