<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service\Search;

class SearchQuery {
	/** @var int|null */
	private $cursor;

	/** @var int|null */
	private $cursorId;

	private bool $threaded = true;

	/** @var Flag[] */
	private $flags = [];

	/** @var FlagExpression[] */
	private $flagExpressions = [];

	/**
	 * Flags whose POSITIVE form must not be present on ANY message of a
	 * thread for the thread to match, in threaded view -- partition
	 * ("remainder-category") semantics: is:pi-other means "no message in
	 * this thread is important", not "some message isn't". This is a
	 * deliberately separate collection from $flags because the sign of a
	 * Flag alone cannot express the difference: "unread" also arrives as
	 * a negative flag (SEEN=false) but must keep EXISTENTIAL thread
	 * semantics ("some member is unseen") -- the exact behavior the
	 * thread-wide EXISTS match was introduced for. Entries here always
	 * carry the positive form (isSet() === true); in flat/singleton view
	 * they degrade to a plain negated per-message column check,
	 * identical to what a negated $flags entry produces.
	 *
	 * @var Flag[]
	 */
	private $threadExcludedFlags = [];

	/** @var string[] */
	private $to = [];

	/** @var string[] */
	private $from = [];

	/** @var string[] */
	private $cc = [];

	/** @var string[] */
	private $bcc = [];

	/** @var string[] */
	private $subjects = [];

	/** @var string[] */
	private $bodies = [];

	/** @var array[] */
	private $tags = [];

	/** @var string|null */
	private $start;

	/** @var string|null */
	private $end;

	/** @var bool */
	private $hasAttachments = false;

	/** @var bool */
	private $mentionsMe = false;

	private string $match = 'allof';

	/**
	 * @return int|null
	 * @psalm-mutation-free
	 */
	public function getCursor(): ?int {
		return $this->cursor;
	}

	/**
	 * @param int $cursor
	 */
	public function setCursor(int $cursor): void {
		$this->cursor = $cursor;
	}

	/**
	 * Database id of the row at the timestamp cursor. Together with
	 * $cursor this forms a stable keyset cursor for sent_at ties.
	 */
	public function getCursorId(): ?int {
		return $this->cursorId;
	}

	public function setCursorId(int $cursorId): void {
		$this->cursorId = $cursorId;
	}

	public function getThreaded(): bool {
		return $this->threaded;
	}

	public function setThreaded(bool $threaded): void {
		$this->threaded = $threaded;
	}

	public function getMatch(): string {
		return $this->match;
	}

	public function setMatch(string $match): void {
		$this->match = $match;
	}

	/**
	 * @return Flag[]
	 * @psalm-mutation-free
	 */
	public function getFlags(): array {
		return $this->flags;
	}

	public function addFlag(Flag $flag): void {
		$this->flags[] = $flag;
	}

	/**
	 * @return FlagExpression[]
	 */
	public function getFlagExpressions(): array {
		return $this->flagExpressions;
	}

	public function addFlagExpression(FlagExpression $expression): void {
		$this->flagExpressions[] = $expression;
	}

	/**
	 * @return Flag[]
	 * @psalm-mutation-free
	 */
	public function getThreadExcludedFlags(): array {
		return $this->threadExcludedFlags;
	}

	public function addThreadExcludedFlag(Flag $flag): void {
		$this->threadExcludedFlags[] = $flag;
	}

	/**
	 * @return string[]
	 */
	public function getTo(): array {
		return $this->to;
	}

	public function addTo(string $to): void {
		$this->to[] = $to;
	}

	/**
	 * @return string[]
	 */
	public function getFrom(): array {
		return $this->from;
	}

	public function addFrom(string $from): void {
		$this->from[] = $from;
	}

	/**
	 * @return string[]
	 */
	public function getCc(): array {
		return $this->cc;
	}

	public function addCc(string $cc): void {
		$this->cc[] = $cc;
	}

	/**
	 * @return string[]
	 */
	public function getBcc(): array {
		return $this->bcc;
	}

	public function addBcc(string $bcc): void {
		$this->bcc[] = $bcc;
	}

	public function getSubjects(): array {
		return $this->subjects;
	}

	public function addSubject(string $subject): void {
		$this->subjects[] = $subject;
	}
	public function getBodies(): array {
		return $this->bodies;
	}

	public function addBody(string $body): void {
		$this->bodies[] = $body;
	}

	/**
	 * Get tags to search query
	 *
	 * @return array
	 */
	public function getTags(): array {
		return $this->tags;
	}

	/**
	 * Set tags to search query
	 *
	 * @param array $tags
	 * @return void
	 */
	public function setTags(array $tags): void {
		$this->tags = $tags;
	}

	/**
	 * Get start date to search query
	 *
	 * @return string|null
	 */
	public function getStart(): ?string {
		return $this->start;
	}

	/**
	 * Set start date to search query
	 *
	 * @param string $start
	 * @return void
	 */
	public function setStart(string $start): void {
		$this->start = $start;
	}

	/**
	 * Get start date to search query
	 *
	 * @return string|null
	 */
	public function getEnd(): ?string {
		return $this->end;
	}

	/**
	 * Set end date to search query
	 *
	 * @param string $end
	 * @return void
	 */
	public function setEnd(string $end): void {
		$this->end = $end;
	}

	/**
	 * @return bool|null
	 * @psalm-mutation-free
	 */
	public function getHasAttachments(): ?bool {
		return $this->hasAttachments;
	}

	/**
	 * @param bool $hasAttachments
	 */
	public function setHasAttachments(bool $hasAttachments): void {
		$this->hasAttachments = $hasAttachments;
	}

	/**
	 * @return bool
	 */
	public function getMentionsMe(): bool {
		return $this->mentionsMe;
	}

	/**
	 * @param bool $hasAttachments
	 */
	public function setMentionsMe(bool $mentionsMe): void {
		$this->mentionsMe = $mentionsMe;
	}
}
