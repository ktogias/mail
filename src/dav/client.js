/**
 * SPDX-FileCopyrightText: 2021 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getCurrentUser } from '@nextcloud/auth'
import axios from '@nextcloud/axios'
import { generateRemoteUrl } from '@nextcloud/router'
import memoize from 'lodash/fp/memoize.js'
import * as webdav from 'webdav'

/**
 * Run a webdav request through Nextcloud's axios and hand back something
 * webdav can actually read.
 *
 * The client is routed through @nextcloud/axios on purpose -- that is what
 * carries the session, the CSRF token and OC.registerXHRForErrorProcessing.
 * What changed is the shape webdav expects back: up to webdav 4 the patched
 * `request` was an axios-compatible call, so handing it axios directly was
 * enough. webdav 5 is built on fetch and reads `.ok` and `await
 * response.text()` off whatever the patched request resolves with, and an
 * axios response has neither -- it carries `.data`.
 *
 * So patching `request` with axios itself turned every single DAV call into
 * "TypeError: response.text is not a function" thrown AFTER a perfectly
 * good response had already arrived. Reported live on 2026-07-28 as "Could
 * not load your calendars" with the PROPFIND sitting right there in the
 * network panel at 207 / 24.98 kB. getUserCalendars() was only the visible
 * half; FileService's getFileSize()/getFileData() go through the same
 * client and failed the same way.
 *
 * The body is read as an ArrayBuffer and decoded on demand so text() and
 * arrayBuffer() are both honest -- decoding to a string up front would
 * corrupt any binary payload.
 *
 * @param {object} requestOptions webdav's own options: url, method, headers, data, signal
 * @return {Promise<object>} a fetch-like response
 */
async function requestThroughAxios(requestOptions) {
	const response = await axios({
		url: requestOptions.url,
		method: requestOptions.method,
		headers: requestOptions.headers,
		data: requestOptions.data,
		signal: requestOptions.signal,
		responseType: 'arraybuffer',
		// webdav is the one that decides what a status means (see
		// handleResponseCode(), which turns >= 400 into a typed error and
		// deliberately lets 401 through for digest auth). Rejecting here
		// would pre-empt that and lose the response body with it.
		validateStatus: () => true,
	})

	const headers = new Headers(typeof response.headers?.toJSON === 'function' ? response.headers.toJSON() : (response.headers ?? {}))
	const body = response.data

	return {
		ok: response.status >= 200 && response.status < 300,
		status: response.status,
		statusText: response.statusText,
		headers,
		text: async () => new TextDecoder().decode(body),
		json: async () => JSON.parse(new TextDecoder().decode(body)),
		arrayBuffer: async () => body,
		blob: async () => new Blob([body]),
	}
}

export const getClient = memoize((service) => {
	// Add this so the server knows it is an request from the browser
	axios.defaults.headers['X-Requested-With'] = 'XMLHttpRequest'

	// force our axios
	const patcher = webdav.getPatcher()
	patcher.patch('request', requestThroughAxios)

	return webdav.createClient(generateRemoteUrl(`dav/${service}/${getCurrentUser().uid}`))
})
