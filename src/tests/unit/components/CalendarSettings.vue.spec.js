/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createTestingPinia } from '@pinia/testing'
import { createLocalVue, shallowMount } from '@vue/test-utils'
import { PiniaVuePlugin, setActivePinia } from 'pinia'
import CalendarSettings from '../../../components/CalendarSettings.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'

// See Imip.vue.spec.js: the getClonedWriteableCalendars getter clones through
// the DAV collection factory -- mock it to pass our stable calendar through.
vi.mock('../../../service/caldavService.js', () => ({
	getCalendarHome: () => ({
		_collectionFactoryMapper: {
			calendar: class {
				constructor(home, request, url, props) {
					return props.__stable
				}
			},
		},
	}),
	initializeClientForUserView: vi.fn(),
	getCurrentUserPrincipal: vi.fn(),
	findAll: vi.fn(),
}))

function descriptor(url, displayname) {
	return {
		isWriteable: () => true,
		resourcetype: ['{DAV:}collection', 'calendar'],
		_request: {},
		_url: url,
		_props: { __stable: { url, displayname } },
	}
}

const localVue = createLocalVue()
localVue.use(PiniaVuePlugin)
localVue.mixin(Nextcloud)

describe('CalendarSettings', () => {
	let store

	beforeEach(() => {
		setActivePinia(createTestingPinia())
		store = useMainStore()
		store.$patch({
			calendars: [
				descriptor('https://cal/work/', 'Work'),
				descriptor('https://cal/home/', 'Home'),
			],
		})
	})

	function mountSettings(account = {}) {
		return shallowMount(CalendarSettings, {
			localVue,
			propsData: {
				account: {
					id: 4,
					imipCreate: false,
					imipAllowUnmatched: false,
					defaultCalendarUrl: null,
					...account,
				},
			},
		})
	}

	it('offers the writeable calendars plus a leading "use app default" entry', () => {
		const view = mountSettings()

		const urls = view.vm.calendarOptions.map((option) => option.url)
		expect(urls[0]).toBe('') // "use app default"
		expect(urls).toContain('https://cal/work/')
		expect(urls).toContain('https://cal/home/')
	})

	it('reflects the account default in the picker', () => {
		const view = mountSettings({ defaultCalendarUrl: 'https://cal/home/' })

		expect(view.vm.selectedCalendar.url).toBe('https://cal/home/')
	})

	it('shows "use app default" when the account has no default', () => {
		const view = mountSettings()

		expect(view.vm.selectedCalendar.url).toBe('')
	})

	it('patches the account when a calendar is selected', async () => {
		const view = mountSettings()

		view.vm.selectedCalendar = { url: 'https://cal/work/', displayname: 'Work' }
		await view.vm.$nextTick()

		expect(store.patchAccount).toHaveBeenCalledWith({
			account: view.vm.account,
			data: { defaultCalendarUrl: 'https://cal/work/' },
		})
	})

	it('clears the default (empty string) when "use app default" is selected', async () => {
		const view = mountSettings({ defaultCalendarUrl: 'https://cal/work/' })

		view.vm.selectedCalendar = { url: '', displayname: 'Use app default' }
		await view.vm.$nextTick()

		expect(store.patchAccount).toHaveBeenCalledWith({
			account: view.vm.account,
			data: { defaultCalendarUrl: '' },
		})
	})

	it('patches imipAllowUnmatched when the switch is toggled', async () => {
		const view = mountSettings()

		await view.vm.onToggleImipAllowUnmatched(true)

		expect(store.patchAccount).toHaveBeenCalledWith({
			account: view.vm.account,
			data: { imipAllowUnmatched: true },
		})
		expect(view.vm.imipAllowUnmatched).toBe(true)
	})

	it('rolls the local mirror back when a patch fails', async () => {
		store.patchAccount = vi.fn().mockRejectedValue(new Error('nope'))
		const view = mountSettings()

		await expect(view.vm.onToggleImipCreate(true)).rejects.toThrow()

		expect(view.vm.imipCreate).toBe(false)
	})
})
