/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { hydrateInlineAttachments } from '../../html-response.js'

describe('message HTML inline attachment hydration', () => {
	afterEach(() => {
		document.body.replaceChildren()
	})

	it('hydrates every image in a message through one bounded bundle request', async () => {
		document.body.innerHTML = `
			<img data-mail-inline-id="2.2"
				data-mail-inline-bundle="/apps/mail/api/messages/123/attachments/inline"
				data-mail-inline-fallback="/apps/mail/api/messages/123/attachment/2.2">
			<img data-mail-inline-id="2.3"
				data-mail-inline-bundle="/apps/mail/api/messages/123/attachments/inline"
				data-mail-inline-fallback="/apps/mail/api/messages/123/attachment/2.3">
		`
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({
				parts: {
					2.2: { mime: 'image/png', content: 'Zmlyc3Q=' },
					2.3: { mime: 'image/jpeg', content: 'c2Vjb25k' },
				},
			}),
		})

		await hydrateInlineAttachments(document, fetchImpl)

		expect(fetchImpl).toHaveBeenCalledTimes(1)
		expect(fetchImpl).toHaveBeenCalledWith(
			new URL('/apps/mail/api/messages/123/attachments/inline', window.location.href).href,
			expect.objectContaining({
				credentials: 'same-origin',
				headers: {
					'X-Mail-Request-Class': 'active-content',
					Priority: 'u=1',
				},
			}),
		)
		const images = document.querySelectorAll('img')
		expect(images[0].src).toBe('data:image/png;base64,Zmlyc3Q=')
		expect(images[1].src).toBe('data:image/jpeg;base64,c2Vjb25k')
	})

	it('uses the established single-part fallback only for a missing bundle part', async () => {
		document.body.innerHTML = `
			<img data-mail-inline-id="2.2"
				data-mail-inline-bundle="/apps/mail/api/messages/123/attachments/inline"
				data-mail-inline-fallback="/apps/mail/api/messages/123/attachment/2.2">
			<img data-mail-inline-id="2.3"
				data-mail-inline-bundle="/apps/mail/api/messages/123/attachments/inline"
				data-mail-inline-fallback="/apps/mail/api/messages/123/attachment/2.3">
		`
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({
				parts: {
					2.2: { mime: 'image/png', content: 'Zmlyc3Q=' },
				},
			}),
		})

		await hydrateInlineAttachments(document, fetchImpl)

		const images = document.querySelectorAll('img')
		expect(images[0].src).toBe('data:image/png;base64,Zmlyc3Q=')
		expect(images[1].src).toBe(new URL('/apps/mail/api/messages/123/attachment/2.3', window.location.href).href)
	})

	it('does not fetch sender-controlled external or unrelated same-origin URLs', async () => {
		document.body.innerHTML = `
			<img data-mail-inline-id="2.2"
				data-mail-inline-bundle="https://attacker.example/collect"
				data-mail-inline-fallback="/apps/mail/api/messages/123/attachment/2.2">
			<img data-mail-inline-id="2.3"
				data-mail-inline-bundle="/apps/files/api/v1/share"
				data-mail-inline-fallback="/apps/mail/api/messages/123/attachment/2.3">
		`
		const fetchImpl = vi.fn()

		await hydrateInlineAttachments(document, fetchImpl)

		expect(fetchImpl).not.toHaveBeenCalled()
		expect(document.querySelectorAll('img[src]')).toHaveLength(0)
	})

	it('restores all individual URLs when the bundle request fails', async () => {
		document.body.innerHTML = `
			<img data-mail-inline-id="2.2"
				data-mail-inline-bundle="/apps/mail/api/messages/123/attachments/inline"
				data-mail-inline-fallback="/apps/mail/api/messages/123/attachment/2.2">
			<img data-mail-inline-id="2.3"
				data-mail-inline-bundle="/apps/mail/api/messages/123/attachments/inline"
				data-mail-inline-fallback="/apps/mail/api/messages/123/attachment/2.3">
		`
		const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))

		await hydrateInlineAttachments(document, fetchImpl)

		for (const image of document.querySelectorAll('img')) {
			expect(image.src).toBe(new URL(image.dataset.mailInlineFallback, window.location.href).href)
		}
	})
})
