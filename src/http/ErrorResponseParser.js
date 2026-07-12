/**
 * SPDX-FileCopyrightText: 2018 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

function isErrorResponse(resp) {
	// resp is undefined for any axios error that never received an HTTP
	// response at all -- a genuine network failure (lost connection, DNS
	// failure, or the browser itself killing an in-flight request when
	// the tab is backgrounded on mobile: confirmed live, Android,
	// backgrounding mid-message-load then returning). Guard here rather
	// than assume every caller remembers to check first.
	return !!resp && 'x-mail-response' in resp.headers && resp.data.status === 'error'
}

export function parseErrorResponse(resp) {
	if (!isErrorResponse(resp)) {
		return resp
	}

	const { debug, type, code, message, trace } = resp.data.data || {}

	return {
		isError: true,
		debug: !!debug,
		type,
		code,
		message,
		trace,
	}
}
