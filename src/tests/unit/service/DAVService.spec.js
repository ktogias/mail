/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getCurrentUser } from '@nextcloud/auth'
import axios from '@nextcloud/axios'
import { generateRemoteUrl } from '@nextcloud/router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getUserCalendars } from '../../../service/DAVService.js'

vi.mock('@nextcloud/auth')
vi.mock('@nextcloud/router')
// Not the automock: the client reads axios.defaults.headers, and every call
// goes through the default export itself.
vi.mock('@nextcloud/axios', () => ({
	default: Object.assign(vi.fn(), { defaults: { headers: {} } }),
}))

/**
 * One <d:response>, the way Nextcloud answers: properties that exist come
 * back in a 200 propstat, everything else the request asked for comes back
 * in a second propstat as 404.
 *
 * @param {string} href the collection href
 * @param {string} found the 200 propstat's inner XML
 * @param {string} notFound the 404 propstat's inner XML
 * @return {string} one response element
 */
function davResponse(href, found, notFound) {
	return `<d:response><d:href>${href}</d:href>`
		+ `<d:propstat><d:prop>${found}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`
		+ (notFound ? `<d:propstat><d:prop>${notFound}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>` : '')
		+ '</d:response>'
}

// sabre/dav emits one ace per privilege, and Nextcloud grants {DAV:}write on
// a calendar the user owns -- which is what DAVService's canWrite() looks for.
const ownerAcl = `<d:acl>
	<d:ace><d:principal><d:href>/remote.php/dav/principals/users/ktogias/</d:href></d:principal><d:grant><d:privilege><d:read /></d:privilege></d:grant><d:protected /></d:ace>
	<d:ace><d:principal><d:href>/remote.php/dav/principals/users/ktogias/</d:href></d:principal><d:grant><d:privilege><d:write /></d:privilege></d:grant><d:protected /></d:ace>
</d:acl>`
const readOnlyAcl = `<d:acl>
	<d:ace><d:principal><d:href>/remote.php/dav/principals/users/ktogias/</d:href></d:principal><d:grant><d:privilege><d:read /></d:privilege></d:grant><d:protected /></d:ace>
</d:acl>`

function calendarResponse(uri, name, acl = ownerAcl) {
	return davResponse(
		`/cloud/remote.php/dav/calendars/ktogias/${uri}/`,
		'<d:resourcetype><d:collection /><c:calendar /></d:resourcetype>'
		+ `<d:displayname>${name}</d:displayname>`
		+ '<aapl:calendar-color>#0082c9</aapl:calendar-color>'
		+ acl,
		'<c:calendar-timezone /><aapl:calendar-order />',
	)
}

// The calendar home rides along in the Depth:1 multistatus and owns none of
// the calendar properties, so it always carries a 404 propstat.
const calendarHome = davResponse(
	'/cloud/remote.php/dav/calendars/ktogias/',
	'<d:resourcetype><d:collection /></d:resourcetype>',
	'<d:displayname /><aapl:calendar-color /><c:calendar-timezone /><d:acl /><aapl:calendar-order />',
)

function multistatus(...responses) {
	return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:aapl="http://apple.com/ns/ical/">
${responses.join('\n')}
</d:multistatus>`
}

describe('getUserCalendars: the DAV client must hand webdav a fetch-like response', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		getCurrentUser.mockReturnValue({ uid: 'ktogias' })
		generateRemoteUrl.mockImplementation((path) => `https://home.ktogias.gr/cloud/remote.php/${path}`)
	})

	/**
	 * Answer like @nextcloud/axios does: a body on `.data`, no `.ok`, and --
	 * the part that matters -- no `.text()`.
	 *
	 * @param {string} xml the response body
	 * @param {number} status the HTTP status
	 */
	function respondWith(xml, status = 207) {
		axios.mockResolvedValue({
			status,
			statusText: status === 207 ? 'Multi-Status' : 'Error',
			headers: { 'content-type': 'application/xml; charset=utf-8' },
			data: new TextEncoder().encode(xml),
		})
	}

	// Reported live on 2026-07-28: "Could not load your calendars" while the
	// PROPFIND sat in the network panel at 207 / 24.98 kB. src/dav/client.js
	// patched webdav's `request` with axios itself, which was right for
	// webdav 4 but not for 5 -- that one reads `.ok` and `await
	// response.text()`, so a perfectly good 207 became
	// "TypeError: response.text is not a function".
	it('reads the calendars out of a successful multistatus', async () => {
		respondWith(multistatus(
			calendarHome,
			calendarResponse('1-8', 'Γενικό'),
			calendarResponse('isi-comb', 'ISI'),
		))

		const calendars = await getUserCalendars()

		expect(calendars.map((calendar) => calendar.displayname)).toEqual(['Γενικό', 'ISI'])
		expect(calendars[0].url).toBe('https://home.ktogias.gr/cloud/remote.php/dav/calendars/ktogias/1-8/')
	})

	it('issues a PROPFIND rather than rejecting on the 207 itself', async () => {
		respondWith(multistatus(calendarHome, calendarResponse('1-8', 'Γενικό')))

		await getUserCalendars()

		const [request] = axios.mock.calls[0]
		expect(request.method).toBe('PROPFIND')
		// webdav decides what a status means; axios must not reject first or
		// handleResponseCode() never runs and the body is lost with it.
		expect(request.validateStatus(207)).toBe(true)
		expect(request.validateStatus(404)).toBe(true)
	})

	it('drops the calendar home and anything the user cannot write to', async () => {
		respondWith(multistatus(
			calendarHome,
			calendarResponse('1-8', 'Γενικό'),
			calendarResponse('shared', 'Shared with me', readOnlyAcl),
		))

		const calendars = await getUserCalendars()

		expect(calendars.map((calendar) => calendar.displayname)).toEqual(['Γενικό'])
	})

	it('still turns a real error status into a rejection', async () => {
		respondWith('<d:error xmlns:d="DAV:"><s:message>Maintenance</s:message></d:error>', 503)

		await expect(getUserCalendars()).rejects.toThrow()
	})
})
