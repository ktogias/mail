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
		favorite: { unread: 2 },
		important: { unread: 3 },
		other: { unread: 5 },
	},
	complete: true,
}

describe('PriorityInboxOverview', () => {
	it('shows the unread count per section and emits section navigation', async () => {
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
		}))

		await sections.at(1).trigger('click')
		expect(wrapper.emitted('select')).toEqual([['important']])
	})

	// A number nobody can check invites the reader to check it anyway. The
	// arrivals pill counted unseen messages that entered the list since the
	// last refresh -- a subset of unread, never its sum -- so with the
	// per-section badges gone it had no visible referent at all. Reported
	// live: "11 new messages" beside chips reading 2 and 11, and the obvious
	// reading (2 + 11 = 13) is simply not what it means.
	it('carries no aggregate arrivals count', () => {
		const wrapper = shallowMount(PriorityInboxOverview, {
			localVue,
			propsData: { stats, newCounts: { favorite: 0, important: 1, other: 4 } },
		})

		expect(wrapper.find('.priority-overview__new-message').exists()).toBe(false)
		// Where new mail landed is still shown, without a number to reconcile.
		expect(wrapper.findAll('.priority-overview__new-dot')).toHaveLength(2)
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
		// A plain number inside the chip, not a badge inside a badge: the
		// bubble's min-width and padding were what stopped three Greek labels
		// fitting on one row.
		expect(wrapper.findComponent({ name: 'NcCounterBubble' }).exists()).toBe(false)
		const counts = wrapper.findAll('.priority-overview__count').wrappers.map((w) => w.text())
		expect(counts).toEqual(['2', '', '4'])
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
		// The exact per-section arrival count is still carried, and the chip
		// exposes it through its title/aria label rather than on its face.
		// (The count itself is asserted here rather than the rendered string:
		// t()/n() are not localised in this environment.)
		expect(wrapper.vm.visibleSections[1].newCount).toBe(10)
		expect(wrapper.findAll('.priority-overview__section').at(1).attributes('title'))
			.toBeTruthy()
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
