/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'

export async function probeMailHealth() {
	const { data } = await axios.get(generateUrl('/apps/mail/api/health'), {
		// Recovery must not queue behind the requests whose health it is
		// trying to establish. This endpoint is authenticated, DB/IMAP-free,
		// separately routed, and bounded by the timeout below.
		mailPriorityBypass: true,
		timeout: 10_000,
	})
	return data
}
