/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { shallowMount } from '@vue/test-utils'
import MessageAttachment from '../../../components/MessageAttachment.vue'

describe('MessageAttachment', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('retries a failed image preview with bounded cache-busted requests', async () => {
		vi.useFakeTimers()
		const view = shallowMount(MessageAttachment, {
			mocks: {
				t: (app, text) => text,
			},
			propsData: {
				id: '2',
				fileName: 'first.jpg',
				size: 1024,
				url: 'https://cloud.example.test/attachment/2',
				isImage: true,
				mime: 'image/jpeg',
				mimeUrl: 'https://cloud.example.test/icon.svg',
			},
		})

		view.vm.retryPreview()
		// Part 2 gets a deterministic 274ms stagger on top of the 750ms
		// first retry, so sibling image previews do not stampede together.
		vi.advanceTimersByTime(1024)
		await view.vm.$nextTick()

		expect(view.vm.previewUrl).toBe('https://cloud.example.test/attachment/2?mailPreviewRetry=1')

		view.vm.retryPreview()
		vi.advanceTimersByTime(1774)
		await view.vm.$nextTick()
		expect(view.vm.previewUrl).toContain('mailPreviewRetry=2')

		view.vm.retryPreview()
		vi.advanceTimersByTime(3274)
		await view.vm.$nextTick()
		expect(view.vm.previewUrl).toContain('mailPreviewRetry=3')

		view.vm.retryPreview()
		expect(vi.getTimerCount()).toBe(0)

		view.destroy()
	})

	it('cancels a pending retry when the attachment is destroyed', () => {
		vi.useFakeTimers()
		const view = shallowMount(MessageAttachment, {
			mocks: {
				t: (app, text) => text,
			},
			propsData: {
				id: '4',
				fileName: 'second.jpg',
				size: 1024,
				url: 'https://cloud.example.test/attachment/4',
				isImage: true,
				mime: 'image/jpeg',
				mimeUrl: 'https://cloud.example.test/icon.svg',
			},
		})

		view.vm.retryPreview()
		expect(vi.getTimerCount()).toBe(1)

		view.destroy()
		expect(vi.getTimerCount()).toBe(0)
	})
})
