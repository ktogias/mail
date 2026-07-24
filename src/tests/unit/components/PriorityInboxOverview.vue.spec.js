/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import PriorityInboxOverview from '../../../components/PriorityInboxOverview.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

const stats = {
	sections: {
		favorite: { total: 7, unread: 2 },
		important: { total: 11, unread: 3 },
		other: { total: 19, unread: 5 },
	},
	complete: true,
}

describe('PriorityInboxOverview', () => {
	it('shows exact unread/total counts and emits section navigation', async () => {
		const wrapper = shallowMount(PriorityInboxOverview, {
			localVue,
			propsData: {
				stats,
				newCounts: { favorite: 0, important: 1, other: 0 },
			},
		})

		const sections = wrapper.findAll('.priority-overview__section')
		expect(sections).toHaveLength(3)
		expect(wrapper.vm.visibleSections[1]).toEqual(expect.objectContaining({
			id: 'important',
			unread: 3,
			total: 11,
		}))
		expect(wrapper.find('.priority-overview__new-message').exists()).toBe(true)

		await sections.at(1).trigger('click')
		expect(wrapper.emitted('select')).toEqual([['important']])
	})

	it('uses a separate, accessible unread-only toggle', async () => {
		const wrapper = shallowMount(PriorityInboxOverview, {
			localVue,
			propsData: {
				stats,
				unreadOnly: true,
			},
		})

		const toggle = wrapper.find('.priority-overview__unread-toggle')
		expect(toggle.attributes('aria-pressed')).toBe('true')
		await toggle.trigger('click')
		expect(wrapper.emitted('toggle-unread')).toHaveLength(1)
	})

	it('omits Favorites when the navigation preference disables that section', () => {
		const wrapper = shallowMount(PriorityInboxOverview, {
			localVue,
			propsData: {
				stats,
				showFavorites: false,
			},
		})

		expect(wrapper.findAll('.priority-overview__section')).toHaveLength(2)
		expect(wrapper.text()).not.toContain('Favorites')
	})
})
