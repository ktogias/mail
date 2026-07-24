/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { WorkClass } from './RequestCoordinator.js'

export async function probeMailHealth() {
	const { data } = await axios.get(generateUrl('/apps/mail/api/health'), {
		mailWorkClass: WorkClass.ACTIVE_CONTENT,
		timeout: 10_000,
	})
	return data
}
