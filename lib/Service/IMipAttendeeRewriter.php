<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Service;

use Psr\Log\LoggerInterface;
use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Reader;
use Throwable;
use function in_array;
use function strtolower;

/**
 * Make an iMIP message addressed to a mailing list processable.
 *
 * An invitation that reaches you through a list carries the LIST as its
 * ATTENDEE, never you. Nextcloud's CalDAV layer refuses such a message --
 * CalendarImpl::handleIMipMessage throws "iMip message dose not contain an
 * attendee that matches the user" -- so the whole conversation with that
 * organiser is unprocessable: invitations, reschedules and, worst of all,
 * cancellations. The meeting stays in your calendar looking confirmed after it
 * has been called off.
 *
 * This app already has a per-account answer for the same problem in the UI: the
 * "party crasher", where accepting an unmatched invitation adds you as an
 * attendee so the reply still reaches the organiser (see Imip.vue). The
 * background job never learned it -- getImipAllowUnmatched() was read only by
 * jsonSerialize(), which is to say only by the browser. This is that setting
 * applied where the automatic processing happens.
 *
 * The address added must be one the CalDAV PRINCIPAL recognises, not the
 * receiving mail account's. The check compares against the principal's
 * calendar-user-address-set, and this install is the ordinary case: the
 * principal knows the Nextcloud user's address, while the mail account is a
 * different domain entirely.
 *
 * Nothing of the added attendee survives into the calendar for a CANCEL:
 * Sabre's processMessageCancel() only sets STATUS and SEQUENCE on the stored
 * object and never merges the incoming attendee list. The address exists to
 * pass a recipient check, not to change the event.
 */
class IMipAttendeeRewriter {
	public function __construct(
		private LoggerInterface $logger,
	) {
	}

	/**
	 * Add the principal's own address as an attendee when none matches.
	 *
	 * @param string $contents the raw iCalendar object from the message
	 * @param string $principalAddress an address the CalDAV principal knows
	 * @return string|null the rewritten object, or null to use the original
	 */
	public function addRecipientIfUnmatched(string $contents, string $principalAddress): ?string {
		if (trim($principalAddress) === '') {
			return null;
		}

		try {
			$vObject = Reader::read($contents);
		} catch (Throwable $e) {
			// Not this service's job to report: the calendar layer will reject
			// an unparseable object with a better message than we could.
			$this->logger->debug('Could not parse an iMIP object to check its attendees', ['exception' => $e]);
			return null;
		}

		if (!$vObject instanceof VCalendar || !isset($vObject->VEVENT)) {
			return null;
		}
		$vEvent = $vObject->VEVENT;

		// An organiser is required for the calendar layer to accept the message
		// at all, and its absence means this rewrite cannot help.
		if (!isset($vEvent->ORGANIZER)) {
			return null;
		}

		$wanted = 'mailto:' . strtolower(ltrim($principalAddress, ' '));
		$attendees = [];
		if (isset($vEvent->ATTENDEE)) {
			foreach ($vEvent->ATTENDEE as $attendee) {
				$attendees[] = strtolower((string)$attendee->getValue());
			}
		}

		if (in_array($wanted, $attendees, true)) {
			// Already addressed to us; the ordinary path handles it.
			return null;
		}

		// PARTSTAT is deliberately omitted rather than guessed. For a CANCEL it
		// is never read, and inventing a participation status would be a claim
		// about a reply that was never sent.
		$vEvent->add('ATTENDEE', $wanted, ['CN' => $principalAddress]);

		return $vObject->serialize();
	}
}
