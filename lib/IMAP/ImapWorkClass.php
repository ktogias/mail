<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\IMAP;

/**
 * End-to-end work classes used by the browser scheduler, HTTP layer and IMAP
 * admission control.
 *
 * These are strings rather than a PHP enum so the optional IMAP factory
 * argument remains compatible with every PHP version supported by this app.
 */
final class ImapWorkClass {
	public const QUICK_MUTATION = 'quick-mutation';
	public const ACTIVE_CONTENT = 'active-content';
	public const EXPLICIT_HEAVY = 'explicit-heavy';
	public const VISIBLE_REVALIDATION = 'visible-revalidation';
	public const SPECULATIVE = 'speculative';
	public const MAINTENANCE = 'maintenance';

	private const ALL = [
		self::QUICK_MUTATION,
		self::ACTIVE_CONTENT,
		self::EXPLICIT_HEAVY,
		self::VISIBLE_REVALIDATION,
		self::SPECULATIVE,
		self::MAINTENANCE,
	];

	public static function normalize(?string $workClass, string $fallback = self::MAINTENANCE): string {
		return in_array($workClass, self::ALL, true) ? $workClass : $fallback;
	}

	public static function isForeground(string $workClass): bool {
		return in_array($workClass, [
			self::ACTIVE_CONTENT,
			self::EXPLICIT_HEAVY,
			self::VISIBLE_REVALIDATION,
		], true);
	}

	public static function isBackground(string $workClass): bool {
		return in_array($workClass, [
			self::SPECULATIVE,
			self::MAINTENANCE,
		], true);
	}
}
