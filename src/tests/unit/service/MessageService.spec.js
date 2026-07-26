/**
 * SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import * as MessageService from '../../../service/MessageService.js'
import { WorkClass } from '../../../service/RequestCoordinator.js'

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
			mailAccountId: 13,
			mailWorkClass: 'active-content',
			params: {
				mailboxId: 21,
				v: 'abcdef123',
			},
			signal: undefined,
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
			mailAccountId: 13,
			mailWorkClass: 'active-content',
			params: {
				mailboxId: 21,
			},
			signal: undefined,
		})
	})

	describe('active message capacity recovery', () => {
		const capacityError = (status = 429, headers = {}) => ({
			response: {
				status,
				headers,
				data: {},
			},
		})

		beforeEach(() => {
			vi.useFakeTimers()
			axios.isCancel.mockReturnValue(false)
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('briefly retries a visible message and honors Retry-After', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			axios.get
				.mockRejectedValueOnce(capacityError(429, { 'retry-after': '1' }))
				.mockResolvedValueOnce({ data: { id: 42 } })

			const result = MessageService.fetchMessage(42)
			await vi.advanceTimersByTimeAsync(999)
			expect(axios.get).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(1)

			await expect(result).resolves.toEqual({ id: 42 })
			expect(axios.get).toHaveBeenCalledTimes(2)
		})

		it('never retries speculative prefetch', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			axios.get.mockRejectedValueOnce(capacityError())

			await expect(MessageService.fetchMessage(42, { speculative: true }))
				.rejects.toMatchObject({ isTransient: true, httpStatus: 429 })
			expect(axios.get).toHaveBeenCalledTimes(1)
			expect(axios.get).toHaveBeenCalledWith('/generated-url', expect.objectContaining({
				mailRequestKey: 'message-body:42',
				mailWorkClass: WorkClass.SPECULATIVE,
			}))
		})

		it('marks an exhausted temporary failure as transient instead of not-found', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			axios.get.mockRejectedValue(capacityError())

			const result = MessageService.fetchMessage(42)
			const rejection = expect(result).rejects.toMatchObject({
				isTransient: true,
				httpStatus: 429,
			})
			await vi.runAllTimersAsync()

			await rejection
			expect(axios.get).toHaveBeenCalledTimes(3)
			expect(axios.get).toHaveBeenLastCalledWith('/generated-url', expect.objectContaining({
				mailRequestKey: 'message-body:42',
				mailWorkClass: WorkClass.ACTIVE_CONTENT,
			}))
		})
	})

	it('gives speculative and active thread calls the same promotion key', async () => {
		generateUrl.mockReturnValue('/generated-url')
		axios.get.mockResolvedValue({ data: [] })

		await MessageService.fetchThread(73, { speculative: true })
		await MessageService.fetchThread(73)

		expect(axios.get).toHaveBeenNthCalledWith(1, '/generated-url', expect.objectContaining({
			mailRequestKey: 'message-thread:73',
			mailWorkClass: WorkClass.SPECULATIVE,
		}))
		expect(axios.get).toHaveBeenNthCalledWith(2, '/generated-url', expect.objectContaining({
			mailRequestKey: 'message-thread:73',
			mailWorkClass: WorkClass.ACTIVE_CONTENT,
		}))
	})

	it('requests an exact server-side Priority Inbox split when asked', async () => {
		generateUrl.mockReturnValueOnce('/generated-url')
		axios.get.mockResolvedValueOnce({ data: [] })

		await MessageService.fetchEnvelopes(
			13,
			21,
			'subject:needle',
			undefined,
			20,
			'newest',
			'threaded',
			undefined,
			undefined,
			true,
		)

		expect(axios.get).toHaveBeenCalledWith('/generated-url', {
			mailAccountId: 13,
			mailWorkClass: 'active-content',
			params: {
				mailboxId: 21,
				filter: 'subject:needle',
				limit: 20,
				sort: 'newest',
				view: 'threaded',
				prioritySplit: true,
			},
			signal: undefined,
		})
	})

	it('sends the database-id tie breaker with a timestamp cursor', async () => {
		generateUrl.mockReturnValueOnce('/generated-url')
		axios.get.mockResolvedValueOnce({ data: [] })

		await MessageService.fetchEnvelopes(13, 21, 'subject:needle', 1700000000, 20, 'newest', 'threaded', undefined, undefined, false, 4321)

		expect(axios.get).toHaveBeenCalledWith('/generated-url', {
			mailAccountId: 13,
			mailWorkClass: 'active-content',
			params: {
				mailboxId: 21,
				filter: 'subject:needle',
				cursor: 1700000000,
				cursorId: 4321,
				limit: 20,
				sort: 'newest',
				view: 'threaded',
			},
			signal: undefined,
		})
	})

	describe('rethrows the original error instead of crashing when a request never receives a response', () => {
		// Confirmed live: backgrounding the browser tab on Android mid-load
		// (or any other network failure with no HTTP response at all --
		// lost connection, DNS failure) previously crashed inside
		// parseErrorResponse() trying to read .headers off `undefined`,
		// surfacing to the user as "can't access property 'headers', e is
		// undefined" instead of a real error. error.response is undefined
		// for exactly this class of failure -- these calls never even
		// reach the 404/isCancel branches above them.
		it('fetchMessage', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			axios.isCancel.mockReturnValue(false)
			const networkError = new Error('Network Error')
			axios.get.mockRejectedValueOnce(networkError)

			await expect(MessageService.fetchMessage(42)).rejects.toBe(networkError)
		})

		it('fetchMessageItineraries', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			const networkError = new Error('Network Error')
			axios.get.mockRejectedValueOnce(networkError)

			await expect(MessageService.fetchMessageItineraries(42)).rejects.toBe(networkError)
		})

		it('classifies itineraries as cancellable speculative enrichment', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			axios.get.mockResolvedValueOnce({ data: [] })
			const controller = new AbortController()

			await MessageService.fetchMessageItineraries(42, { signal: controller.signal })

			expect(axios.get).toHaveBeenCalledWith('/generated-url', {
				signal: controller.signal,
				mailWorkClass: WorkClass.SPECULATIVE,
			})
		})

		it('preserves an itinerary capacity response after parsing', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			axios.get.mockRejectedValueOnce({
				response: {
					status: 429,
					headers: { 'x-mail-response': '1' },
					data: {
						status: 'error',
						data: { message: 'Mail account is busy' },
					},
				},
			})

			await expect(MessageService.fetchMessageItineraries(42)).rejects.toMatchObject({
				httpStatus: 429,
				isTransient: true,
				message: 'Mail account is busy',
			})
		})

		it('fetchMessageDkim', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			const networkError = new Error('Network Error')
			axios.get.mockRejectedValueOnce(networkError)

			await expect(MessageService.fetchMessageDkim(42)).rejects.toBe(networkError)
		})

		it('classifies DKIM as cancellable speculative enrichment', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			axios.get.mockResolvedValueOnce({ data: {} })
			const controller = new AbortController()

			await MessageService.fetchMessageDkim(42, { signal: controller.signal })

			expect(axios.get).toHaveBeenCalledWith('/generated-url', {
				signal: controller.signal,
				mailWorkClass: WorkClass.SPECULATIVE,
			})
		})

		it('preserves a DKIM capacity response after parsing', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			axios.get.mockRejectedValueOnce({
				response: {
					status: 429,
					headers: { 'x-mail-response': '1' },
					data: {
						status: 'error',
						data: { message: 'Mail account is busy' },
					},
				},
			})

			await expect(MessageService.fetchMessageDkim(42)).rejects.toMatchObject({
				httpStatus: 429,
				isTransient: true,
				message: 'Mail account is busy',
			})
		})

		it('fetchEnvelope', async () => {
			generateUrl.mockReturnValueOnce('/generated-url')
			const networkError = new Error('Network Error')
			axios.get.mockRejectedValueOnce(networkError)

			await expect(MessageService.fetchEnvelope(13, 42)).rejects.toBe(networkError)
		})

		it.each([403, 404])('treats a terminal %i envelope response as gone', async (status) => {
			generateUrl.mockReturnValueOnce('/generated-url')
			axios.get.mockRejectedValueOnce({ response: { status, headers: {}, data: [] } })

			await expect(MessageService.fetchEnvelope(13, 42)).resolves.toBeUndefined()
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

			const result = await MessageService.syncEnvelopes(13, 21, [1], null, undefined, false, 'newest', WorkClass.VISIBLE_REVALIDATION, {
				1: '123:010:100',
			})

			expect(result.newMessages).toEqual([{ accountId: 13, databaseId: 1 }])
			expect(result.changedMessages).toEqual([{ accountId: 13, databaseId: 2 }])
			expect(result.vanishedMessages).toEqual([3])
			expect(axios.post).toHaveBeenCalledWith('/generated-url', expect.objectContaining({
				ids: [1],
				states: { 1: '123:010:100' },
			}), expect.any(Object))
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

	describe('free-text search concurrency cap', () => {
		const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
		const deferred = () => {
			let resolve
			const promise = new Promise((r) => {
				resolve = r
			})
			return { promise, resolve: (v) => resolve(v) }
		}

		it('caps concurrent free-text searches at 2 and queues the rest', async () => {
			generateUrl.mockReturnValue('/url')
			const d = [deferred(), deferred(), deferred(), deferred()]
			let i = 0
			axios.get.mockImplementation(() => d[i++].promise)

			// A mix of the free-text predicates (body:, to:, subject:, from:) --
			// all share the one limiter.
			const queries = ['body:etsi', 'to:etsi', 'subject:etsi', 'from:etsi']
			const running = queries.map((q) => MessageService.fetchEnvelopes(13, 21, q))
			await flush()

			// Only two of the four searches are in flight; the pool keeps its
			// remaining workers free.
			expect(axios.get).toHaveBeenCalledTimes(2)

			// One finishes -> the next queued search starts.
			d[0].resolve({ data: [] })
			await flush()
			expect(axios.get).toHaveBeenCalledTimes(3)

			d[1].resolve({ data: [] })
			d[2].resolve({ data: [] })
			d[3].resolve({ data: [] })
			await Promise.allSettled(running)
		})

		it('never throttles structural bucket filters or unfiltered fetches', async () => {
			generateUrl.mockReturnValue('/url')
			const busy = [deferred(), deferred()]
			let c = 0
			axios.get.mockImplementation(() => (c < 2 ? busy[c++].promise : Promise.resolve({ data: [] })))

			// Occupy both free-text search slots.
			const s1 = MessageService.fetchEnvelopes(13, 21, 'subject:etsi')
			const s2 = MessageService.fetchEnvelopes(13, 21, 'body:etsi')
			await flush()
			expect(axios.get).toHaveBeenCalledTimes(2)

			// A structural bucket filter (priority-inbox section) must fire
			// immediately, not queue behind the searches.
			await MessageService.fetchEnvelopes(13, 21, 'not:starred is:pi-other')
			expect(axios.get).toHaveBeenCalledTimes(3)
			// An unfiltered fetch too.
			await MessageService.fetchEnvelopes(13, 21, undefined)
			expect(axios.get).toHaveBeenCalledTimes(4)

			busy[0].resolve({ data: [] })
			busy[1].resolve({ data: [] })
			await Promise.allSettled([s1, s2])
		})
	})

	describe('flag mutation concurrency cap', () => {
		const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
		const deferred = () => {
			let resolve
			const promise = new Promise((r) => {
				resolve = r
			})
			return { promise, resolve }
		}

		it('serializes flag writes so thread-wide updates cannot exhaust the reserved IMAP slot', async () => {
			generateUrl.mockReturnValue('/flags')
			const first = deferred()
			const second = deferred()
			axios.put
				.mockImplementationOnce(() => first.promise)
				.mockImplementationOnce(() => second.promise)

			const firstWrite = MessageService.setEnvelopeFlags(1, { seen: true })
			const secondWrite = MessageService.setEnvelopeFlags(2, { seen: true })
			await flush()

			expect(axios.put).toHaveBeenCalledTimes(1)

			first.resolve({ data: { hasUnseenInThread: true } })
			await flush()
			expect(axios.put).toHaveBeenCalledTimes(2)

			second.resolve({ data: { hasUnseenInThread: false } })
			await expect(Promise.all([firstWrite, secondWrite])).resolves.toEqual([
				{ hasUnseenInThread: true },
				{ hasUnseenInThread: false },
			])
		})

		it('sends one durable operation for a selected batch', async () => {
			generateUrl.mockReturnValue('/flags-batch')
			axios.put.mockResolvedValue({
				data: {
					messages: {
						1: { hasUnseenInThread: false },
						2: { hasUnseenInThread: true },
					},
				},
			})

			await MessageService.setEnvelopeFlagsBatch([1, 2], { seen: true })

			expect(axios.put).toHaveBeenCalledTimes(1)
			expect(axios.put).toHaveBeenCalledWith('/flags-batch', {
				ids: [1, 2],
				flags: { seen: true },
				operationId: expect.any(String),
			}, {
				mailWorkClass: 'quick-mutation',
			})
		})
	})
})
