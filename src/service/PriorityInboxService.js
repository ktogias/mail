/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { WorkClass } from './RequestCoordinator.js'

export async function fetchPriorityInboxStats(view, workClass = WorkClass.ACTIVE_CONTENT) {
	const response = await axios.get(generateUrl('/apps/mail/api/priority-inbox/stats'), {
		params: { view },
		mailWorkClass: workClass,
	})
	return response.data
}
