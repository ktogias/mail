/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import * as DeepSearchService from '../../../service/DeepSearchService.js'
import { WorkClass } from '../../../service/RequestCoordinator.js'

vi.mock('@nextcloud/axios')
vi.mock('@nextcloud/router')

describe('service/DeepSearchService', () => {
	afterEach(() => vi.clearAllMocks())

	// The poll-and-cancel test that used to live here went with the endpoints
	// it exercised. There is no job to poll and none to cancel: a client that
	// stops asking ends the search.

	it('sends one bounded stretch with its mode and continuation token', async () => {
		generateUrl.mockReturnValue('/apps/mail/api/deep-search')
		const signal = new AbortController().signal
		axios.post.mockResolvedValue({
			data: {
				accountId: 4,
				results: [{ databaseId: 91, mailboxId: 23 }],
				searchedThrough: 1_690_000_000,
				nextEnd: 1_689_999_999,
				exhausted: false,
				windows: 2,
				durationMs: 120,
				mode: 'headers',
			},
		})

		const page = await DeepSearchService.deepSearch({
			mailboxId: 23,
			filter: 'subject:needle',
			cursor: 1_700_000_000,
			cursorId: 91,
			sort: 'DESC',
			view: 'threaded',
			limit: 20,
			prioritySplit: true,
			nextEnd: 1_695_000_000,
			mode: DeepSearchService.MODE_HEADERS,
			signal,
		})

		expect(axios.post).toHaveBeenCalledWith('/apps/mail/api/deep-search', {
			mailboxId: 23,
			filter: 'subject:needle',
			cursor: 1_700_000_000,
			cursorId: 91,
			sort: 'DESC',
			view: 'threaded',
			limit: 20,
			prioritySplit: true,
			nextEnd: 1_695_000_000,
			mode: 'headers',
		}, {
			signal,
			mailWorkClass: WorkClass.MAINTENANCE,
		})
		expect(page.results[0]).toEqual(expect.objectContaining({ accountId: 4, databaseId: 91 }))
		expect(page.nextEnd).toBe(1_689_999_999)
	})

	it('starts a fresh walk with a null continuation and the headers mode', async () => {
		generateUrl.mockReturnValue('/apps/mail/api/deep-search')
		axios.post.mockResolvedValue({ data: { accountId: 4, results: [], nextEnd: null, exhausted: true } })

		await DeepSearchService.deepSearch({
			mailboxId: 23,
			filter: 'subject:needle',
			cursor: 1_700_000_000,
		})

		expect(axios.post.mock.calls[0][1]).toEqual(expect.objectContaining({
			nextEnd: null,
			mode: 'headers',
			prioritySplit: false,
		}))
	})

	/**
	 * The client decides whether to open a body stream at all, and it must not
	 * be fooled by a header term that merely contains the word.
	 */
	it('recognises body terms without being fooled by lookalikes', () => {
		expect(DeepSearchService.hasBodyTerms('body:needle')).toBe(true)
		expect(DeepSearchService.hasBodyTerms('subject:x body:needle')).toBe(true)
		expect(DeepSearchService.hasBodyTerms('subject:body')).toBe(false)
		expect(DeepSearchService.hasBodyTerms('subject:somebody:x')).toBe(false)
		expect(DeepSearchService.hasBodyTerms('')).toBe(false)
		expect(DeepSearchService.hasBodyTerms(undefined)).toBe(false)
	})
})
