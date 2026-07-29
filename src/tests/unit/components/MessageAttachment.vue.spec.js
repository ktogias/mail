/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { shallowMount } from '@vue/test-utils'
import MessageAttachment from '../../../components/MessageAttachment.vue'
import * as DAVService from '../../../service/DAVService.js'
import { showError } from '../../../util/toast.js'

vi.mock('../../../service/DAVService.js')
vi.mock('../../../util/toast.js', async (importOriginal) => ({
	...(await importOriginal()),
	showError: vi.fn(),
	showSuccess: vi.fn(),
}))

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

	describe('loading the calendar list', () => {
		function mountCalendarAttachment() {
			return shallowMount(MessageAttachment, {
				mocks: { t: (app, text) => text, $route: { params: {} } },
				propsData: {
					id: '1',
					fileName: 'Attached Message Part.vcs',
					size: 6144,
					url: 'https://cloud.example.test/attachment/1',
					mime: 'text/calendar',
					isCalendarEvent: true,
				},
			})
		}

		// The button carries :disabled="loadingCalendars", so a rejection that
		// never clears the flag leaves the entry spinning and unclickable for
		// the life of the open message, saying nothing at all.
		//
		// Reported live on 2026-07-28 as "the calendar import is stuck". The
		// trigger was ordinary: the click landed while the server was in
		// maintenance mode during a deploy, and the PROPFIND on
		// /dav/calendars/<uid>/ returned 503.
		it('recovers when the calendars cannot be loaded', async () => {
			DAVService.getUserCalendars.mockRejectedValue(new Error('Request failed with status code 503'))
			const view = mountCalendarAttachment()

			await view.vm.loadCalendars()

			expect(view.vm.loadingCalendars).toBe(false)
			expect(view.vm.showCalendarPopover).toBe(false)
			expect(showError).toHaveBeenCalled()
			view.destroy()
		})

		it('opens the list when it loads', async () => {
			DAVService.getUserCalendars.mockResolvedValue([{ displayname: 'Personal', url: '/c/1' }])
			const view = mountCalendarAttachment()

			await view.vm.loadCalendars()

			expect(view.vm.loadingCalendars).toBe(false)
			expect(view.vm.showCalendarPopover).toBe(true)
			expect(view.vm.calendars).toHaveLength(1)
			view.destroy()
		})
	})
})
