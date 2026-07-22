/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createTestingPinia } from '@pinia/testing'
import { createLocalVue, shallowMount } from '@vue/test-utils'
import { PiniaVuePlugin, setActivePinia } from 'pinia'
import EventModal from '../../../components/EventModal.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import { getUserCalendars } from '../../../service/DAVService.js'

vi.mock('../../../service/DAVService.js', () => ({
	getUserCalendars: vi.fn().mockResolvedValue([]),
	importCalendarEvent: vi.fn(),
}))

vi.mock('../../../service/AiIntergrationsService.js', () => ({
	generateEventData: vi.fn().mockResolvedValue(undefined),
}))

const localVue = createLocalVue()
localVue.use(PiniaVuePlugin)
localVue.mixin(Nextcloud)

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('EventModal', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia())
	})

	it('renders default values', () => {
		const view = shallowMount(EventModal, {
			localVue,
			propsData: {
				envelope: {
					subject: 'Sub?',
					previewText: 'prev',
				},
			},
		})

		expect(view.vm.llmProcessingEnabled).toBe(false)
		expect(view.vm.eventTitle).toBe('Sub?')
		expect(view.vm.description).toBe('prev')
	})

	it('defaults the calendar to the receiving account\'s configured default', async () => {
		getUserCalendars.mockResolvedValueOnce([
			{ url: 'https://cal/a/', writable: true, displayname: 'A' },
			{ url: 'https://cal/b/', writable: true, displayname: 'B' },
		])
		setActivePinia(createTestingPinia({
			stubActions: false,
			initialState: {
				main: {
					accountsUnmapped: {
						4: { id: 4, defaultCalendarUrl: 'https://cal/b/' },
					},
				},
			},
		}))

		const view = shallowMount(EventModal, {
			localVue,
			propsData: {
				envelope: { subject: 's', previewText: 'p', accountId: 4 },
			},
		})
		await flush()

		expect(view.vm.selectedCalendar.url).toBe('https://cal/b/')
	})

	it('falls back to the first calendar when the account has no default', async () => {
		getUserCalendars.mockResolvedValueOnce([
			{ url: 'https://cal/a/', writable: true, displayname: 'A' },
			{ url: 'https://cal/b/', writable: true, displayname: 'B' },
		])
		setActivePinia(createTestingPinia({
			stubActions: false,
			initialState: {
				main: {
					accountsUnmapped: {
						4: { id: 4, defaultCalendarUrl: null },
					},
				},
			},
		}))

		const view = shallowMount(EventModal, {
			localVue,
			propsData: {
				envelope: { subject: 's', previewText: 'p', accountId: 4 },
			},
		})
		await flush()

		expect(view.vm.selectedCalendar.url).toBe('https://cal/a/')
	})
})
