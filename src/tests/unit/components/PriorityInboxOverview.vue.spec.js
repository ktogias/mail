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

	// The unread filter belongs in the search filter row with its siblings
	// (Has attachment, To me). It used to ALSO be a checkbox here -- one
	// filter, two widget languages, two places -- and this component's
	// control only ever delegated to the chip's own setUnread().
	it('carries no filter control of its own', () => {
		const wrapper = shallowMount(PriorityInboxOverview, { localVue, propsData: { stats } })

		expect(wrapper.findComponent({ name: 'NcCheckboxRadioSwitch' }).exists()).toBe(false)
	})

	// A section with nothing unread said "0 / 0" once the totals were dropped:
	// two zeroes, no information, and the second one an artefact.
	it('shows a count only where there is something to act on, and never a total', () => {
		const wrapper = shallowMount(PriorityInboxOverview, {
			localVue,
			propsData: {
				stats: {
					sections: {
						favorite: { unread: 2 },
						important: { unread: 0 },
						other: { unread: 4 },
					},
					complete: true,
				},
			},
		})

		expect(wrapper.text()).not.toContain('/')
		expect(wrapper.text()).not.toContain('0')
		expect(wrapper.findAllComponents({ name: 'NcCounterBubble' })).toHaveLength(2)
	})

	// "Has new mail" and "is unread" are different facts. Showing both as
	// numbers on one chip made it a puzzle -- reported live: 2 / 10 / 4 over
	// badges reading +10 / +4 over a footer reading "14 new messages".
	it('marks a section that received new mail with a dot, not a second number', () => {
		const wrapper = shallowMount(PriorityInboxOverview, {
			localVue,
			propsData: {
				stats,
				newCounts: { favorite: 0, important: 10, other: 4 },
			},
		})

		expect(wrapper.findAll('.priority-overview__new-dot')).toHaveLength(2)
		expect(wrapper.text()).not.toContain('+10')
		// The number itself stays reachable, and stays in the one place that
		// carries an action.
		expect(wrapper.find('.priority-overview__new-message').text()).toContain('14')
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
