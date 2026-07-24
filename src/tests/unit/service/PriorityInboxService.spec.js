/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { fetchPriorityInboxStats } from '../../../service/PriorityInboxService.js'
import { WorkClass } from '../../../service/RequestCoordinator.js'

vi.mock('@nextcloud/axios')
vi.mock('@nextcloud/router')

describe('service/PriorityInboxService', () => {
	it('fetches the local aggregate at active-content priority', async () => {
		generateUrl.mockReturnValue('/priority-stats')
		const stats = {
			sections: {
				favorite: { total: 2, unread: 1 },
				important: { total: 3, unread: 2 },
				other: { total: 5, unread: 0 },
			},
			complete: true,
		}
		axios.get.mockResolvedValue({ data: stats })

		await expect(fetchPriorityInboxStats('threaded')).resolves.toEqual(stats)
		expect(axios.get).toHaveBeenCalledWith('/priority-stats', {
			params: { view: 'threaded' },
			mailWorkClass: WorkClass.ACTIVE_CONTENT,
		})
	})
})
