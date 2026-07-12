/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { parseErrorResponse } from '../../../http/ErrorResponseParser.js'

describe('parseErrorResponse', () => {
	// resp is undefined for any axios error that never received an HTTP
	// response at all -- a network failure, or the browser itself killing
	// an in-flight request when the tab is backgrounded on mobile
	// (confirmed live, Android: backgrounding mid-message-load then
	// returning surfaced "can't access property 'headers', e is
	// undefined" instead of a real error). Every MessageService.js caller
	// now guards this before calling in, but the parser itself should
	// never crash on it either.
	it('does not crash when given no response at all', () => {
		expect(() => parseErrorResponse(undefined)).not.toThrow()
	})

	it('passes an undefined response straight through', () => {
		expect(parseErrorResponse(undefined)).toBeUndefined()
	})

	it('passes through a plain (non-structured) response unchanged', () => {
		const resp = { headers: {}, data: {} }

		expect(parseErrorResponse(resp)).toBe(resp)
	})

	it('parses a structured mail error response', () => {
		const resp = {
			headers: { 'x-mail-response': 'true' },
			data: {
				status: 'error',
				data: {
					type: 'SomeException',
					code: 42,
					message: 'Something went wrong',
					trace: 'stack trace',
					debug: true,
				},
			},
		}

		expect(parseErrorResponse(resp)).toEqual({
			isError: true,
			debug: true,
			type: 'SomeException',
			code: 42,
			message: 'Something went wrong',
			trace: 'stack trace',
		})
	})
})
