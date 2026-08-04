<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Tests\Unit\Service;

use ChristophWurst\Nextcloud\Testing\TestCase;
use OCA\Mail\Service\IMipAttendeeRewriter;
use PHPUnit\Framework\MockObject\MockObject;
use Psr\Log\LoggerInterface;

class IMipAttendeeRewriterTest extends TestCase {
	private IMipAttendeeRewriter $rewriter;
	/** @var LoggerInterface&MockObject */
	private $logger;

	protected function setUp(): void {
		parent::setUp();
		$this->logger = $this->createMock(LoggerInterface::class);
		$this->rewriter = new IMipAttendeeRewriter($this->logger);
	}

	/**
	 * A cancellation exactly as one arrives through a mailing list: the list is
	 * the attendee, the user is nowhere in it.
	 */
	private function listCancellation(): string {
		return "BEGIN:VCALENDAR\r\n"
			. "VERSION:2.0\r\n"
			. "METHOD:CANCEL\r\n"
			. "BEGIN:VEVENT\r\n"
			. "UID:040000008200E00074C5B7101A82E008\r\n"
			. "SEQUENCE:3\r\n"
			. "DTSTAMP:20260804T090000Z\r\n"
			. "DTSTART:20260810T090000Z\r\n"
			. "ORGANIZER:mailto:apalivou@athenarc.gr\r\n"
			. "ATTENDEE;RSVP=TRUE;CN=sunrise6g-wp6:mailto:sunrise6g-wp6@lists.athenarc.gr\r\n"
			. "STATUS:CANCELLED\r\n"
			. "END:VEVENT\r\n"
			. "END:VCALENDAR\r\n";
	}

	public function testAddsTheUserWhenOnlyAMailingListIsAddressed(): void {
		// The whole point. Without this the calendar layer throws "iMip message
		// dose not contain an attendee that matches the user" and the
		// cancellation is lost -- the meeting stays in the calendar confirmed.
		$result = $this->rewriter->addRecipientIfUnmatched($this->listCancellation(), 'ktogias@gmail.com');

		self::assertNotNull($result);
		self::assertStringContainsString('mailto:ktogias@gmail.com', $result);
		// The list stays: we are adding a recipient, not replacing the invitation.
		self::assertStringContainsString('mailto:sunrise6g-wp6@lists.athenarc.gr', $result);
		// And nothing else about the event is touched.
		self::assertStringContainsString('SEQUENCE:3', $result);
		self::assertStringContainsString('STATUS:CANCELLED', $result);
	}

	public function testLeavesAMessageAlreadyAddressedToTheUserAlone(): void {
		// Returning null rather than an identical string is the contract: the
		// caller uses it to decide whether to log a rewrite at all, and
		// re-serialising a message the ordinary path would have handled is a
		// chance to change it for no reason.
		$addressed = str_replace(
			'ATTENDEE;RSVP=TRUE;CN=sunrise6g-wp6:mailto:sunrise6g-wp6@lists.athenarc.gr',
			'ATTENDEE;RSVP=TRUE:mailto:ktogias@gmail.com',
			$this->listCancellation(),
		);

		self::assertNull($this->rewriter->addRecipientIfUnmatched($addressed, 'ktogias@gmail.com'));
	}

	public function testMatchesTheAddressWithoutRegardToCase(): void {
		// Addresses arrive spelled however the organiser's client felt like it.
		// A case-sensitive comparison would add a duplicate attendee for an
		// invitation that already names the user.
		$shouty = str_replace(
			'mailto:sunrise6g-wp6@lists.athenarc.gr',
			'MAILTO:KTogias@Gmail.com',
			$this->listCancellation(),
		);

		self::assertNull($this->rewriter->addRecipientIfUnmatched($shouty, 'ktogias@gmail.com'));
	}

	public function testRefusesWithoutAnOrganiser(): void {
		// The calendar layer requires one, so a rewrite could not rescue this
		// message and would only obscure the real reason it failed.
		$noOrganiser = str_replace("ORGANIZER:mailto:apalivou@athenarc.gr\r\n", '', $this->listCancellation());

		self::assertNull($this->rewriter->addRecipientIfUnmatched($noOrganiser, 'ktogias@gmail.com'));
	}

	public function testRefusesWithoutAnAddressToAdd(): void {
		// A user with no email on their Nextcloud account. Adding
		// "mailto:" alone would produce an attendee that matches nothing and
		// turn a clear failure into a confusing one.
		self::assertNull($this->rewriter->addRecipientIfUnmatched($this->listCancellation(), ''));
	}

	public function testSurvivesRubbish(): void {
		// iMIP parts are attacker-influenced. A parse failure must leave the
		// original message to the calendar layer, which reports it properly.
		self::assertNull($this->rewriter->addRecipientIfUnmatched('this is not iCalendar', 'ktogias@gmail.com'));
	}

	public function testIgnoresAnObjectWithNoEvent(): void {
		$noEvent = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:CANCEL\r\nEND:VCALENDAR\r\n";

		self::assertNull($this->rewriter->addRecipientIfUnmatched($noEvent, 'ktogias@gmail.com'));
	}
}
