/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// injected styles
import '../css/html-response.css'
// No longer imports '@iframe-resizer/child': the parent side
// (MessageHTMLBody.vue) now measures this same-origin iframe directly
// with a ResizeObserver instead of iframe-resizer's postMessage-based
// handshake, so this script no longer has anything to respond to.

// Fix width of some newsletter mails
document.addEventListener('DOMContentLoaded', function() {
	for (const el of document.querySelectorAll('*')) {
		if (!el.style['max-width']) {
			el.style['max-width'] = '100%'
		}
	}
})
