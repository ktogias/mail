/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import MessageHTMLBody from '../../../components/MessageHTMLBody.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'

vi.mock('@iframe-resizer/parent', () => ({
	default: vi.fn(),
}))

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

describe('MessageHTMLBody', () => {
	let message

	beforeEach(() => {
		message = {
			databaseId: 112929,
			from: [{ email: 'breakingnews@nytimes.com' }],
			isSenderTrusted: false,
		}
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

	it('nudges a fresh resize on the iframe\'s own load event, on top of the automatic handshake', () => {
		// Regression: iframe-resizer's child->parent "ready" handshake
		// races against Vue mounting -- the <iframe>'s src is already set
		// by the time mounted() calls iframeResize() (template rendering
		// happens first), so a small/already-cached message can finish
		// loading before the parent side has attached its listener.
		// Confirmed live: "no response from iframe" in the console on
		// messages ranging from a small, simple notification email to a
		// large, dense one -- not tied to content size, consistent with a
		// timing race rather than the child script failing to run. The
		// native `load` event is reliable regardless of that race.
		const view = mountMessageHTMLBody()
		const resize = vi.fn()
		view.vm.$refs.iframe.iFrameResizer = { resize }
		Object.defineProperty(view.vm.$refs.iframe, 'contentDocument', {
			value: { querySelectorAll: vi.fn().mockReturnValue([]) },
			configurable: true,
		})

		view.vm.onMessageFrameLoad()

		expect(resize).toHaveBeenCalledTimes(1)
	})

	it('does not throw when the automatic handshake never attached iFrameResizer at all', () => {
		// The nudge must not itself become a new failure mode if
		// iframeResize() never got to run (e.g. an even earlier error).
		const view = mountMessageHTMLBody()
		view.vm.$refs.iframe.iFrameResizer = undefined
		Object.defineProperty(view.vm.$refs.iframe, 'contentDocument', {
			value: { querySelectorAll: vi.fn().mockReturnValue([]) },
			configurable: true,
		})

		expect(() => view.vm.onMessageFrameLoad()).not.toThrow()
	})
})
