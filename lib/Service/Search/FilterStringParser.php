<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Search;

use function urldecode;

class FilterStringParser {
	public function parse(?string $filter): SearchQuery {
		$query = new SearchQuery();
		if (empty($filter)) {
			return $query;
		}
		$tokens = explode(' ', $filter);
		foreach ($tokens as $token) {
			$this->parseFilterToken($query, $token);
		}

		return $query;
	}

	private function parseFilterToken(SearchQuery $query, string $token): bool {
		if (!str_contains($token, ':')) {
			return false;
		}

		[$type, $encodedParam] = explode(':', $token);
		$param = urldecode($encodedParam);
		$type = strtolower($type);
		$flagMap = [
			'answered' => Flag::is(Flag::ANSWERED),
			'read' => Flag::is(Flag::SEEN),
			'unread' => Flag::not(Flag::SEEN),
			'starred' => Flag::is(Flag::FLAGGED),
			'important' => Flag::is(Flag::IMPORTANT),
			'is_important' => FlagExpression::and(
				Flag::is(Flag::IMPORTANT)
			)
		];

		switch ($type) {
			case 'is':
			case 'not':
				// Partition ("remainder-category") tokens: not:starred and
				// is:pi-other exist to make one Priority Inbox section the
				// complement of another (Other = threads with NO important
				// member; the not:starred compounds = threads with NO
				// starred member, when favorites sort separately). In
				// threaded view these must negate the THREAD-level
				// attribute (NOT EXISTS a matching member), not assert the
				// existence of a non-matching member -- otherwise every
				// mixed thread appears in both sections at once (reported
				// live). Deliberately NOT applied to other not:X tokens:
				// "unread" (SEEN=false) keeps its existential semantics --
				// a thread with any unseen member must keep matching the
				// unread filter.
				if ($type === 'not' && $param === 'starred') {
					$query->addThreadExcludedFlag(Flag::is(Flag::FLAGGED));
					return true;
				}
				if (array_key_exists($param, $flagMap)) {
					/** @var Flag $flag */
					$flag = $flagMap[$param];
					$query->addFlag($type === 'is' ? $flag : $flag->invert());
					return true;
				}
				if ($param === 'pi-important') {
					$query->addFlagExpression(
						FlagExpression::and(
							Flag::is(Flag::IMPORTANT),
						)
					);

					return true;
				}
				if ($param === 'pi-other') {
					$query->addThreadExcludedFlag(Flag::is(Flag::IMPORTANT));

					return true;
				}

				break;
			case 'from':
				$query->addFrom($param);
				return true;
			case 'to':
				$query->addTo($param);
				return true;
			case 'cc':
				$query->addCc($param);
				return true;
			case 'bcc':
				$query->addBcc($param);
				return true;
			case 'subject':
				$query->addSubject($param);
				return true;
			case 'text':
				$query->addText($param);
				return true;
			case 'body':
				$query->addBody($param);
				return true;
			case 'tags':
				$tags = explode(',', $param);
				$query->setTags($tags);
				return true;
			case 'start':
				if (!empty($param)) {
					$query->setStart($param);
				}
				return true;
			case 'end':
				if (!empty($param)) {
					$query->setEnd($param);
				}
				return true;
			case 'match':
				$query->setMatch($param);
				return true;
			case 'mentions':
				if ($param === 'true') {
					$query->setMentionsMe(true);
				}
				return true;
			case 'flags':
				$flagArray = explode(',', $param);
				foreach ($flagArray as $flagItem) {
					if (array_key_exists($flagItem, $flagMap)) {
						/** @var Flag $flag */
						$flag = $flagMap[$flagItem];
						if ($flag instanceof Flag) {
							$query->addFlag($flag);
						} elseif ($flag instanceof FlagExpression) {
							$query->addFlagExpression($flag);
						}
					} elseif ($flagItem === 'attachments') {
						$query->setHasAttachments(true);
					}
				}

				return true;
		}

		return false;
	}
}
