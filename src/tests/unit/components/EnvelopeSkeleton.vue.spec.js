/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import EnvelopeSkeleton from '../../../components/EnvelopeSkeleton.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

describe('EnvelopeSkeleton: the unread indicator must not depend on hover/focus state', () => {
	// Reported live on mobile: selecting a message made its OWN unread dot
	// vanish, reappearing only once a different message was selected. Root
	// cause -- the indicator used to share its visibility with the
	// hover-revealed actions area (showAdditionalElements, driven by
	// @mouseover/@focus), and mobile browsers synthesize both of those on
	// every tap. The indicator is informational (does this message have
	// unread mail), unrelated to whether hover actions are showing, and the
	// two floating action areas are absolutely-positioned overlays that
	// don't actually compete for this layout space.
	function mountWithIndicator() {
		return shallowMount(EnvelopeSkeleton, {
			propsData: {
				name: 'Test envelope',
				href: '#',
			},
			slots: {
				indicator: '<span class="fake-indicator">unread dot</span>',
				// showActions() (triggered by @mouseover, see
				// handleMouseover()) is itself gated on hasActions -- an
				// actions slot must be present for the mouseover to have
				// any effect at all, matching the real component always
				// having actions.
				actions: '<button class="fake-action">delete</button>',
			},
			localVue,
		})
	}

	it('shows the indicator when nothing is hovered or focused', async () => {
		const view = mountWithIndicator()
		// hasIndicator is only set inside mounted()'s checkSlots(), which
		// schedules a re-render -- wait for it before inspecting the DOM.
		await view.vm.$nextTick()

		const indicator = view.find('.list-item-content__inner__details__extra__indicator')
		expect(indicator.exists()).toBe(true)
		expect(indicator.classes()).not.toContain('extra--hidden')
	})

	it('does not instantiate the hidden actions subtree before hover or focus', async () => {
		const view = mountWithIndicator()
		await view.vm.$nextTick()

		expect(view.find('.list-item__hoverable').exists()).toBe(false)
		expect(view.find('.fake-action').exists()).toBe(false)
	})

	it('still shows the indicator once the hover-actions state is triggered (the mobile tap case)', async () => {
		const view = mountWithIndicator()
		await view.vm.$nextTick()

		// Mirrors what a mobile tap synthesizes: a mouseover on the row,
		// which is exactly what used to hide the indicator.
		await view.find('.list-item').trigger('mouseover')

		expect(view.vm.displayActionsOnHoverFocus).toBe(true)
		expect(view.find('.list-item__hoverable').exists()).toBe(true)
		expect(view.find('.fake-action').exists()).toBe(true)
		const indicator = view.find('.list-item-content__inner__details__extra__indicator')
		expect(indicator.exists()).toBe(true)
		expect(indicator.classes()).not.toContain('extra--hidden')
	})

	it('keeps lazy actions mounted on mouseleave while their menu is open', async () => {
		const view = mountWithIndicator()
		await view.vm.$nextTick()
		await view.find('.list-item').trigger('mouseover')
		view.vm.handleActionsUpdateOpen(true)

		await view.find('.list-item').trigger('mouseleave')
		expect(view.find('.list-item__hoverable').exists()).toBe(true)

		view.vm.handleActionsUpdateOpen(false)
		await view.vm.$nextTick()
		expect(view.find('.list-item__hoverable').exists()).toBe(false)
	})
})
