/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mount } from '@vue/test-utils'
import TasksAppIcon from '../../../../components/icons/TasksAppIcon.vue'

/**
 * The Tasks app's favicon, in two states.
 *
 * Filled tile: this message is the one the task came from.
 * Outlined: the conversation carries one.
 *
 * That is the distinction the envelope list already draws between Star and
 * StarOutline, and it has to read the same way here or the app teaches two
 * different rules for the same idea.
 *
 * Mounted rather than shallow, and asserted on what is DRAWN rather than on
 * the prop: a spec that only checked `props('outlined')` stayed green when the
 * component's outlined branch was disabled outright -- the prop was still
 * true, and nothing rendered differently. Proven by doing exactly that.
 */
describe('TasksAppIcon', () => {
	it('draws a filled tile with a white tick by default', () => {
		const wrapper = mount(TasksAppIcon)
		const svg = wrapper.html()

		// The brand blue as a FILL, and the tick knocked out in white.
		expect(svg).toContain('fill="#0082c9"')
		expect(svg).toContain('fill="#fff"')
		// No ring unless it is asked for: the halo is only wanted where the
		// mark sits on an avatar.
		expect(svg).toContain('stroke="none"')
	})

	it('rings itself in the background colour when haloed', () => {
		// The star and the importance flag both carry
		// stroke: var(--color-main-background) on the avatar so they stay
		// legible over whatever colour it happens to be. A solid tile without
		// one sat there looking heavier than either, which is what read as
		// "too big" rather than merely different.
		const svg = mount(TasksAppIcon, { propsData: { haloed: true } }).html()

		expect(svg).toContain('stroke="var(--color-main-background)"')
	})

	it('draws an outline with a blue tick when outlined', () => {
		const wrapper = mount(TasksAppIcon, { propsData: { outlined: true } })
		const svg = wrapper.html()

		expect(svg).toContain('stroke="#0082c9"')
		expect(svg).toContain('fill="none"')
		// No white knockout: on an outline there is nothing to knock out of.
		expect(svg).not.toContain('fill="#fff"')
	})

	it('draws the SAME rounded-square path in both states', () => {
		// Two states of one icon, not two icons. An outline built from a
		// <rect> has different corners and the pair stops looking related --
		// which is the entire job of borrowing the app's mark.
		const tile = 'M5 0h22a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H5a5 5 0 0 1-5-5V5a5 5 0 0 1 5-5Z'
		const tick = 'm9.55 18-5.7-5.7 1.425-1.425L9.55 15.15l9.175-9.175L20.15 7.4 9.55 18Z'

		for (const outlined of [false, true]) {
			const svg = mount(TasksAppIcon, { propsData: { outlined } }).html()
			expect(svg).toContain(tile)
			expect(svg).toContain(tick)
		}
		expect(mount(TasksAppIcon, { propsData: { outlined: true } }).html()).not.toContain('<rect')
	})

	it('keeps the literal brand blue rather than the instance theme', () => {
		// The point of borrowing another app's icon is that it is recognisable
		// as that app. Re-tinting it to var(--color-primary-element) would
		// defeat exactly the recognition it exists to provide.
		const wrapper = mount(TasksAppIcon)

		expect(wrapper.html()).not.toContain('--color-primary')
	})

	it('presents itself as a material-design-icon, which is what aligns it', () => {
		// Not decoration. Every icon inside an action menu is boxed by the
		// framework's own rule -- `.action-link .material-design-icon { width:
		// var(--default-clickable-area) }` -- and that box is what puts all of
		// them in one column with their labels starting at the same x. Without
		// the class this icon got no box at all: it sat left of every other
		// icon in the menu and its label began 24px early.
		const wrapper = mount(TasksAppIcon)

		expect(wrapper.classes()).toContain('material-design-icon')
		expect(wrapper.find('svg').classes()).toContain('material-design-icon__svg')
	})

	it('sizes the svg rather than the box, so the framework can box it', () => {
		// An inline width/height on the span beats a class rule on specificity,
		// which would leave the icon at its own size inside a menu that wants
		// to give it the clickable area. The dimensions belong on the svg --
		// where vue-material-design-icons puts them too.
		const wrapper = mount(TasksAppIcon, { propsData: { size: 16 } })

		expect(wrapper.attributes('style')).toBeUndefined()
		expect(wrapper.find('svg').attributes('width')).toBe('16')
	})

	it('is hidden from assistive technology, which reads the label instead', () => {
		// The marker's meaning lives in its aria-label/title; the icon
		// repeating it would announce the same thing twice.
		expect(mount(TasksAppIcon).attributes('aria-hidden')).toBe('true')
	})
})
