/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { WorkClass } from './RequestCoordinator.js'

/**
 * Send one diagnostic event to the server log.
 *
 * @nextcloud/logger writes to the browser console and nowhere else, which is
 * no help when the fault only reproduces on a phone. This exists so a
 * client-store problem -- which list key was written, by which source, whether
 * a replace cleared it -- can be read from the server log instead.
 *
 * Fire and forget, and never allowed to affect what it observes: the promise
 * is swallowed, so a failing or slow drain cannot delay or break the code path
 * being diagnosed. MAINTENANCE class for the same reason -- it must never
 * compete with the requests the user is waiting on.
 *
 * Temporary by intent. Delete with the investigation.
 *
 * @param {string} event short event name
 * @param {object} context flat bag of scalars
 */
export function reportDiagnostic(event, context = {}) {
	try {
		axios.post(
			generateUrl('/apps/mail/api/diagnostics/log'),
			{ event, context },
			{ mailWorkClass: WorkClass.MAINTENANCE },
		).catch(() => {})
	} catch (error) {
		// Diagnostics must never be the reason something failed.
	}
}
