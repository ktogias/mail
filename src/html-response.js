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

const MESSAGE_HTML_READY = 'nextcloud-mail:message-html-ready'
const INLINE_IMAGE_SELECTOR = 'img[data-mail-inline-id][data-mail-inline-bundle][data-mail-inline-fallback]'

function restoreInlineFallbacks(images) {
	for (const image of images) {
		image.setAttribute('src', image.dataset.mailInlineFallback)
	}
}

function validatedInlineImage(image) {
	try {
		const bundleUrl = new URL(image.dataset.mailInlineBundle, window.location.href)
		const fallbackUrl = new URL(image.dataset.mailInlineFallback, window.location.href)
		const bundleMatch = bundleUrl.pathname.match(/\/apps\/mail\/api\/messages\/(\d+)\/attachments\/inline$/)
		const fallbackMatch = fallbackUrl.pathname.match(/\/apps\/mail\/api\/messages\/(\d+)\/attachment\/([^/]+)$/)
		if (
			bundleUrl.origin !== window.location.origin
			|| fallbackUrl.origin !== window.location.origin
			|| bundleMatch === null
			|| fallbackMatch === null
			|| bundleMatch[1] !== fallbackMatch[1]
			|| decodeURIComponent(fallbackMatch[2]) !== image.dataset.mailInlineId
		) {
			return undefined
		}
		return {
			bundleUrl: bundleUrl.href,
			fallbackUrl: fallbackUrl.href,
		}
	} catch {
		return undefined
	}
}

/**
 * Hydrate every deferred small inline MIME image through one request per
 * message-level bundle URL. The server caps both admitted parts and decoded
 * bytes; anything absent from the response keeps the established individual
 * attachment path as a fallback.
 *
 * @param {Document} documentRef message iframe document
 * @param {typeof fetch} fetchImpl injectable for unit tests
 */
export async function hydrateInlineAttachments(documentRef = document, fetchImpl = window.fetch.bind(window)) {
	const imagesByBundle = new Map()
	for (const image of documentRef.querySelectorAll(INLINE_IMAGE_SELECTOR)) {
		const validated = validatedInlineImage(image)
		if (validated === undefined) {
			continue
		}
		image.dataset.mailInlineFallback = validated.fallbackUrl
		const images = imagesByBundle.get(validated.bundleUrl) ?? []
		images.push(image)
		imagesByBundle.set(validated.bundleUrl, images)
	}

	await Promise.all([...imagesByBundle.entries()].map(async ([bundleUrl, images]) => {
		try {
			const response = await fetchImpl(bundleUrl, {
				credentials: 'same-origin',
				headers: {
					'X-Mail-Request-Class': 'active-content',
					Priority: 'u=1',
				},
			})
			if (!response.ok) {
				throw new Error(`Inline attachment bundle failed with HTTP ${response.status}`)
			}
			const payload = await response.json()
			const parts = payload?.parts ?? {}
			for (const image of images) {
				const part = parts[image.dataset.mailInlineId]
				if (
					typeof part?.mime === 'string'
					&& part.mime.startsWith('image/')
					&& typeof part.content === 'string'
				) {
					image.setAttribute('src', `data:${part.mime};base64,${part.content}`)
				} else {
					image.setAttribute('src', image.dataset.mailInlineFallback)
				}
			}
		} catch {
			restoreInlineFallbacks(images)
		}
	}))
}

// Fix width of some newsletter mails
document.addEventListener('DOMContentLoaded', function() {
	for (const el of document.querySelectorAll('*')) {
		if (!el.style['max-width']) {
			el.style['max-width'] = '100%'
		}
	}

	// An iframe's native load event waits for every subresource. For HTML
	// newsletters that can mean dozens of embedded MIME images, each of which
	// may still be loading through the authenticated attachment endpoint long
	// after the document's text is already usable. Tell the same-origin parent
	// as soon as parsing and the width normalization above are complete so it
	// can reveal the message while images hydrate progressively.
	window.parent.postMessage({ type: MESSAGE_HTML_READY }, window.location.origin)

	// Start only after publishing document readiness: even a genuinely slow
	// provider-side bundle fetch must never put usable text back behind the
	// skeleton. The parent ResizeObserver follows every later image layout
	// change automatically.
	void hydrateInlineAttachments()
})
