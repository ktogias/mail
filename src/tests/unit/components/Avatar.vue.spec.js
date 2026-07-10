/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import Avatar from '../../../components/Avatar.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

describe('Avatar', () => {
	const mountWith = (displayName, email = 'jane@domain.tld') => shallowMount(Avatar, {
		propsData: {
			displayName,
			email,
		},
		localVue,
	})

	// NcAvatar's initials logic reads codePointAt(lastIndexOf(' ') + 1)
	// of the name filtered to letters/digits/whitespace. A display name
	// ending in emoji or symbols after a space filters to a string
	// ending in " ", putting that index one past the end: RangeError:
	// NaN is not a valid code point, thrown on every render of the list
	// item (observed live during search-result rendering).
	it.each([
		['trailing emoji after a space', 'John 🙂', 'John'],
		['trailing symbols after a space', 'SALE %%%', 'SALE'],
		['trailing punctuation', 'ACME Newsletter ~*~', 'ACME Newsletter'],
		['plain name stays untouched', 'Jane Doe', 'Jane Doe'],
	])('passes NcAvatar a name that cannot break its initials: %s', (_label, displayName, expected) => {
		const view = mountWith(displayName)

		expect(view.findComponent({ name: 'NcAvatar' }).props('displayName')).toBe(expected)
	})

	it('falls back to the email when the name has no letters or digits at all', () => {
		const view = mountWith('🙂 🙂')

		expect(view.findComponent({ name: 'NcAvatar' }).props('displayName')).toBe('jane@domain.tld')
	})

	it('falls back to a placeholder when name and email are both unusable', () => {
		const view = mountWith('🙂 🙂', '')

		expect(view.findComponent({ name: 'NcAvatar' }).props('displayName')).toBe('?')
	})
})
