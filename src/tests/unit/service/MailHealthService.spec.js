/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { probeMailHealth } from '../../../service/MailHealthService.js'

vi.mock('@nextcloud/axios')
vi.mock('@nextcloud/router')

describe('service/MailHealthService', () => {
	it('bypasses mail scheduling so recovery cannot queue behind stale permits', async () => {
		generateUrl.mockReturnValue('/mail-health')
		axios.get.mockResolvedValue({ data: { status: 'ok' } })

		await expect(probeMailHealth()).resolves.toEqual({ status: 'ok' })
		expect(axios.get).toHaveBeenCalledWith('/mail-health', {
			mailPriorityBypass: true,
			mailConnectivityProbe: true,
			timeout: 10_000,
		})
	})
})
