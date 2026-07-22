/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import * as DeepSearchService from '../../../service/DeepSearchService.js'

vi.mock('@nextcloud/axios')
vi.mock('@nextcloud/router')

describe('service/DeepSearchService', () => {
	afterEach(() => vi.clearAllMocks())

	it('starts a bounded composite-cursor background page', async () => {
		generateUrl.mockReturnValue('/search-jobs')
		const signal = new AbortController().signal
		axios.post.mockResolvedValue({
			data: {
				id: 9,
				accountId: 4,
				status: 'queued',
				results: [{ databaseId: 91, mailboxId: 23 }],
			},
		})

		const job = await DeepSearchService.startDeepSearch({
			mailboxId: 23,
			filter: 'subject:needle',
			cursor: 1_700_000_000,
			cursorId: 91,
			sort: 'DESC',
			view: 'threaded',
			limit: 20,
			prioritySplit: true,
			signal,
		})

		expect(axios.post).toHaveBeenCalledWith('/search-jobs', {
			mailboxId: 23,
			filter: 'subject:needle',
			cursor: 1_700_000_000,
			cursorId: 91,
			sort: 'DESC',
			view: 'threaded',
			limit: 20,
			prioritySplit: true,
		}, { signal })
		expect(job.results[0]).toEqual(expect.objectContaining({ accountId: 4, databaseId: 91 }))
	})

	it('polls and cancels an owner-scoped job URL', async () => {
		generateUrl.mockImplementation((url) => url.replace('{id}', '9'))
		axios.get.mockResolvedValue({ data: { id: 9, accountId: 4, results: [] } })
		axios.delete.mockResolvedValue({})

		await DeepSearchService.getDeepSearch(9)
		await DeepSearchService.cancelDeepSearch(9)

		expect(axios.get).toHaveBeenCalledWith('/apps/mail/api/search-jobs/9', { signal: undefined })
		expect(axios.delete).toHaveBeenCalledWith('/apps/mail/api/search-jobs/9')
	})
})
