<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service;

use OCA\Mail\Account;
use OCA\Mail\Attachment;
use OCA\Mail\Contracts\IMailManager;
use OCA\Mail\Db\Mailbox;
use OCA\Mail\Db\Message;
use OCP\ICache;
use OCP\ICacheFactory;
use OCP\IMemcache;
use Psr\Log\LoggerInterface;

/**
 * Bounded read-through cache for small inline MIME images.
 *
 * An HTML iframe issues one HTTP request per embedded image. Without a
 * message-level cache, every request creates a separate authenticated IMAP
 * session and FETCH. This service lets the first request fetch all eligible
 * parts in one IMAP command while concurrent siblings wait on an atomic
 * distributed lease and then read their part from the shared bundle.
 */
class InlineAttachmentCache {
	// Keep both ceilings deliberately small. The target deployment has much
	// less RAM than mail data, so Redis must never become a general attachment
	// store merely because a message was opened.
	// The server-side bundle only needs to collapse sibling requests and an
	// immediate revisit, while the authenticated browser may safely reuse its
	// private copy for longer without consuming shared Redis memory.
	private const BUNDLE_CACHE_TTL = 15 * 60;
	private const BROWSER_CACHE_TTL = 60 * 60;
	private const MAX_PART_BYTES = 64 * 1024;
	private const MAX_BUNDLE_BYTES = 256 * 1024;
	private const MAX_PARTS = 32;
	private const LOCK_TTL = 45;
	private const WAIT_SECONDS = 45;
	private const WAIT_MICROSECONDS = 50_000;

	public function __construct(
		private IMailManager $mailManager,
		private ICacheFactory $cacheFactory,
		private LoggerInterface $logger,
	) {
	}

	public static function getBrowserCacheTtl(): int {
		return self::BROWSER_CACHE_TTL;
	}

	public function get(
		Account $account,
		Mailbox $mailbox,
		Message $message,
		int $messageId,
		string $attachmentId,
	): ?Attachment {
		$cache = $this->getCacheForAccount($account->getId());
		$cachedMessage = $cache->get("message_$messageId");
		if (
			!is_array($cachedMessage)
			|| !isset($cachedMessage['inlineAttachments'])
			|| !is_array($cachedMessage['inlineAttachments'])
		) {
			return null;
		}

		$candidateIds = $this->getCandidateIds($cachedMessage['inlineAttachments']);
		if (!in_array($attachmentId, $candidateIds, true)) {
			return null;
		}

		$bundle = $this->getBundleData(
			$cache,
			$account,
			$mailbox,
			$message,
			$messageId,
			$candidateIds,
		);
		if (!is_array($bundle)) {
			return null;
		}

		return $this->attachmentFromBundle($bundle, $attachmentId);
	}

	/**
	 * Load every eligible small inline image through one browser-facing
	 * request. The HTML response defers those image src attributes and its
	 * trusted helper calls this endpoint once, so the common path occupies one
	 * PHP worker instead of one leader plus many polling followers.
	 *
	 * @return array<string, Attachment>
	 */
	public function getBundle(
		Account $account,
		Mailbox $mailbox,
		Message $message,
		int $messageId,
	): array {
		$cache = $this->getCacheForAccount($account->getId());
		$cachedMessage = $cache->get("message_$messageId");
		if (
			!is_array($cachedMessage)
			|| !isset($cachedMessage['inlineAttachments'])
			|| !is_array($cachedMessage['inlineAttachments'])
		) {
			return [];
		}

		$candidateIds = $this->getCandidateIds($cachedMessage['inlineAttachments']);
		if ($candidateIds === []) {
			return [];
		}

		$bundle = $this->getBundleData(
			$cache,
			$account,
			$mailbox,
			$message,
			$messageId,
			$candidateIds,
		);
		if (!is_array($bundle)) {
			return [];
		}

		$attachments = [];
		foreach (array_keys($bundle) as $attachmentId) {
			// PHP silently casts a numeric-string array key to int, so a part
			// whose content id is "2" comes back from array_keys() as int 2.
			// Under strict_types that is a TypeError against the string
			// parameter below, and the whole inline-attachment request 500s.
			//
			// Live on 2026-07-28: a message whose inline parts are numbered
			// rather than named failed four times in a row, once per retry,
			// with "Argument #2 ($attachmentId) must be of type string, int
			// given". Content ids are usually <foo@bar> shapes, which is why
			// this went unnoticed until a message arrived without them.
			$attachmentId = (string)$attachmentId;
			$attachment = $this->attachmentFromBundle($bundle, $attachmentId);
			if ($attachment !== null) {
				$attachments[$attachmentId] = $attachment;
			}
		}

		return $attachments;
	}

	/**
	 * This is also the rendering admission policy. Only ids returned here are
	 * deferred from native <img src> loading into the one bundle request, so a
	 * policy change cannot accidentally make the renderer wait for a part the
	 * bundle endpoint will never attempt.
	 *
	 * @param array<array-key, mixed> $inlineAttachments
	 * @return list<string>
	 */
	public function getCandidateIds(array $inlineAttachments): array {
		$ids = [];
		$totalBytes = 0;

		foreach ($inlineAttachments as $inlineAttachment) {
			if (!is_array($inlineAttachment)) {
				continue;
			}

			$id = $inlineAttachment['id'] ?? null;
			if (!is_string($id) || $id === '') {
				continue;
			}

			$mime = $inlineAttachment['mime'] ?? '';
			if (!is_string($mime) || !str_starts_with($mime, 'image/')) {
				continue;
			}

			$size = (int)($inlineAttachment['size'] ?? 0);
			if (
				$size <= 0
				|| $size > self::MAX_PART_BYTES
				|| count($ids) >= self::MAX_PARTS
				|| $totalBytes + $size > self::MAX_BUNDLE_BYTES
			) {
				continue;
			}

			$ids[] = $id;
			$totalBytes += $size;
		}

		return $ids;
	}

	/**
	 * @param string[] $candidateIds
	 * @return array<string, array{
	 *     name: string|null,
	 *     type: string,
	 *     content: string,
	 *     size: int,
	 *     contentId: string|null,
	 *     disposition: string|null
	 * }>|null
	 */
	private function getBundleData(
		ICache $cache,
		Account $account,
		Mailbox $mailbox,
		Message $message,
		int $messageId,
		array $candidateIds,
	): ?array {
		$bundleKey = "inline_attachment_bundle_$messageId";
		$bundle = $cache->get($bundleKey);
		if (is_array($bundle)) {
			return $bundle;
		}

		if (!($cache instanceof IMemcache)) {
			$bundle = $this->loadBundle($account, $mailbox, $message, $candidateIds);
			$cache->set($bundleKey, $bundle, self::BUNDLE_CACHE_TTL);
			return $bundle;
		}

		return $this->getWithDistributedSingleFlight(
			$cache,
			$account,
			$mailbox,
			$message,
			$messageId,
			$candidateIds,
			$bundleKey,
		);
	}

	/**
	 * @param string[] $candidateIds
	 * @return array<string, array{
	 *     name: string|null,
	 *     type: string,
	 *     content: string,
	 *     size: int,
	 *     contentId: string|null,
	 *     disposition: string|null
	 * }>|null
	 */
	private function getWithDistributedSingleFlight(
		IMemcache $cache,
		Account $account,
		Mailbox $mailbox,
		Message $message,
		int $messageId,
		array $candidateIds,
		string $bundleKey,
	): ?array {
		$lockKey = "inline_attachment_bundle_lock_$messageId";
		$lockOwner = bin2hex(random_bytes(8));
		$deadline = microtime(true) + self::WAIT_SECONDS;

		do {
			$bundle = $cache->get($bundleKey);
			if (is_array($bundle)) {
				return $bundle;
			}

			if ($cache->add($lockKey, $lockOwner, self::LOCK_TTL)) {
				try {
					$this->logger->debug(
						'Loading ' . count($candidateIds)
						. " small inline MIME parts for message <$messageId> in one IMAP batch"
					);
					$bundle = $this->loadBundle($account, $mailbox, $message, $candidateIds);
					$cache->set($bundleKey, $bundle, self::BUNDLE_CACHE_TTL);
					return $bundle;
				} finally {
					// Never remove a successor's lease if this request ran
					// beyond its TTL and another worker acquired it.
					if ($cache->get($lockKey) === $lockOwner) {
						$cache->remove($lockKey);
					}
				}
			}

			usleep(self::WAIT_MICROSECONDS);
		} while (microtime(true) < $deadline);

		// A dead/stalled leader must not make a direct attachment request wait
		// forever. The controller falls back to the established single-part
		// path after this bounded wait.
		return null;
	}

	/**
	 * @param string[] $attachmentIds
	 * @return array<string, array{
	 *     name: string|null,
	 *     type: string,
	 *     content: string,
	 *     size: int,
	 *     contentId: string|null,
	 *     disposition: string|null
	 * }>
	 */
	private function loadBundle(
		Account $account,
		Mailbox $mailbox,
		Message $message,
		array $attachmentIds,
	): array {
		$attachments = $this->mailManager->getMailAttachments(
			$account,
			$mailbox,
			$message,
			$attachmentIds,
		);
		$bundle = [];
		$totalBytes = 0;

		foreach ($attachments as $attachment) {
			$id = $attachment->getId();
			$content = $attachment->getContent();
			$size = strlen($content);
			if (
				$id === null
				|| !in_array($id, $attachmentIds, true)
				|| !str_starts_with($attachment->getType(), 'image/')
				|| $size > self::MAX_PART_BYTES
				|| $totalBytes + $size > self::MAX_BUNDLE_BYTES
			) {
				continue;
			}

			$bundle[$id] = [
				'name' => $attachment->getName(),
				'type' => $attachment->getType(),
				'content' => $content,
				'size' => $size,
				'contentId' => $attachment->contentId,
				'disposition' => $attachment->disposition,
			];
			$totalBytes += $size;
		}

		return $bundle;
	}

	/**
	 * @param array<string, mixed> $bundle
	 */
	private function attachmentFromBundle(array $bundle, string $attachmentId): ?Attachment {
		$part = $bundle[$attachmentId] ?? null;
		if (
			!is_array($part)
			|| !isset($part['type'], $part['content'], $part['size'])
			|| !is_string($part['type'])
			|| !is_string($part['content'])
			|| !is_int($part['size'])
		) {
			return null;
		}

		return new Attachment(
			$attachmentId,
			isset($part['name']) && is_string($part['name']) ? $part['name'] : null,
			$part['type'],
			$part['content'],
			$part['size'],
			isset($part['contentId']) && is_string($part['contentId']) ? $part['contentId'] : null,
			isset($part['disposition']) && is_string($part['disposition']) ? $part['disposition'] : null,
		);
	}

	private function getCacheForAccount(int $accountId): ICache {
		return $this->cacheFactory->createDistributed("mail_account_$accountId");
	}
}
