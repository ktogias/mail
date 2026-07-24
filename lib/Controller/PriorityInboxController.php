<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Controller;

use OCA\Mail\Contracts\IUserPreferences;
use OCA\Mail\Service\PriorityInboxStatsService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\OpenAPI;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;

#[OpenAPI(scope: OpenAPI::SCOPE_IGNORE)]
class PriorityInboxController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private ?string $userId,
		private PriorityInboxStatsService $statsService,
		private IUserPreferences $preferences,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	public function stats(?string $view = null): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}

		return new JSONResponse($this->statsService->getStats(
			$this->userId,
			$view !== 'singleton',
			$this->preferences->getPreference($this->userId, 'sort-favorites', 'false') === 'true',
		));
	}
}
