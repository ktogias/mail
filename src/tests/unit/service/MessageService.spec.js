/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import * as MessageService from '../../../service/MessageService.js'

vi.mock('@nextcloud/axios')
vi.mock('@nextcloud/router')

describe('service/MessageService test suite', () => {
	afterEach(() => {
		vi.clearAllMocks()
	})

	it('should include a given cache buster as a URL parameter', async () => {
		generateUrl.mockReturnValueOnce('/generated-url')
		axios.get.mockResolvedValueOnce({ data: [] })

		await MessageService.fetchEnvelopes(
			13, // account id
			21, // mailbox id
			undefined, // query
			undefined, // cursor
			undefined, // limit
			undefined, // sort ordre
			undefined, // layout
			'abcdef123', // cache buster
		)

		expect(axios.get).toHaveBeenCalledWith('/generated-url', {
			params: {
				mailboxId: 21,
				v: 'abcdef123',
			},
		})
	})

	it('should not include a cache buster by default', async () => {
		generateUrl.mockReturnValueOnce('/generated-url')
		axios.get.mockResolvedValueOnce({ data: [] })

		await MessageService.fetchEnvelopes(
			13, // account id
			21, // mailbox id
		)

		expect(axios.get).toHaveBeenCalledWith('/generated-url', {
			params: {
				mailboxId: 21,
			},
		})
	})

	describe('syncEnvelopes', () => {
		beforeEach(() => {
			generateUrl.mockReturnValue('/generated-url')
		})

		it('returns the envelopes on a well-formed response', async () => {
			axios.post.mockResolvedValueOnce({
				status: 200,
				data: {
					newMessages: [{ databaseId: 1 }],
					changedMessages: [{ databaseId: 2 }],
					vanishedMessages: [3],
					stats: { unread: 1 },
					serverBusy: false,
				},
			})

			const result = await MessageService.syncEnvelopes(13, 21, [], null, undefined, false, 'newest')

			expect(result.newMessages).toEqual([{ accountId: 13, databaseId: 1 }])
			expect(result.changedMessages).toEqual([{ accountId: 13, databaseId: 2 }])
			expect(result.vanishedMessages).toEqual([3])
		})

		it('throws a clear, catchable error instead of crashing on a malformed response body', async () => {
			// Regression: confirmed live -- a 200 response whose body was
			// missing newMessages/changedMessages crashed with a raw,
			// uninformative TypeError ("can't access property map,
			// undefined") instead of a clear, retriable error. Root cause
			// not yet pinned down (seen only under heavy concurrent load),
			// but the client must not crash on it either way.
			axios.post.mockResolvedValueOnce({
				status: 200,
				data: {
					message: 'Too many sync attempts for mailbox 21, please slow down',
					type: 'OCA\\Mail\\Exception\\MailboxLockedException',
				},
			})

			await expect(MessageService.syncEnvelopes(13, 21, [], null, undefined, false, 'newest'))
				.rejects.toThrow('Malformed sync response for mailbox 21')
		})
	})
})
