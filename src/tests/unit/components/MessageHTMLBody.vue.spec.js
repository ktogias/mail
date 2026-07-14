/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import MessageHTMLBody from '../../../components/MessageHTMLBody.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

class MockResizeObserver {
	constructor(callback) {
		this.callback = callback
		this.observedElements = []
		MockResizeObserver.instances.push(this)
	}

	observe(el) {
		this.observedElements.push(el)
	}

	disconnect() {
		this.observedElements = []
		this.disconnected = true
	}
}

describe('MessageHTMLBody', () => {
	let message

	beforeEach(() => {
		message = {
			databaseId: 112929,
			from: [{ email: 'breakingnews@nytimes.com' }],
			isSenderTrusted: false,
		}
		MockResizeObserver.instances = []
		vi.stubGlobal('ResizeObserver', MockResizeObserver)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function mountMessageHTMLBody() {
		return shallowMount(MessageHTMLBody, {
			propsData: {
				url: 'https://example.test/apps/mail/api/messages/112929/html',
				message,
			},
			localVue,
		})
	}

	function stubIframeDoc(view, extra = {}) {
		const { body: bodyOverrides, ...rest } = extra
		Object.defineProperty(view.vm.$refs.iframe, 'contentDocument', {
			value: {
				documentElement: { style: { setProperty: vi.fn() } },
				body: { style: { setProperty: vi.fn() }, ...bodyOverrides },
				querySelectorAll: vi.fn().mockReturnValue([]),
				...rest,
			},
			configurable: true,
		})
	}

	// Message HTML is same-origin (served from this app's own API, not a
	// genuinely cross-origin iframe), so MessageHTMLBody measures it
	// directly with a ResizeObserver on the iframe's own body instead of
	// iframe-resizer's postMessage-based child/parent handshake -- which
	// needed three separate manual nudges (the initial handshake race,
	// images unblocked by "Show images", and non-blocked images still
	// loading through the image proxy) to cover cases where content grew
	// after the moment it last measured. A ResizeObserver reports every
	// one of those automatically, with no manual nudging needed.

	it('observes the iframe body and applies its scrollHeight, not contentRect', () => {
		// scrollHeight, not entries[0].contentRect.height: the injected
		// html-response.css sets `html { overflow-y: hidden }` (to avoid
		// a double scrollbar alongside #message-container's own), and
		// contentRect reports the body's own laid-out box, which can
		// under-report once any ancestor in the chain clips overflow.
		// Confirmed live: content was still cut off using contentRect
		// even with only the blocked-image placeholder showing (no real
		// image loading involved, ruling out a timing race).
		const view = mountMessageHTMLBody()
		stubIframeDoc(view, { body: { scrollHeight: 842 } })

		view.vm.onMessageFrameLoad()

		const [observer] = MockResizeObserver.instances
		expect(observer.observedElements).toEqual([view.vm.$refs.iframe.contentDocument.body])

		observer.callback()

		expect(view.vm.$refs.iframe.style.height).toBe('842px')

		// A later callback (any layout change) re-reads scrollHeight
		// fresh rather than relying on stale entry data.
		view.vm.$refs.iframe.contentDocument.body.scrollHeight = 1200
		observer.callback()
		expect(view.vm.$refs.iframe.style.height).toBe('1200px')
	})

	it('disconnects the previous observer before creating a new one on a subsequent load', () => {
		const view = mountMessageHTMLBody()
		stubIframeDoc(view)

		view.vm.onMessageFrameLoad()
		const [firstObserver] = MockResizeObserver.instances

		view.vm.onMessageFrameLoad()

		expect(firstObserver.disconnected).toBe(true)
		expect(MockResizeObserver.instances).toHaveLength(2)
	})

	it('disconnects the observer on unmount', () => {
		const view = mountMessageHTMLBody()
		stubIframeDoc(view)
		view.vm.onMessageFrameLoad()
		const [observer] = MockResizeObserver.instances

		view.destroy()

		expect(observer.disconnected).toBe(true)
	})

	it('neutralizes the message document\'s own height:100% reset before measuring it', () => {
		// Some newsletter templates (e.g. Odoo's `o_layout` output, used
		// by a real EUseful newsletter) ship their own `html, body {
		// height: 100% !important; }` reset. Left alone, that ties the
		// message's own height to the iframe element the ResizeObserver
		// is about to resize to fit it, so every resize makes "100%"
		// mean something bigger, which grows the next scrollHeight
		// measurement, forever -- confirmed live as an iframe that never
		// stopped growing. Forcing both root elements to an inline
		// `!important` height:auto here -- which outranks a stylesheet
		// rule of equal importance regardless of DOM order -- breaks the
		// cycle before the observer takes its first measurement.
		const view = mountMessageHTMLBody()
		stubIframeDoc(view)

		view.vm.onMessageFrameLoad()

		const { documentElement, body } = view.vm.$refs.iframe.contentDocument
		expect(documentElement.style.setProperty).toHaveBeenCalledWith('height', 'auto', 'important')
		expect(body.style.setProperty).toHaveBeenCalledWith('height', 'auto', 'important')
	})

	it('detects blocked content and displayIframe() unblocks it without crashing', () => {
		const view = mountMessageHTMLBody()
		const img = document.createElement('img')
		img.setAttribute('data-original-src', 'https://example.test/banner.png')
		stubIframeDoc(view, {
			querySelectorAll: vi.fn((selector) => (selector === '[data-original-src]' ? [img] : [])),
		})

		view.vm.onMessageFrameLoad()
		expect(view.vm.hasBlockedContent).toBe(true)

		view.vm.displayIframe()

		expect(img.getAttribute('src')).toBe('https://example.test/banner.png')
		expect(view.vm.hasBlockedContent).toBe(false)
	})
})
