/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createTestingPinia } from '@pinia/testing'
import { createLocalVue, shallowMount } from '@vue/test-utils'
import { PiniaVuePlugin, setActivePinia } from 'pinia'
import Imip from '../../../components/Imip.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'

// The getClonedWriteableCalendars getter clones each calendar through the DAV
// collection factory. Mock the factory so it returns our stable calendar object
// unchanged -- that keeps the same reference across getter reads, so createVObject
// spies survive (and no real cdav-library is needed).
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

const localVue = createLocalVue()
localVue.use(PiniaVuePlugin)
localVue.mixin(Nextcloud)

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// A REQUEST invitation whose only attendee is someone else -> the current user
// (me@example.com) matches neither the organizer nor any attendee.
const UNMATCHED_INVITE = [
	'BEGIN:VCALENDAR',
	'PRODID:-//test//EN',
	'VERSION:2.0',
	'METHOD:REQUEST',
	'BEGIN:VEVENT',
	'UID:test-uid-1',
	'DTSTAMP:20260101T000000Z',
	'DTSTART:20990101T100000Z',
	'DTEND:20990101T110000Z',
	'SUMMARY:Joint SDG Lab Call',
	'ORGANIZER;CN=ETSI:mailto:organizer@etsi.org',
	'ATTENDEE;CN=Someone;PARTSTAT=NEEDS-ACTION:mailto:someone-else@list.org',
	'END:VEVENT',
	'END:VCALENDAR',
].join('\r\n')

function stableCalendar(url, displayname) {
	return {
		url,
		displayname,
		color: '#0082c9',
		order: 0,
		currentUserPrivilegeSet: ['{DAV:}write'],
		calendarQuery: vi.fn().mockResolvedValue([]),
		createVObject: vi.fn().mockResolvedValue(undefined),
	}
}

function descriptor(stable) {
	return {
		isWriteable: () => true,
		resourcetype: ['{DAV:}collection', 'calendar'],
		_request: {},
		_url: stable.url,
		_props: { __stable: stable },
	}
}

describe('Imip', () => {
	let store
	let calendars

	beforeEach(() => {
		setActivePinia(createTestingPinia())
		store = useMainStore()
		calendars = {
			default: stableCalendar('https://cal/default/', 'Default'),
			work: stableCalendar('https://cal/work/', 'Work'),
		}
		store.$patch({
			currentUserPrincipal: {
				email: 'me@example.com',
				calendarUserAddressSet: ['mailto:me@example.com'],
				scheduleDefaultCalendarUrl: 'https://cal/default/',
				displayname: 'Me',
			},
			calendars: [descriptor(calendars.default), descriptor(calendars.work)],
		})
	})

	function mountImip({ account } = {}) {
		return shallowMount(Imip, {
			localVue,
			propsData: {
				scheduling: { id: 1, method: 'REQUEST', contents: UNMATCHED_INVITE },
				account: {
					id: 4,
					emailAddress: 'me@example.com',
					imipAllowUnmatched: false,
					defaultCalendarUrl: null,
					...account,
				},
			},
			stubs: { EventData: true },
		})
	}

	it('is not a real attendee of an unmatched invitation', () => {
		expect(mountImip().vm.userIsAttendee).toBe(false)
	})

	it('exposes allowUnmatchedAccept from the account setting', () => {
		expect(mountImip({ account: { imipAllowUnmatched: true } }).vm.allowUnmatchedAccept).toBe(true)
		expect(mountImip({ account: { imipAllowUnmatched: false } }).vm.allowUnmatchedAccept).toBe(false)
	})

	it('can react only when the account opts into unmatched invitations', () => {
		expect(mountImip({ account: { imipAllowUnmatched: false } }).vm.canReact).toBe(false)
		expect(mountImip({ account: { imipAllowUnmatched: true } }).vm.canReact).toBe(true)
	})

	it('shows the dead-end hint when unmatched acceptance is off', () => {
		expect(mountImip({ account: { imipAllowUnmatched: false } }).text())
			.toContain('does not contain a participant that matches')
	})

	it('offers acceptance (and hides the dead-end hint) when unmatched acceptance is on', async () => {
		const view = mountImip({ account: { imipAllowUnmatched: true } })
		await flush()

		expect(view.text()).not.toContain('does not contain a participant that matches')
		expect(view.find('.imip__actions--buttons').exists()).toBe(true)
	})

	it('picks the own address (preferring the account address) for the party-crasher attendee', () => {
		expect(mountImip({ account: { imipAllowUnmatched: true } }).vm.partyCrasherAddress).toBe('me@example.com')
	})

	it('addSelfAsAttendee adds the own address as a new ATTENDEE', () => {
		const view = mountImip({ account: { imipAllowUnmatched: true } })
		const vEvent = view.vm.attachedVEvent

		const attendee = view.vm.addSelfAsAttendee(vEvent)

		expect(attendee).toBeTruthy()
		expect(attendee.email.toLowerCase()).toContain('me@example.com')
		const emails = [...vEvent.getAttendeeIterator()].map((a) => a.email.toLowerCase())
		expect(emails.some((e) => e.includes('me@example.com'))).toBe(true)
	})

	it('accepting an unmatched invite adds self and persists the event (party crasher)', async () => {
		const view = mountImip({ account: { imipAllowUnmatched: true } })
		await flush()
		const addSpy = vi.spyOn(view.vm, 'addSelfAsAttendee')

		await view.vm.accept()

		expect(addSpy).toHaveBeenCalled()
		// The default target calendar's createVObject was called with an ICS that
		// now carries our own address -> the server can schedule the REPLY.
		expect(calendars.default.createVObject).toHaveBeenCalled()
		expect(calendars.default.createVObject.mock.calls[0][0].toLowerCase()).toContain('me@example.com')
	})

	it('does not persist anything when unmatched acceptance is off', async () => {
		const view = mountImip({ account: { imipAllowUnmatched: false } })
		await flush()

		await view.vm.accept()

		expect(calendars.default.createVObject).not.toHaveBeenCalled()
		expect(calendars.work.createVObject).not.toHaveBeenCalled()
	})

	it('defaults the target calendar to the account default', async () => {
		const view = mountImip({ account: { imipAllowUnmatched: true, defaultCalendarUrl: 'https://cal/work/' } })
		await flush()

		expect(view.vm.targetCalendar.url).toBe('https://cal/work/')
	})

	it('falls back to the schedule-default calendar when the account has no default', async () => {
		const view = mountImip({ account: { imipAllowUnmatched: true, defaultCalendarUrl: null } })
		await flush()

		expect(view.vm.targetCalendar.url).toBe('https://cal/default/')
	})
})
