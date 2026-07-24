<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Controller;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Contracts\IUserPreferences;
use OCA\Mail\Controller\PriorityInboxController;
use OCA\Mail\Service\PriorityInboxStatsService;
use OCP\AppFramework\Http;
use OCP\IRequest;

class PriorityInboxControllerTest extends TestCase {
	public function testRejectsAnUnauthenticatedRequest(): void {
		$controller = new PriorityInboxController(
			'mail',
			$this->createMock(IRequest::class),
			null,
			$this->createMock(PriorityInboxStatsService::class),
			$this->createMock(IUserPreferences::class),
		);

		self::assertSame(Http::STATUS_UNAUTHORIZED, $controller->stats()->getStatus());
	}

	public function testMapsTheViewAndFavoritesPreference(): void {
		$service = $this->createMock(PriorityInboxStatsService::class);
		$preferences = $this->createMock(IUserPreferences::class);
		$preferences->expects(self::once())
			->method('getPreference')
			->with('alice', 'sort-favorites', 'false')
			->willReturn('true');
		$expected = [
			'sections' => [
				'favorite' => ['total' => 1, 'unread' => 1],
				'important' => ['total' => 0, 'unread' => 0],
				'other' => ['total' => 0, 'unread' => 0],
			],
			'complete' => true,
		];
		$service->expects(self::once())
			->method('getStats')
			->with('alice', false, true)
			->willReturn($expected);

		$controller = new PriorityInboxController(
			'mail',
			$this->createMock(IRequest::class),
			'alice',
			$service,
			$preferences,
		);

		self::assertSame($expected, $controller->stats('singleton')->getData());
	}
}
