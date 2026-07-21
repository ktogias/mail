/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import EnvelopeSkeleton from '../../../components/EnvelopeSkeleton.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import { isCoarsePointer } from '../../../util/pointerType.js'

vi.mock('../../../util/pointerType.js', () => ({
	isCoarsePointer: vi.fn(() => false),
}))

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

describe('EnvelopeSkeleton: navigation decoupled from $route (2026-07-20 open-latency fix)', () => {
	// The row used to be a <router-link>, which subscribes to $route and
	// re-rendered every row on every navigation. It now resolves its href
	// once (resolvedHref) and navigates programmatically in onClick(), so a
	// route change only re-renders the row whose `active` prop changes.
	const to = { name: 'message', params: { mailboxId: 'priority', threadId: 7 } }

	function mountRow(propsOverride = {}, routerOverride = {}) {
		return shallowMount(EnvelopeSkeleton, {
			propsData: { name: 'Test envelope', to, ...propsOverride },
			mocks: {
				$router: {
					resolve: vi.fn(() => ({ href: '/box/priority/thread/7' })),
					push: vi.fn(() => Promise.resolve()),
					...routerOverride,
				},
			},
			localVue,
		})
	}

	it('resolves its href once from `to`, without a router-link', () => {
		const view = mountRow()

		expect(view.vm.resolvedHref).toBe('/box/priority/thread/7')
		expect(view.vm.$router.resolve).toHaveBeenCalledWith(to)
	})

	it('falls back to the href prop when there is no route (draft row)', () => {
		const view = mountRow({ to: null, href: '#' })

		expect(view.vm.resolvedHref).toBe('#')
	})

	it('navigates in place on a plain click and prevents the browser link-follow', () => {
		const push = vi.fn(() => Promise.resolve())
		const view = mountRow({}, { push })
		const event = { preventDefault: vi.fn() }

		view.vm.onClick(event)

		expect(view.emitted('click')).toBeTruthy()
		expect(event.preventDefault).toHaveBeenCalled()
		expect(push).toHaveBeenCalledWith(to)
	})

	it('does not navigate in place on a modifier-key click (open-in-new-tab)', () => {
		const push = vi.fn(() => Promise.resolve())
		const view = mountRow({}, { push })
		const event = { ctrlKey: true, preventDefault: vi.fn() }

		view.vm.onClick(event)

		expect(view.emitted('click')).toBeTruthy()
		expect(push).not.toHaveBeenCalled()
		expect(event.preventDefault).not.toHaveBeenCalled()
	})

	it('does not navigate when the click listener already called preventDefault (mobile tap ambiguity fix -- selectMode/long-press interception in Envelope.vue)', () => {
		const push = vi.fn(() => Promise.resolve())
		const view = mountRow({}, { push })
		const event = { defaultPrevented: true, preventDefault: vi.fn() }

		view.vm.onClick(event)

		expect(view.emitted('click')).toBeTruthy()
		expect(push).not.toHaveBeenCalled()
	})

	it('leaves a draft row (no `to`) for the parent, emitting click but not navigating', () => {
		const push = vi.fn(() => Promise.resolve())
		const view = mountRow({ to: null }, { push })
		const event = { preventDefault: vi.fn() }

		view.vm.onClick(event)

		expect(view.emitted('click')).toBeTruthy()
		expect(push).not.toHaveBeenCalled()
		expect(event.preventDefault).not.toHaveBeenCalled()
	})

	it('swallows the NavigationDuplicated rejection from re-clicking the open row', () => {
		const push = vi.fn(() => Promise.reject(new Error('NavigationDuplicated')))
		const view = mountRow({}, { push })

		expect(() => view.vm.onClick({ preventDefault: vi.fn() })).not.toThrow()
	})

	it('reflects the `active` prop as the row-active class (was router-link isActive)', async () => {
		const view = mountRow({ active: true })
		await view.vm.$nextTick()

		expect(view.find('.list-item__wrapper').classes()).toContain('list-item__wrapper--active')
	})
})

describe('EnvelopeSkeleton: hover/focus actions overlay is suppressed on touch (mobile tap ambiguity fix)', () => {
	// On a touch device a tap synthesizes focus AND mouseover, which would
	// flash the floating actions overlay and race the tap's own navigation
	// -- the original report behind backlog #18. Touch uses the deterministic
	// tap=open / long-press=select model instead, so the hover overlay must
	// never appear there.
	function mountRow(propsOverride = {}) {
		return shallowMount(EnvelopeSkeleton, {
			propsData: { name: 'Test envelope', ...propsOverride },
			mocks: { $router: { resolve: vi.fn(() => ({ href: '#' })), push: vi.fn() } },
			localVue,
		})
	}

	afterEach(() => {
		isCoarsePointer.mockReturnValue(false)
	})

	it('does not reveal the actions overlay on focus/mouseover when the pointer is coarse', () => {
		isCoarsePointer.mockReturnValue(true)
		const view = mountRow()
		view.vm.hasActions = true

		view.vm.showActions()
		view.vm.handleMouseover()

		expect(view.vm.displayActionsOnHoverFocus).toBe(false)
		expect(view.vm.hovered).toBe(false)
	})

	it('still reveals the actions overlay on a fine (mouse) pointer', () => {
		isCoarsePointer.mockReturnValue(false)
		const view = mountRow()
		view.vm.hasActions = true

		view.vm.showActions()

		expect(view.vm.displayActionsOnHoverFocus).toBe(true)
	})
})
