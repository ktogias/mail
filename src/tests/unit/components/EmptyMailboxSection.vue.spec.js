/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mount } from '@vue/test-utils'
import EmptyMailboxSection from '../../../components/EmptyMailboxSection.vue'

/**
 * "No messages" is true but useless when a search emptied the list: every
 * free-text word has to appear somewhere, so a single word the server has
 * never seen empties everything, and the three usual causes -- a typo, a word
 * that only occurs in a message body that was not searched, and a word spelled
 * with different accents than the user typed -- are indistinguishable from
 * "there is nothing there".
 *
 * Reported live on 2026-08-28: `ifiroumelioti εκθέματος` returned nothing
 * while `ifiroumelioti` alone matched 204 messages.
 */
describe('EmptyMailboxSection', () => {
	const mountWith = (unmatchedTerms) => mount(EmptyMailboxSection, {
		propsData: { unmatchedTerms },
		mocks: {
			t: (app, text) => text,
			n: (app, singular, plural, count, vars) => {
				const template = count === 1 ? singular : plural
				return template.replace('{terms}', vars.terms)
			},
		},
		stubs: {
			NcEmptyContent: {
				template: '<div><slot name="description" /></div>',
			},
		},
	})

	it('says nothing beyond "No messages" when there is nothing to explain', () => {
		expect(mountWith([]).text()).toBe('')
	})

	it('names the one word that emptied the list', () => {
		const text = mountWith(['εκθέματος']).text()

		expect(text).toContain('εκθέματος')
		expect(text).toContain('No message contains')
	})

	it('names every word that matched nothing', () => {
		const text = mountWith(['εκθέματος', 'wp4']).text()

		expect(text).toContain('εκθέματος')
		expect(text).toContain('wp4')
		expect(text).toContain('any of')
	})
})
