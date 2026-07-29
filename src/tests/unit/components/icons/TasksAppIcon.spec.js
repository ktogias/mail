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
		expect(svg).not.toContain('stroke=')
	})

	it('draws an outline with a blue tick when outlined', () => {
		const wrapper = mount(TasksAppIcon, { propsData: { outlined: true } })
		const svg = wrapper.html()

		expect(svg).toContain('stroke="#0082c9"')
		expect(svg).toContain('fill="none"')
		// No white knockout: on an outline there is nothing to knock out of.
		expect(svg).not.toContain('fill="#fff"')
	})

	it('keeps the literal brand blue rather than the instance theme', () => {
		// The point of borrowing another app's icon is that it is recognisable
		// as that app. Re-tinting it to var(--color-primary-element) would
		// defeat exactly the recognition it exists to provide.
		const wrapper = mount(TasksAppIcon)

		expect(wrapper.html()).not.toContain('--color-primary')
	})

	it('is hidden from assistive technology, which reads the label instead', () => {
		// The marker's meaning lives in its aria-label/title; the icon
		// repeating it would announce the same thing twice.
		expect(mount(TasksAppIcon).attributes('aria-hidden')).toBe('true')
	})
})
