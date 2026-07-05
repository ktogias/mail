/**
 * SPDX-FileCopyrightText: 2023 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import Thread from '../../../components/Thread.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'
import useMainStore from '../../../store/mainStore.js'

const localVue = createLocalVue()

localVue.mixin(Nextcloud)

describe('Thread', () => {
	let store

	beforeEach(() => {
		setActivePinia(createPinia())

		store = useMainStore()
		store.getEnvelope = vi.fn().mockImplementation((id) => {
			if (id === 200) {
				return {
					accountId: 100,
					threadRootId: '123-456-789',
					mailboxId: 10,
				}
			}
			if (id === 300) {
				return {
					accountId: 200,
					threadRootId: '456-789-123',
					mailboxId: 20,
				}
			}
			if (id === 301) {
				return {
					accountId: 200,
					threadRootId: '456-789-123',
					mailboxId: 22,
				}
			}
			if (id === 302) {
				return {
					accountId: 200,
					threadRootId: '456-789-123',
					mailboxId: 23,
				}
			}
			if (id === 4003) {
				return {
					accountId: 300,
					threadRootId: 'thread-unread',
					mailboxId: 30,
				}
			}
			if (id === 5003) {
				return {
					accountId: 300,
					threadRootId: 'thread-allread',
					mailboxId: 30,
				}
			}
			return undefined
		})

		store.getEnvelopesByThreadRootId = vi.fn().mockImplementation((accountId, threadRootId) => {
			if (threadRootId === '123-456-789') {
				return [
					{
						accountId: 100,
						threadRootId: '123-456-789',
						mailboxId: 10,
						databaseId: 1001,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 100,
						threadRootId: '123-456-789',
						mailboxId: 11,
						databaseId: 1002,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 100,
						threadRootId: '123-456-789',
						mailboxId: 10,
						databaseId: 1003,
						from: [],
						to: [],
						cc: [],
					},
				]
			}
			if (threadRootId === '456-789-123') {
				return [
					{
						accountId: 200,
						threadRootId: '456-789-123',
						mailboxId: 20,
						databaseId: 2001,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 200,
						threadRootId: '456-789-123',
						mailboxId: 21,
						databaseId: 2002,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 200,
						threadRootId: '456-789-123',
						mailboxId: 20,
						databaseId: 2003,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 200,
						threadRootId: '456-789-123',
						mailboxId: 22,
						databaseId: 2004,
						from: [],
						to: [],
						cc: [],
					},
					{
						accountId: 200,
						threadRootId: '456-789-123',
						mailboxId: 23,
						databaseId: 2005,
						from: [],
						to: [],
						cc: [],
					},
				]
			}
			if (threadRootId === 'thread-unread') {
				// Oldest-to-newest, matching the real getter's dateInt sort.
				// The oldest (4001) is unread; the clicked/newest (4003,
				// the route's threadId) has already been read.
				return [
					{
						accountId: 300,
						threadRootId: 'thread-unread',
						mailboxId: 30,
						databaseId: 4001,
						from: [],
						to: [],
						cc: [],
						flags: { seen: false },
					},
					{
						accountId: 300,
						threadRootId: 'thread-unread',
						mailboxId: 30,
						databaseId: 4002,
						from: [],
						to: [],
						cc: [],
						flags: { seen: true },
					},
					{
						accountId: 300,
						threadRootId: 'thread-unread',
						mailboxId: 30,
						databaseId: 4003,
						from: [],
						to: [],
						cc: [],
						flags: { seen: true },
					},
				]
			}
			if (threadRootId === 'thread-allread') {
				return [
					{
						accountId: 300,
						threadRootId: 'thread-allread',
						mailboxId: 30,
						databaseId: 5001,
						from: [],
						to: [],
						cc: [],
						flags: { seen: true },
					},
					{
						accountId: 300,
						threadRootId: 'thread-allread',
						mailboxId: 30,
						databaseId: 5002,
						from: [],
						to: [],
						cc: [],
						flags: { seen: true },
					},
					{
						accountId: 300,
						threadRootId: 'thread-allread',
						mailboxId: 30,
						databaseId: 5003,
						from: [],
						to: [],
						cc: [],
						flags: { seen: true },
					},
				]
			}
			return []
		})

		store.getMailbox = vi.fn().mockImplementation((id) => {
			if (id === 10) {
				return {
					databaseId: 10,
					name: 'INBOX',
					accountId: 100,
					specialRole: 'inbox',
				}
			}
			if (id === 20) {
				return {
					databaseId: 20,
					name: 'INBOX',
					accountId: 200,
					specialRole: 'inbox',
				}
			}
			if (id === 22) {
				return {
					databaseId: 22,
					name: 'Trash',
					accountId: 200,
					specialRole: 'trash',
				}
			}
			if (id === 23) {
				return {
					databaseId: 23,
					name: 'Junk',
					accountId: 200,
					specialRole: 'junk',
				}
			}
			if (id === 30) {
				return {
					databaseId: 30,
					name: 'INBOX',
					accountId: 300,
					specialRole: 'inbox',
				}
			}
			return undefined
		})

		store.getMailboxes = vi.fn().mockImplementation((accountId) => {
			if (accountId === 100) {
				return [
					{
						databaseId: 10,
						name: 'INBOX',
						specialRole: 'inbox',
					},
					{
						databaseId: 11,
						name: 'Test',
						specialRole: '',
					},
				]
			}
			if (accountId === 200) {
				return [
					{
						databaseId: 20,
						name: 'INBOX',
						specialRole: 'inbox',
					},
					{
						databaseId: 21,
						name: 'Test',
						specialRole: '',
					},
					{
						databaseId: 22,
						name: 'Trash',
						specialRole: 'trash',
					},
					{
						databaseId: 23,
						name: 'Junk',
						specialRole: 'junk',
					},
				]
			}
			if (accountId === 300) {
				return [
					{
						databaseId: 30,
						name: 'INBOX',
						specialRole: 'inbox',
					},
				]
			}
			return []
		})
	})

	it('empty list when envelope not found', () => {
		const view = shallowMount(Thread, {
			mocks: {
				$route: {
					params: {
						threadId: 100,
					},
				},
			},
			store,
			localVue,
		})

		expect(view.vm.thread).toHaveLength(0)
	})

	it('show messages for thread root from inbox and test folder', () => {
		const view = shallowMount(Thread, {
			mocks: {
				$route: {
					params: {
						threadId: 200,
					},
				},
			},
			store,
			localVue,
		})

		expect(view.vm.thread).toHaveLength(3)
	})

	it('show messages for thread root from inbox and test folder, ignore trash', () => {
		const view = shallowMount(Thread, {
			mocks: {
				$route: {
					params: {
						threadId: 300,
					},
				},
			},
			store,
			localVue,
		})

		expect(view.vm.thread).toHaveLength(3)
	})

	it('show messages for thread root only from trash', () => {
		const view = shallowMount(Thread, {
			mocks: {
				$route: {
					params: {
						threadId: 301,
					},
				},
			},
			store,
			localVue,
		})

		const envelopes = view.vm.thread
		expect(envelopes).toHaveLength(1)
		expect(envelopes[0].mailboxId).toBe(22)
	})

	it('show messages for thread root only from junk', () => {
		const view = shallowMount(Thread, {
			mocks: {
				$route: {
					params: {
						threadId: 302,
					},
				},
			},
			store,
			localVue,
		})

		const envelopes = view.vm.thread
		expect(envelopes).toHaveLength(1)
		expect(envelopes[0].mailboxId).toBe(23)
	})

	describe('initiallyExpandedEnvelopeId', () => {
		it('opens on the first (oldest) unread message instead of always the clicked/newest one', () => {
			const view = shallowMount(Thread, {
				mocks: {
					$route: {
						params: {
							threadId: 4003,
						},
					},
				},
				store,
				localVue,
			})

			expect(view.vm.initiallyExpandedEnvelopeId()).toBe(4001)
			// resetThread() runs on created(), so this should already hold
			// without calling the method directly.
			expect(view.vm.expandedThreads).toEqual([4001])
		})

		it('falls back to the clicked/newest message when nothing in the thread is unread', () => {
			const view = shallowMount(Thread, {
				mocks: {
					$route: {
						params: {
							threadId: 5003,
						},
					},
				},
				store,
				localVue,
			})

			expect(view.vm.initiallyExpandedEnvelopeId()).toBe(5003)
			expect(view.vm.expandedThreads).toEqual([5003])
		})
	})
})
