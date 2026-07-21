/**
 * SPDX-FileCopyrightText: 2020-2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createPinia, setActivePinia } from 'pinia'
import { curry, range, reverse } from 'ramda'
import Vue from 'vue'
import MailboxLockedError from '../../../errors/MailboxLockedError.js'
import MalformedSyncResponseError from '../../../errors/MalformedSyncResponseError.js'
import * as AccountService from '../../../service/AccountService.js'
import * as MailboxService from '../../../service/MailboxService.js'
import * as MessageService from '../../../service/MessageService.js'
import * as NotificationService from '../../../service/NotificationService.js'
import * as ThreadService from '../../../service/ThreadService.js'
import { PAGE_SIZE, UNIFIED_INBOX_ID } from '../../../store/constants.js'
import useMainStore from '../../../store/mainStore.js'
import { computeLockRetryDelayMs, mapWithConcurrencyLimit, reconcileNearExpiryLocalChanges, resetRecentLocalChangesForTests, resetSharedNetworkLimiterForTests } from '../../../store/mainStore/actions.js'
import { normalizedEnvelopeListId } from '../../../util/normalization.js'
import { wait } from '../../../util/wait.js'

vi.mock('../../../service/AccountService.js')
vi.mock('../../../service/MailboxService.js')
vi.mock('../../../service/MessageService.js')
vi.mock('../../../service/NotificationService.js')
vi.mock('../../../service/ThreadService.js')
vi.mock('../../../util/normalization.js', () => ({
	__esModule: true,
	// Supply a default list id ('') to prevent annoying errors
	normalizedEnvelopeListId: vi.fn(() => ''),
}))
// The lock-retry loop's 1.5s backoff would make its tests slow for no
// reason -- resolve immediately instead.
vi.mock('../../../util/wait.js', () => ({
	__esModule: true,
	wait: vi.fn(() => Promise.resolve()),
}))

const mockEnvelope = curry((mailboxId, uid) => ({
	databaseId: mailboxId * 1000 + uid,
	mailboxId,
	uid,
	dateInt: uid * 10000,
	threadRootId: Math.random().toString(),
}))

describe('Vuex store actions', () => {
	let store

	beforeEach(() => {
		setActivePinia(createPinia())

		store = useMainStore()
		resetSharedNetworkLimiterForTests()
		resetRecentLocalChangesForTests()
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it('creates a mailbox', async () => {
		const account = {
			id: 13,
			personalNamespace: '',
			mailboxes: [],
		}
		const name = 'Important'
		const mailbox = {
			name: 'Important',
		}

		store.addAccountMutation(account)

		MailboxService.create.mockResolvedValue(mailbox)

		const result = await store.createMailbox({ account, name })

		expect(result).toEqual(mailbox)
		expect(MailboxService.create).toHaveBeenCalledWith(13, 'Important')
	})

	it('creates a sub-mailbox', async () => {
		const account = {
			id: 13,
			personalNamespace: '',
			mailboxes: [],
		}
		const name = 'Archive.2020'
		const mailbox = {
			name: 'Archive.2020',
		}

		store.addAccountMutation(account)

		MailboxService.create.mockResolvedValue(mailbox)

		const result = await store.createMailbox({ account, name })

		expect(result).toEqual(mailbox)
		expect(MailboxService.create).toHaveBeenCalledWith(13, 'Archive.2020')
	})

	it('adds a prefix to new mailboxes if the account has a personal namespace', async () => {
		const account = {
			id: 13,
			personalNamespace: 'INBOX.',
			mailboxes: [],
		}
		const name = 'Important'
		const mailbox = {
			name: 'INBOX.Important',
		}

		store.addAccountMutation(account)

		MailboxService.create.mockResolvedValue(mailbox)

		const result = await store.createMailbox({ account, name })

		expect(result).toEqual(mailbox)
		expect(MailboxService.create).toHaveBeenCalledWith(13, 'INBOX.Important')
	})

	it('adds no prefix to new sub-mailboxes if the account has a personal namespace', async () => {
		const account = {
			id: 13,
			personalNamespace: 'INBOX.',
			mailboxes: [],
		}
		const name = 'INBOX.Archive.2020'
		const mailbox = {
			name: 'INBOX.Archive.2020',
		}

		store.addAccountMutation(account)

		MailboxService.create.mockResolvedValue(mailbox)

		const result = await store.createMailbox({ account, name })

		expect(result).toEqual(mailbox)
		expect(MailboxService.create).toHaveBeenCalledWith(13, 'INBOX.Archive.2020')
	})

	it('combines unified inbox even if no inboxes are present', async () => {
		const envelopes = await store.fetchEnvelopes({
			mailboxId: UNIFIED_INBOX_ID,
		})

		expect(envelopes).toEqual([])
	})

	it('creates a unified page from one mailbox', async () => {
		const account = {
			id: 13,
			personalNamespace: 'INBOX.',
			mailboxes: [],
		}

		store.addAccountMutation(account)
		store.addMailboxMutation({
			account,
			mailbox: {
				id: 'INBOX',
				name: 'INBOX',
				databaseId: 21,
				accountId: 13,
				specialRole: 'inbox',
			},
		})
		store.addMailboxMutation({
			account,
			mailbox: {
				id: 'Drafts',
				name: 'Drafts',
				databaseId: 22,
				accountId: 13,
				specialRole: 'draft',
			},
		})

		store.addEnvelopesMutation = vi.fn()

		MessageService.fetchEnvelopes.mockReturnValueOnce(Promise.resolve([{
			databaseId: 123,
			mailboxId: 21,
			uid: 321,
			subject: 'msg1',
		}]))

		const envelopes = await store.fetchEnvelopes({
			mailboxId: UNIFIED_INBOX_ID,
		})

		expect(envelopes).toEqual([
			{
				databaseId: 123,
				mailboxId: 21,
				uid: 321,
				subject: 'msg1',
			},
		])
		expect(store.addEnvelopesMutation).toBeCalledWith({
			envelopes: [{
				databaseId: 123,
				mailboxId: 21,
				uid: 321,
				subject: 'msg1',
			}],
			query: undefined,
		})
	})

	it('a stale id in a bucket list must not break adding new envelopes', async () => {
		// Regression: an id whose envelope was gone from this.envelopes
		// (left behind by an incomplete removal) made the sort helper throw,
		// killing the whole mutation -- the bucket then silently rejected
		// every new envelope forever: new mail re-served as "new" on every
		// poll, the visible listing frozen, and the new-message notification
		// (chained after the sync) never fired.
		normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
		const account13 = { id: 13 }
		store.addAccountMutation(account13)
		store.addMailboxMutation({
			account: account13,
			mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
		})
		store.addEnvelopesMutation({
			envelopes: [
				{ databaseId: 1, mailboxId: 11, uid: 1, dateInt: 100, flags: {}, tags: {} },
				{ databaseId: 2, mailboxId: 11, uid: 2, dateInt: 200, flags: {}, tags: {} },
			],
			addToUnifiedMailboxes: false,
		})
		// simulate whatever leaves a list id without a backing envelope
		delete store.envelopes[2]

		store.addEnvelopesMutation({
			envelopes: [{ databaseId: 3, mailboxId: 11, uid: 3, dateInt: 300, flags: {}, tags: {} }],
			addToUnifiedMailboxes: false,
		})
		expect(store.mailboxes[11].envelopeLists['']).toContain(3)
	})

	it('addEnvelopesMutation() writes each touched list through Vue.set only once per batch, not once per envelope', () => {
		// Confirmed live: Firefox's own "unresponsive script" warning fired
		// mid a sort comparator inside this exact mutation. Re-reading,
		// sorting, deduplicating, and Vue.set-ing a list once PER ENVELOPE
		// in a large batch was O(n * L log L) for no reason -- an envelope
		// only needs the list to already reflect its predecessors in the
		// same batch, not to be fully sorted/deduped/reactive after every
		// single one. This pins the fix: one Vue.set per list actually
		// touched, however many envelopes land in it.
		normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
		const account13 = { id: 13 }
		store.addAccountMutation(account13)
		store.addMailboxMutation({
			account: account13,
			mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
		})
		store.preferences['sort-order'] = 'newest'

		const setSpy = vi.spyOn(Vue, 'set')
		store.addEnvelopesMutation({
			envelopes: [
				{ databaseId: 10, mailboxId: 11, uid: 1, dateInt: 300, threadRootId: 'a', flags: {}, tags: {} },
				{ databaseId: 11, mailboxId: 11, uid: 2, dateInt: 100, threadRootId: 'b', flags: {}, tags: {} },
				{ databaseId: 12, mailboxId: 11, uid: 3, dateInt: 200, threadRootId: 'c', flags: {}, tags: {} },
			],
			addToUnifiedMailboxes: false,
		})

		const envelopeListWrites = setSpy.mock.calls.filter((call) => call[0] === store.mailboxes[11].envelopeLists)
		expect(envelopeListWrites).toHaveLength(1)
		// Still correctly sorted (newest first, the default) and complete --
		// batching the write must not change the observable result.
		expect(store.mailboxes[11].envelopeLists['']).toEqual([10, 12, 11])
		setSpy.mockRestore()
	})

	it('fetchEnvelopes() drops entries that no longer match a filtered query', async () => {
		// A real bug: opening a saved/quick filter (e.g. "unread") that was
		// already cached from an earlier visit showed a message that had
		// since been read elsewhere -- addEnvelopesMutation() only ever
		// added-or-replaced entries present in the fresh response, it never
		// pruned ones absent from it. fetchEnvelopes() fetches a full,
		// authoritative snapshot of what currently matches a query (unlike
		// an incremental sync's newMessages), so a message missing from
		// that snapshot must be dropped from the cached list, not left
		// lingering forever.
		normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

		const account13 = {
			id: 13,
		}

		store.addAccountMutation(account13)
		store.addMailboxMutation({
			account: account13,
			mailbox: {
				name: 'INBOX',
				databaseId: 11,
				specialRole: 'inbox',
			},
		})

		const stillUnread = mockEnvelope(11, 1)
		const nowRead = mockEnvelope(11, 2)

		// Simulate an earlier visit to the "unread" filter that cached both.
		store.addEnvelopesMutation({
			query: 'is:unread',
			envelopes: [stillUnread, nowRead],
			addToUnifiedMailboxes: false,
		})
		expect(store.mailboxes[11].envelopeLists['is:unread']).toHaveLength(2)

		// The message has since been read; a fresh fetch of the same
		// filter now only returns the one still-unread message.
		MessageService.fetchEnvelopes.mockResolvedValueOnce([stillUnread])

		await store.fetchEnvelopes({
			mailboxId: 11,
			query: 'is:unread',
		})

		expect(store.mailboxes[11].envelopeLists['is:unread']).toEqual([stillUnread.databaseId])
	})

	it('creates a unified page from the accounts that succeed even if another account fails', async () => {
		const account13 = {
			id: 13,
			personalNamespace: '',
			mailboxes: [],
		}
		const account14 = {
			id: 14,
			personalNamespace: '',
			mailboxes: [],
		}

		store.addAccountMutation(account13)
		store.addAccountMutation(account14)
		store.addMailboxMutation({
			account: account13,
			mailbox: {
				id: 'INBOX',
				name: 'INBOX',
				databaseId: 21,
				accountId: 13,
				specialRole: 'inbox',
			},
		})
		store.addMailboxMutation({
			account: account14,
			mailbox: {
				id: 'INBOX',
				name: 'INBOX',
				databaseId: 31,
				accountId: 14,
				specialRole: 'inbox',
			},
		})

		store.addEnvelopesMutation = vi.fn()

		MessageService.fetchEnvelopes.mockImplementation(async (accountId) => {
			if (accountId === 14) {
				throw new Error('account 14 is temporarily unavailable')
			}

			return [{
				databaseId: 123,
				mailboxId: 21,
				uid: 321,
				subject: 'msg1',
			}]
		})

		const envelopes = await store.fetchEnvelopes({
			mailboxId: UNIFIED_INBOX_ID,
		})

		// The unreachable account (14) contributes nothing, but the
		// reachable one (13) still renders instead of the whole unified
		// fetch coming back empty.
		expect(envelopes).toEqual([
			{
				databaseId: 123,
				mailboxId: 21,
				uid: 321,
				subject: 'msg1',
			},
		])
	})

	it('caps the unified fan-out so constituent fetches never all run at once', async () => {
		// A slow search across many accounts used to fire every
		// constituent request simultaneously (worst live case: a
		// priority search saturated the whole FPM pool and every
		// request 504ed). Mirrors ENVELOPE_FETCH_CONCURRENCY in
		// actions.js.
		for (let i = 0; i < 5; i++) {
			const account = {
				id: 100 + i,
				personalNamespace: '',
				mailboxes: [],
			}
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: {
					id: 'INBOX',
					name: 'INBOX',
					databaseId: 200 + i,
					accountId: account.id,
					specialRole: 'inbox',
				},
			})
		}
		store.addEnvelopesMutation = vi.fn()

		let concurrent = 0
		let maxConcurrent = 0
		const pendingResolvers = []
		MessageService.fetchEnvelopes.mockImplementation(() => new Promise((resolve) => {
			concurrent++
			maxConcurrent = Math.max(maxConcurrent, concurrent)
			pendingResolvers.push(() => {
				concurrent--
				resolve([])
			})
		}))

		const fetchPromise = store.fetchEnvelopes({
			mailboxId: UNIFIED_INBOX_ID,
			query: 'to:euseful from:euseful subject:euseful match:anyof',
		})

		await vi.waitFor(() => {
			if (pendingResolvers.length < 3) {
				throw new Error(`only ${pendingResolvers.length} constituent fetches have started so far`)
			}
		})

		expect(pendingResolvers.length).toBe(3)
		expect(maxConcurrent).toBe(3)

		// Draining the first wave lets the remaining 2 start without
		// ever exceeding the cap.
		while (pendingResolvers.length > 0) {
			pendingResolvers.splice(0).forEach((resolve) => resolve())
			await new Promise((resolve) => setTimeout(resolve, 0))
		}
		await fetchPromise

		expect(maxConcurrent).toBe(3)
		expect(MessageService.fetchEnvelopes).toHaveBeenCalledTimes(5)
	})

	describe('fetchEnvelopes marks its list as in-flight', () => {
		// MailboxThread's priority sections are v-shown on "has
		// envelopes"; during a search every list is empty until the
		// fetch returns, so without this marker all sections (and their
		// loading skeletons) vanished into a blank white list.
		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = {
				id: 13,
				personalNamespace: '',
				mailboxes: [],
			}
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: {
					id: 'INBOX',
					name: 'INBOX',
					databaseId: 11,
					accountId: 13,
					specialRole: 'inbox',
				},
			})
		})

		it('is fetching while the request is pending, per mailbox+query, and clears on success', async () => {
			let resolveFetch
			MessageService.fetchEnvelopes.mockReturnValue(new Promise((resolve) => {
				resolveFetch = resolve
			}))

			const promise = store.fetchEnvelopes({ mailboxId: 11, query: 'subject:x' })

			expect(store.isFetchingEnvelopes(11, 'subject:x')).toBe(true)
			expect(store.isFetchingEnvelopes(11, 'subject:y')).toBe(false)
			expect(store.isFetchingEnvelopes(11, undefined)).toBe(false)

			resolveFetch([])
			await promise

			expect(store.isFetchingEnvelopes(11, 'subject:x')).toBe(false)
		})

		it('clears the marker when the fetch rejects, so a failed search cannot leave a phantom skeleton', async () => {
			MessageService.fetchEnvelopes.mockRejectedValueOnce(new Error('boom'))

			await expect(store.fetchEnvelopes({ mailboxId: 11, query: 'subject:x' })).rejects.toThrow('boom')

			expect(store.isFetchingEnvelopes(11, 'subject:x')).toBe(false)
		})

		it('clears the marker in the very same tick as the envelope-list write, not a tick later', async () => {
			// Clearing the marker via the outer .finally() (a microtask
			// hop after the tap() that writes the list) let a section
			// briefly see "list is empty AND not fetching" one tick before
			// a sibling section's own render caught up, or vice versa --
			// either way, a section flashed its own empty state for one
			// frame before the v-show gating it (which OR's the two
			// signals) hid it again (confirmed live on a favorites
			// section during a no-match search). Stepping one microtask
			// at a time: the list write and the marker clear must land on
			// the exact same tick.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			let resolveFetch
			MessageService.fetchEnvelopes.mockReturnValue(new Promise((resolve) => {
				resolveFetch = resolve
			}))

			const promise = store.fetchEnvelopes({ mailboxId: 11, query: 'subject:x' })
			resolveFetch([])

			let listWrittenTick = -1
			let markerClearedTick = -1
			for (let tick = 0; tick < 10 && (listWrittenTick === -1 || markerClearedTick === -1); tick++) {
				await Promise.resolve()
				if (listWrittenTick === -1 && store.mailboxes[11].envelopeLists['subject:x'] !== undefined) {
					listWrittenTick = tick
				}
				if (markerClearedTick === -1 && !store.isFetchingEnvelopes(11, 'subject:x')) {
					markerClearedTick = tick
				}
			}

			expect(markerClearedTick).toBe(listWrittenTick)

			await promise
		})
	})

	it('paging past an empty fanned-out list resolves to [] instead of throwing', async () => {
		// The infinite-scroll observer fires even over an empty list (a
		// priority-inbox search with no matches); the cursor lookup used
		// to throw 'Unified list has no tail', turning every such scroll
		// into a console error instead of a clean end-reached.
		normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
		const account = {
			id: 13,
			personalNamespace: '',
			mailboxes: [],
		}
		store.addAccountMutation(account)
		store.addMailboxMutation({
			account,
			mailbox: {
				id: 'INBOX',
				name: 'INBOX',
				databaseId: 11,
				accountId: 13,
				specialRole: 'inbox',
			},
		})

		const envelopes = await store.fetchNextEnvelopePage({
			mailboxId: UNIFIED_INBOX_ID,
			query: 'subject:nothing-matches-this',
		})

		expect(envelopes).toEqual([])
		expect(MessageService.fetchEnvelopes).not.toHaveBeenCalled()
	})

	describe('addEnvelopesMutation classifies new inbox mail into loaded priority-inbox sections locally', () => {
		// The priority sections (is:pi-important / is:pi-other) are
		// server-materialized lists the same-listId unified cross-post
		// never reaches -- new mail hit a mailbox's badge long before
		// the open priority inbox. The envelope carries flags.important,
		// which is exactly what the server-side filter checks, so the
		// mutation classifies locally; the poller's server refresh
		// remains as reconciliation.
		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = {
				id: 13,
				personalNamespace: '',
				mailboxes: [],
			}
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: {
					id: 'INBOX',
					name: 'INBOX',
					databaseId: 11,
					accountId: 13,
					specialRole: 'inbox',
				},
			})
		})

		const newEnvelope = (databaseId, important, mailboxId = 11) => ({
			databaseId,
			mailboxId,
			uid: databaseId,
			dateInt: databaseId * 1000,
			flags: { seen: false, important },
			tags: {},
		})

		it('an important message lands in the loaded is:pi-important list at once', () => {
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important'] = []
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-other'] = []

			store.addEnvelopesMutation({ envelopes: [newEnvelope(55, true)] })

			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']).toEqual([55])
			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-other']).toEqual([])
		})

		it('an unimportant message lands in the loaded is:pi-other list at once', () => {
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important'] = []
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-other'] = []

			store.addEnvelopesMutation({ envelopes: [newEnvelope(56, false)] })

			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']).toEqual([])
			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-other']).toEqual([56])
		})

		it('does not create section lists nobody has loaded', () => {
			store.addEnvelopesMutation({ envelopes: [newEnvelope(57, true)] })

			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']).toBeUndefined()
			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-other']).toBeUndefined()
		})

		it('ignores mail from non-inbox mailboxes -- only inboxes feed the priority inbox', () => {
			store.addMailboxMutation({
				account: { id: 13, personalNamespace: '', mailboxes: [] },
				mailbox: {
					id: 'Sent',
					name: 'Sent',
					databaseId: 12,
					accountId: 13,
					specialRole: 'sent',
				},
			})
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important'] = []
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-other'] = []

			store.addEnvelopesMutation({ envelopes: [newEnvelope(58, true, 12)] })

			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']).toEqual([])
			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-other']).toEqual([])
		})

		it('keeps the section list sorted and deduplicated', () => {
			store.preferences['sort-order'] = 'newest'
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important'] = []

			store.addEnvelopesMutation({ envelopes: [newEnvelope(60, true)] })
			store.addEnvelopesMutation({ envelopes: [newEnvelope(62, true)] })
			// The same message reported again by another bucket's sync.
			store.addEnvelopesMutation({ envelopes: [newEnvelope(60, true)] })

			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']).toEqual([62, 60])
		})

		it('leaves an unchanged bucket list untouched (same reference) when a sync reports nothing that actually differs', () => {
			// SyncService.php reports every known message as "changed" on
			// every sync (no real changed-set computation upstream), so most
			// incremental sync batches for an already-loaded bucket touch
			// every id in it without membership or order actually differing.
			// Vue 2 doesn't diff a Vue.set()'s new value against the old one
			// -- it notifies on every Vue.set() regardless -- so writing a
			// freshly-built but content-identical array here would still
			// force a full re-render of the whole list on every routine
			// sync. Confirmed via a real object-identity check (toBe, not
			// toEqual): the array reference itself must survive unchanged.
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important'] = []
			store.addEnvelopesMutation({ envelopes: [newEnvelope(63, true)] })
			const listAfterFirstSync = store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']

			// The exact same message, reported again by a routine resync
			// with nothing about it actually different.
			store.addEnvelopesMutation({ envelopes: [newEnvelope(63, true)] })

			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']).toBe(listAfterFirstSync)
		})

		it('still writes a fresh list when a sync genuinely changes membership', () => {
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important'] = []
			store.addEnvelopesMutation({ envelopes: [newEnvelope(64, true)] })
			const listAfterFirstSync = store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']

			store.addEnvelopesMutation({ envelopes: [newEnvelope(65, true)] })

			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']).not.toBe(listAfterFirstSync)
			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']).toEqual(expect.arrayContaining([64, 65]))
		})

		it('withholds a new reply to a starred thread from the Other section the server returned it for (a known sibling is starred)', () => {
			// The server classifies each message on its own flags, so a new
			// non-starred reply to a starred thread comes back for the Other
			// section (not:starred is:pi-other) even though the whole thread
			// belongs to Favorites -- it must not show as a standalone Other row.
			store.envelopes[70] = { databaseId: 70, accountId: 13, mailboxId: 11, uid: 70, dateInt: 70000, threadRootId: 'thr-fav', flags: { seen: true, flagged: true, important: false }, tags: {} }
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = []
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['not:starred is:pi-other'] = []

			const reply = { databaseId: 71, mailboxId: 11, uid: 71, dateInt: 71000, threadRootId: 'thr-fav', flags: { seen: false, flagged: false, important: false }, tags: {} }
			store.addEnvelopesMutation({ query: 'not:starred is:pi-other', envelopes: [reply] })

			// Stored (so threadRootId grouping still shows it inside the thread)...
			expect(store.envelopes[71]).toBeDefined()
			// ...but kept out of the Other section rather than a standalone row.
			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).not.toContain(71)
			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['not:starred is:pi-other']).not.toContain(71)
		})

		it('still adds a new reply to the Other section when no thread sibling is starred or important (server trusted)', () => {
			store.envelopes[80] = { databaseId: 80, accountId: 13, mailboxId: 11, uid: 80, dateInt: 80000, threadRootId: 'thr-other', flags: { seen: true, flagged: false, important: false }, tags: {} }
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = [80]
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['not:starred is:pi-other'] = [80]

			const reply = { databaseId: 81, mailboxId: 11, uid: 81, dateInt: 81000, threadRootId: 'thr-other', flags: { seen: false, flagged: false, important: false }, tags: {} }
			store.addEnvelopesMutation({ query: 'not:starred is:pi-other', envelopes: [reply] })

			// Thread-collapsed: the newest member represents the thread row.
			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['not:starred is:pi-other']).toContain(81)
		})
	})

	describe('addEnvelopesMutation: new mail in an existing thread invalidates its cached member list and, if open, proactively prefetches the body', () => {
		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
		})

		const newReply = (databaseId, threadRootId, mailboxId = 11) => ({
			databaseId,
			mailboxId,
			uid: databaseId,
			dateInt: databaseId * 1000,
			threadRootId,
			flags: { seen: false },
			tags: {},
		})

		it('clears a stale cached .thread on another envelope sharing the new message\'s threadRootId', () => {
			store.envelopes[70] = { databaseId: 70, mailboxId: 11, accountId: 13, threadRootId: 'thread-a', thread: [70] }

			store.addEnvelopesMutation({ envelopes: [newReply(71, 'thread-a')] })

			expect(store.envelopes[70].thread).toBeUndefined()
		})

		it('leaves an unrelated thread\'s cached .thread untouched', () => {
			store.envelopes[80] = { databaseId: 80, mailboxId: 11, accountId: 13, threadRootId: 'thread-b', thread: [80] }

			store.addEnvelopesMutation({ envelopes: [newReply(81, 'thread-a')] })

			expect(store.envelopes[80].thread).toEqual([80])
		})

		it('does not touch anything for an already-known envelope (a flags/changed resync, not genuinely new mail)', () => {
			store.envelopes[70] = { databaseId: 70, mailboxId: 11, accountId: 13, threadRootId: 'thread-a', thread: [70] }
			store.envelopes[71] = { databaseId: 71, mailboxId: 11, accountId: 13, threadRootId: 'thread-a', flags: { seen: false } }

			store.addEnvelopesMutation({ envelopes: [newReply(71, 'thread-a')] })

			expect(store.envelopes[70].thread).toEqual([70])
		})

		it('proactively, speculatively prefetches the new message\'s body when its thread is the one currently open', async () => {
			store.envelopes[70] = { databaseId: 70, mailboxId: 11, accountId: 13, threadRootId: 'thread-a' }
			store.setCurrentOpenThreadIdMutation(70)
			MessageService.fetchMessage.mockResolvedValue({ databaseId: 71 })

			store.addEnvelopesMutation({ envelopes: [newReply(71, 'thread-a')] })
			await Promise.resolve()
			await Promise.resolve()

			expect(MessageService.fetchMessage).toHaveBeenCalledWith(71, expect.objectContaining({ signal: expect.any(AbortSignal) }))
		})

		it('does not prefetch when the new message belongs to a different thread than the one open', async () => {
			store.envelopes[70] = { databaseId: 70, mailboxId: 11, accountId: 13, threadRootId: 'thread-a' }
			store.setCurrentOpenThreadIdMutation(70)

			store.addEnvelopesMutation({ envelopes: [newReply(91, 'thread-z')] })
			await Promise.resolve()

			expect(MessageService.fetchMessage).not.toHaveBeenCalled()
		})

		it('does not prefetch when no thread is currently open', async () => {
			store.addEnvelopesMutation({ envelopes: [newReply(91, 'thread-z')] })
			await Promise.resolve()

			expect(MessageService.fetchMessage).not.toHaveBeenCalled()
		})
	})

	describe('appendOrReplaceEnvelopeId: O(1) thread dedup via a Map, instead of an O(L) scan per envelope', () => {
		// The old implementation re-scanned the whole growing list with
		// findIndex() for every single envelope in a batch -- O(n*L) for a
		// batch of n against a list of L ids, confirmed live as a real,
		// measurable cost for large batches against large (thousands of
		// ids) mailboxes, on top of the read-sort-dedupe-write batching
		// fixed separately the same day. The working list now carries its
		// own thread-root -> index Map alongside the plain id array, kept
		// in sync incrementally so each lookup is O(1).
		function working(ids) {
			const indexByThreadKey = new Map()
			ids.forEach((id, index) => indexByThreadKey.set(store.envelopes[id].threadRootId ?? `id:${id}`, index))
			return { ids, indexByThreadKey }
		}

		it('appends a new thread and records its index in the Map', () => {
			store.envelopes[1] = { databaseId: 1, threadRootId: 'thread-A' }
			store.envelopes[2] = { databaseId: 2, threadRootId: 'thread-B' }
			const w = working([1])

			store.appendOrReplaceEnvelopeId(w, { databaseId: 2, threadRootId: 'thread-B' })

			expect(w.ids).toEqual([1, 2])
			expect(w.indexByThreadKey.get('thread-B')).toBe(1)
		})

		it('replaces the existing entry in place for an already-known thread, without re-scanning', () => {
			store.envelopes[1] = { databaseId: 1, threadRootId: 'thread-A' }
			store.envelopes[2] = { databaseId: 2, threadRootId: 'thread-A' } // a newer reply, same thread
			const w = working([1])

			store.appendOrReplaceEnvelopeId(w, { databaseId: 2, threadRootId: 'thread-A' })

			expect(w.ids).toEqual([2])
			expect(w.indexByThreadKey.get('thread-A')).toBe(0)
		})

		it('singleton (flat) view always appends, ignoring the thread Map entirely', () => {
			store.preferences['layout-message-view'] = 'singleton'
			store.envelopes[1] = { databaseId: 1, threadRootId: 'thread-A' }
			const w = working([1])

			store.appendOrReplaceEnvelopeId(w, { databaseId: 2, threadRootId: 'thread-A' })

			expect(w.ids).toEqual([1, 2])
		})

		// Regression found while building the Map: JS's === treats two
		// DIFFERENT thread-less envelopes' undefined threadRootId as
		// equal, unlike the server's own EXISTS-based thread match ("NULL
		// never equals NULL" -- see MessageMapper::findIdsByQuery()'s own
		// comment), which only ever matches a thread-less message against
		// itself. The old findIndex()-based implementation had this exact
		// same bug, just less visibly -- a second, unrelated, never-
		// threaded message landing in the same batch would silently
		// overwrite the first one's list entry instead of getting its own.
		it('does NOT collapse two different thread-less messages into one entry', () => {
			store.envelopes[1] = { databaseId: 1, threadRootId: null }
			store.envelopes[2] = { databaseId: 2, threadRootId: null }
			const w = working([1])

			store.appendOrReplaceEnvelopeId(w, { databaseId: 2, threadRootId: null })

			expect(w.ids).toEqual([1, 2])
		})

		it('end to end via addEnvelopesMutation: three thread-less messages in one batch all survive', () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
			store.mailboxes[11].envelopeLists[''] = []
			store.preferences['sort-order'] = 'newest'

			const threadless = (id) => ({ databaseId: id, mailboxId: 11, dateInt: id, flags: { seen: false } })
			store.addEnvelopesMutation({ query: '', envelopes: [threadless(1), threadless(2), threadless(3)] })

			expect(store.mailboxes[11].envelopeLists['']).toEqual([3, 2, 1])
		})
	})

	describe('stripMalformedUndefinedToken: fetchEnvelopes/syncEnvelopes never send a literal "undefined" token', () => {
		// Regression: a query string containing the literal word
		// "undefined" (an undefined value stringified into a compound
		// query somewhere upstream -- appendToSearch()'s own comment in
		// MailboxThread.vue documents one already-fixed instance of
		// exactly this class of bug) is not just wrong, it's
		// catastrophically expensive: the backend's filter parser treats
		// an unrecognized token as a free-text search term, firing the
		// heaviest query the app has. Confirmed live: an 87s/502 and
		// repeated 20s/504 timeouts, specifically hammering every
		// Sent-role mailbox during an active search, once the
		// priority-inbox refresh started actually running on every tick
		// (see maybeStartPriorityInboxRefresh()) instead of rarely at
		// all -- a once-created envelopeLists key is never pruned, so a
		// malformed one keeps getting re-synced forever otherwise.
		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'Sent', name: 'Sent', databaseId: 33, accountId: 13, specialRole: 'sent' },
			})
		})

		it('fetchEnvelopes strips a trailing "undefined" token before calling the service', async () => {
			MessageService.fetchEnvelopes.mockResolvedValue([])

			await store.fetchEnvelopes({ mailboxId: 33, query: 'not:starred undefined' })

			expect(MessageService.fetchEnvelopes).toHaveBeenCalledTimes(1)
			const calledQuery = MessageService.fetchEnvelopes.mock.calls[0][2]
			expect(calledQuery).toBe('not:starred')
		})

		it('syncEnvelopes strips a trailing "undefined" token before calling the service', async () => {
			MessageService.syncEnvelopes.mockResolvedValue({
				newMessages: [],
				changedMessages: [],
				vanishedMessages: [],
				stats: { unread: 0 },
			})

			await store.syncEnvelopes({ mailboxId: 33, query: 'to:ramantas from:ramantas subject:ramantas mentions:false match:anyof undefined' })

			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(1)
			const calledQuery = MessageService.syncEnvelopes.mock.calls[0][4]
			expect(calledQuery).toBe('to:ramantas from:ramantas subject:ramantas mentions:false match:anyof')
		})

		it('leaves a well-formed query completely untouched', async () => {
			MessageService.fetchEnvelopes.mockResolvedValue([])

			await store.fetchEnvelopes({ mailboxId: 33, query: 'not:starred is:pi-important' })

			const calledQuery = MessageService.fetchEnvelopes.mock.calls[0][2]
			expect(calledQuery).toBe('not:starred is:pi-important')
		})

		it('leaves an actually-undefined query (no filter at all) untouched', async () => {
			MessageService.fetchEnvelopes.mockResolvedValue([])

			await store.fetchEnvelopes({ mailboxId: 33 })

			const calledQuery = MessageService.fetchEnvelopes.mock.calls[0][2]
			expect(calledQuery).toBeUndefined()
		})
	})

	describe('reclassifyFlagBucketsMutation (wave 1b: bucket coalescing)', () => {
		// is:starred/not:starred and is:pi-important/is:pi-other are pure
		// predicates over flags.flagged/flags.important -- coalescing their
		// separate syncs into the mailbox's unfiltered '' sync (see
		// syncOneWatchedMailbox below) only works if a flag CHANGE on an
		// already-known message actually moves it between the two loaded
		// buckets. addEnvelopesMutation's cross-post only ever inserts;
		// this is what makes updateEnvelopeMutation (the CHANGED-message
		// path) do the same job for existing messages.
		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
			store.preferences['sort-order'] = 'newest'
		})

		function seedKnownEnvelope(id, flagged, extra = {}) {
			store.envelopes[id] = { databaseId: id, mailboxId: 11, dateInt: id, flags: { flagged }, ...extra }
		}

		it('a star being added adds the message to is:starred AND evicts it from not:starred (partition semantics: one starred member excludes the thread)', () => {
			// threadRootId set: this envelope stands for a real (possibly
			// multi-message) thread whose other members aren't loaded here.
			// A message with NO threadRootId at all is covered by its own,
			// separate test below.
			seedKnownEnvelope(70, false, { threadRootId: 'thread-70' })
			store.mailboxes[11].envelopeLists['is:starred'] = []
			store.mailboxes[11].envelopeLists['not:starred'] = [70]

			store.updateEnvelopeMutation({ envelope: { databaseId: 70, mailboxId: 11, threadRootId: 'thread-70', flags: { flagged: true } } })

			// Safe to add: this envelope alone proves the thread now has a
			// starred message.
			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([70])
			// ALSO evicted from not:starred: under partition semantics
			// (not:starred = the server's thread-excluded NOT EXISTS, see
			// SearchQuery::getThreadExcludedFlags()) one starred member
			// disproves the whole thread's membership definitively -- the
			// server's own next sync of that bucket would vanish it anyway;
			// removing it locally is a proof, not a guess.
			expect(store.mailboxes[11].envelopeLists['not:starred']).toEqual([])
		})

		// Default layout-message-view is 'threaded' (see getPreference's own
		// default), where this envelope only ever stands in for its whole
		// thread's newest message (same as MessageMapper::findIdsByQuery()'s
		// own EXISTS-based thread match server-side). Reported live: a
		// thread's newest reply losing its star kept evicting the whole
		// thread from Favorites on every routine resync, even though an
		// OLDER message in that same thread was still starred -- flickering
		// out and back in every tick as Favorites' own dedicated,
		// thread-aware sync re-added what this generic reclassification had
		// just removed. Fixed: a single envelope's own flags can prove
		// inclusion (safe to ADD -- see not:starred below) but can never
		// prove exclusion of an already-listed thread (unsafe to REMOVE),
		// since some other message in the same thread might still qualify.
		it('a star being removed does not immediately evict an already-listed thread from is:starred (a differently-starred sibling might still justify it)', () => {
			seedKnownEnvelope(71, true, { threadRootId: 'thread-71' })
			store.mailboxes[11].envelopeLists['is:starred'] = [71]
			store.mailboxes[11].envelopeLists['not:starred'] = []

			store.updateEnvelopeMutation({ envelope: { databaseId: 71, mailboxId: 11, threadRootId: 'thread-71', flags: { flagged: false } } })

			// Not evicted -- only is:starred's own thread-aware server sync
			// may safely remove it now.
			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([71])
			// Safe to add to not:starred though: this envelope alone proves
			// the thread now has an unstarred message, sufficient on its own.
			expect(store.mailboxes[11].envelopeLists['not:starred']).toEqual([71])
		})

		it('in singleton (flat, non-threaded) view, a star being removed DOES immediately move the message to not:starred', () => {
			// In flat view one row IS one message -- no thread-sibling
			// ambiguity, so the straightforward removal remains correct.
			store.preferences['layout-message-view'] = 'singleton'
			seedKnownEnvelope(71, true)
			store.mailboxes[11].envelopeLists['is:starred'] = [71]
			store.mailboxes[11].envelopeLists['not:starred'] = []

			store.updateEnvelopeMutation({ envelope: { databaseId: 71, mailboxId: 11, flags: { flagged: false } } })

			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([])
			expect(store.mailboxes[11].envelopeLists['not:starred']).toEqual([71])
		})

		// Closest reproduction of the actual live incident: the thread's
		// newest message (mirroring real message id 998453) is unstarred,
		// but Favorites already correctly lists the thread (its own
		// dedicated, thread-aware sync found an older starred sibling). A
		// routine, unrelated '' bucket sync then reprocesses this same
		// envelope -- unchanged, still unstarred -- and must not silently
		// evict the thread.
		it('a routine unfiltered sync of a thread whose newest message is unstarred does not evict it from an already-correct is:starred list, even reprocessed repeatedly', () => {
			store.mailboxes[11].envelopeLists['is:starred'] = [998453]
			const envelope = { databaseId: 998453, mailboxId: 11, dateInt: 998453, threadRootId: 'thread-998453', flags: { seen: true, flagged: false, important: false } }

			// First sync: 998453 is brand-new to this client, so it's always
			// reclassified regardless of the efficiency guard below.
			store.addEnvelopesMutation({ query: '', envelopes: [envelope] })
			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([998453])

			// A second, later tick reprocessing the exact same, unchanged
			// envelope -- the actual reported shape of the live incident
			// ("every tick"). Must still not evict it.
			store.addEnvelopesMutation({ query: '', envelopes: [{ ...envelope, flags: { ...envelope.flags } }] })
			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([998453])
		})

		// A message with no threadRootId at all was never grouped with
		// anything server-side either (findIdsByQuery()'s own EXISTS
		// clause: "tm.thread_root_id = m.thread_root_id" can never be true
		// when both sides are NULL, so it only ever matches itself there
		// too) -- there is no thread-sibling ambiguity to be conservative
		// about, so its own flags are the complete, authoritative answer
		// in BOTH directions, unlike a genuinely-threaded message.
		it('a standalone message with no thread grouping at all is fully authoritative on its own, including for removal', () => {
			seedKnownEnvelope(75, true) // no threadRootId
			store.mailboxes[11].envelopeLists['is:starred'] = [75]
			store.mailboxes[11].envelopeLists['not:starred'] = []

			store.updateEnvelopeMutation({ envelope: { databaseId: 75, mailboxId: 11, flags: { flagged: false } } })

			// Unlike the threaded-ambiguity case above: genuinely evicted.
			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([])
			expect(store.mailboxes[11].envelopeLists['not:starred']).toEqual([75])
		})

		// When the thread's FULL member list happens to already be loaded
		// locally (envelope.thread, populated by actually opening the
		// thread via fetchThread()) with every member still known, the
		// true membership can be computed directly and correctly, in
		// either direction, for free -- no need to fall back to the
		// conservative ratchet at all.
		it('a fully-loaded thread with no starred member left is safely evicted immediately (full local knowledge, not the ratchet)', () => {
			seedKnownEnvelope(96, false, { threadRootId: 'thread-96' }) // older sibling, also unstarred
			seedKnownEnvelope(97, true, { threadRootId: 'thread-96' }) // representative, currently starred
			store.mailboxes[11].envelopeLists['is:starred'] = [97]
			store.mailboxes[11].envelopeLists['not:starred'] = []

			store.updateEnvelopeMutation({
				envelope: { databaseId: 97, mailboxId: 11, threadRootId: 'thread-96', thread: [96, 97], flags: { flagged: false } },
			})

			// Genuinely evicted: the full thread is known, and neither
			// member matches is:starred any more.
			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([])
			expect(store.mailboxes[11].envelopeLists['not:starred']).toEqual([97])
		})

		it('a fully-loaded thread whose older sibling is still starred stays listed even though the representative no longer is', () => {
			seedKnownEnvelope(98, true, { threadRootId: 'thread-98' }) // older sibling, still starred
			seedKnownEnvelope(99, true, { threadRootId: 'thread-98' }) // representative, about to be unstarred
			store.mailboxes[11].envelopeLists['is:starred'] = [99]
			store.mailboxes[11].envelopeLists['not:starred'] = []

			store.updateEnvelopeMutation({
				envelope: { databaseId: 99, mailboxId: 11, threadRootId: 'thread-98', thread: [98, 99], flags: { flagged: false } },
			})

			// Stays listed, with FULL certainty (not just the ratchet's
			// "don't know, so don't touch it"): the older sibling (98) is
			// known and still starred, so the thread genuinely still
			// qualifies for is:starred.
			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([99])
			// And correctly NOT added to not:starred: partition semantics --
			// the still-starred sibling (98) excludes the whole thread from
			// the complement bucket. The thread lives in Favorites, and only
			// in Favorites, exactly like the server's NOT EXISTS would
			// resolve it.
			expect(store.mailboxes[11].envelopeLists['not:starred']).toEqual([])
		})

		// The exact reported-live shape: a new, unimportant reply arrives in
		// a thread whose important member is already loaded (it is what put
		// the thread in the Important section) -- the reply must NOT drag
		// the thread into Other as well. Partition semantics resolve this
		// locally: the known important sibling excludes the thread from
		// every is:pi-other bucket.
		it('a new unimportant reply to a thread with a known important member is NOT cross-posted into Other', () => {
			// accountId must match what addEnvelopesMutation stamps on the
			// incoming reply (mailbox 11 -> account 13): the sibling lookup
			// (getEnvelopesByThreadRootId) filters by accountId+threadRootId.
			seedKnownEnvelope(200, false, { threadRootId: 'thread-200', accountId: 13, flags: { flagged: false, important: true } })
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = []
			store.mailboxes[11].envelopeLists['not:starred is:pi-important'] = [200]

			store.addEnvelopesMutation({
				query: '',
				envelopes: [{ databaseId: 201, mailboxId: 11, dateInt: 201, threadRootId: 'thread-200', flags: { seen: false, flagged: false, important: false } }],
			})

			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).toEqual([])
		})

		// The freshness dual: a brand-new thread with no important member
		// (and no known siblings at all) must still land in Other
		// immediately -- known local members are the evidence, and here the
		// new message IS the whole known thread.
		it('a new unimportant message in a brand-new thread still lands in Other immediately', () => {
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = []

			store.addEnvelopesMutation({
				query: '',
				envelopes: [{ databaseId: 202, mailboxId: 11, dateInt: 202, threadRootId: 'thread-202', flags: { seen: false, flagged: false, important: false } }],
			})

			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).toEqual([202])
		})

		// Profile-guided (three public Firefox profiles, 2026-07-17): the
		// unconditional fresh-array Vue.set at the end of reclassify
		// re-triggered a full list re-render for every eligible bucket on
		// every reclassified envelope even when membership was completely
		// unchanged -- 8.9% of main-thread samples across a 48-second
		// unresponsive spell, feeding the selector-matching restyle storms
		// that dominated the rest. A no-op must leave the array UNTOUCHED
		// (same reference), so nothing downstream re-renders.
		it('a reclassification that changes nothing leaves the list array untouched (same reference, no re-render trigger)', () => {
			seedKnownEnvelope(80, true, { threadRootId: 'thread-80' })
			const starredList = [80]
			store.mailboxes[11].envelopeLists['is:starred'] = starredList

			store.reclassifyFlagBucketsMutation({ envelope: store.envelopes[80], sourceMailbox: store.mailboxes[11] })

			expect(store.mailboxes[11].envelopeLists['is:starred']).toBe(starredList)
		})

		it('still rewrites the list when stale ids (unknown envelopes) need dropping, even without a membership change', () => {
			seedKnownEnvelope(81, true, { threadRootId: 'thread-81' })
			// 999999 is not in store.envelopes -- a leftover pointing nowhere.
			store.mailboxes[11].envelopeLists['is:starred'] = [81, 999999]

			store.reclassifyFlagBucketsMutation({ envelope: store.envelopes[81], sourceMailbox: store.mailboxes[11] })

			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([81])
		})

		it('does not touch a flag-predicate bucket that is not loaded', () => {
			seedKnownEnvelope(72, false)
			// Neither is:starred nor not:starred loaded for this mailbox.

			store.updateEnvelopeMutation({ envelope: { databaseId: 72, mailboxId: 11, flags: { flagged: true } } })

			expect(store.mailboxes[11].envelopeLists['is:starred']).toBeUndefined()
			expect(store.mailboxes[11].envelopeLists['not:starred']).toBeUndefined()
		})

		it('a no-op flag update (nothing actually changed) does not touch bucket membership', () => {
			seedKnownEnvelope(73, true)
			store.mailboxes[11].envelopeLists['is:starred'] = [73]
			store.mailboxes[11].envelopeLists['not:starred'] = []

			// Same flags as already stored -- isEqual short-circuits before
			// updateEnvelopeMutation ever calls the reclassification at all.
			store.updateEnvelopeMutation({ envelope: { databaseId: 73, mailboxId: 11, flags: { flagged: true } } })

			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([73])
			expect(store.mailboxes[11].envelopeLists['not:starred']).toEqual([])
		})

		it('does not contradict the bucket that was just authoritatively set by the same call (excludeListId)', () => {
			// A direct is:pi-important fetch/sync response is itself the
			// authoritative answer for THAT bucket -- reclassifying it
			// from envelope.flags.important would be redundant at best
			// and, for a caller whose envelope data doesn't perfectly
			// mirror the server's own filter decision, actively wrong.
			// Regression: this exact interaction previously flipped a
			// message OUT of the section list the surrounding code had
			// just put it into, moments earlier, in the same call.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important'] = []
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-other'] = []

			store.addEnvelopesMutation({
				query: 'is:pi-important',
				envelopes: [{ databaseId: 74, mailboxId: 11, dateInt: 74, flags: { seen: false, important: true } }],
			})

			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important']).toEqual([74])
			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-other']).toEqual([])
		})

		// Reported live: priority inbox showed 3 unread instead of 3+5 --
		// the missing 5 belonged to an account with "sort favorites
		// separately" enabled, which makes MailboxThread.vue load COMPOUND
		// list keys ("not:starred is:pi-other") instead of the bare form
		// (see its appendToSearch()/created()). New mail landed correctly
		// in the bare "is:pi-other" list, but nothing was watching that
		// list -- the priority inbox was displaying the compound-keyed
		// one, which only got refreshed by a full page reload re-fetching
		// under that exact compound key.
		it('a new not-important message is added to a loaded COMPOUND "not:starred is:pi-other" bucket', () => {
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = []

			store.addEnvelopesMutation({
				query: '',
				envelopes: [{ databaseId: 90, mailboxId: 11, dateInt: 90, flags: { seen: false, flagged: false, important: false } }],
			})

			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).toEqual([90])
		})

		it('a new important, unstarred message is added to a loaded COMPOUND "not:starred is:pi-important" bucket', () => {
			store.mailboxes[11].envelopeLists['not:starred is:pi-important'] = []

			store.addEnvelopesMutation({
				query: '',
				envelopes: [{ databaseId: 91, mailboxId: 11, dateInt: 91, flags: { seen: false, flagged: false, important: true } }],
			})

			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-important']).toEqual([91])
		})

		it('a new STARRED, not-important message is NOT added to "not:starred is:pi-other" (conjunction, not just the last token)', () => {
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = []

			store.addEnvelopesMutation({
				query: '',
				envelopes: [{ databaseId: 92, mailboxId: 11, dateInt: 92, flags: { seen: false, flagged: true, important: false } }],
			})

			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).toEqual([])
		})

		it('a compound bucket that mixes in a token this store cannot evaluate locally (subject:) is left untouched', () => {
			store.mailboxes[11].envelopeLists['subject:foo is:pi-other'] = [999]

			store.addEnvelopesMutation({
				query: '',
				envelopes: [{ databaseId: 93, mailboxId: 11, dateInt: 93, flags: { seen: false, flagged: false, important: false } }],
			})

			expect(store.mailboxes[11].envelopeLists['subject:foo is:pi-other']).toEqual([999])
		})

		it('a flag flip ADDS a message to the newly-matching compound bucket and leaves the complement bucket in the same instant', () => {
			seedKnownEnvelope(94, false, { threadRootId: 'thread-94' })
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = [94]
			store.mailboxes[11].envelopeLists['not:starred is:pi-important'] = []
			store.envelopes[94].flags.important = false

			store.updateEnvelopeMutation({ envelope: { databaseId: 94, mailboxId: 11, threadRootId: 'thread-94', flags: { flagged: false, important: true } } })

			// AND leaves the Other bucket in the same instant: is:pi-other
			// is a partition token (the server's thread-excluded NOT
			// EXISTS), so this envelope becoming important disproves the
			// thread's membership there definitively -- the exact
			// reported-live bug this fixed (the same conversation listed
			// in both Important and Other at once).
			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).toEqual([])
			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-important']).toEqual([94])
		})

		// addEnvelopesMutation() used to call reclassifyFlagBucketsMutation()
		// unconditionally, for every envelope, on every sync -- including
		// the (extremely common) case of a routine resync reporting a
		// message this client already knows about, completely unchanged
		// (SyncService.php still reports every known message as "changed"
		// on every sync). Skipping reclassification entirely when nothing
		// about the envelope's flags actually changed cuts real, repeated
		// work at its root, the same way updateEnvelopeMutation()'s own
		// isEqual guard already does for its own call path.
		it('addEnvelopesMutation skips reclassification for an already-known envelope whose flags are unchanged', () => {
			seedKnownEnvelope(100, false, { threadRootId: 'thread-100' })
			const reclassifySpy = vi.spyOn(store, 'reclassifyFlagBucketsMutation')

			store.addEnvelopesMutation({
				query: '',
				envelopes: [{ databaseId: 100, mailboxId: 11, dateInt: 100, threadRootId: 'thread-100', flags: { flagged: false } }],
			})

			expect(reclassifySpy).not.toHaveBeenCalled()
		})

		it('addEnvelopesMutation still reclassifies a brand-new envelope, never seen before', () => {
			const reclassifySpy = vi.spyOn(store, 'reclassifyFlagBucketsMutation')

			store.addEnvelopesMutation({
				query: '',
				envelopes: [{ databaseId: 101, mailboxId: 11, dateInt: 101, flags: { flagged: true } }],
			})

			expect(reclassifySpy).toHaveBeenCalledTimes(1)
		})

		it('addEnvelopesMutation still reclassifies an already-known envelope whose flags genuinely changed', () => {
			seedKnownEnvelope(102, false, { threadRootId: 'thread-102' })
			const reclassifySpy = vi.spyOn(store, 'reclassifyFlagBucketsMutation')

			store.addEnvelopesMutation({
				query: '',
				envelopes: [{ databaseId: 102, mailboxId: 11, dateInt: 102, threadRootId: 'thread-102', flags: { flagged: true } }],
			})

			expect(reclassifySpy).toHaveBeenCalledTimes(1)
		})
	})

	describe('refreshFlagPredicateBucketsForEnvelope: fast confirmation after an explicit user toggle', () => {
		// flagEnvelopeMutation() (the optimistic update both
		// toggleEnvelopeFlagged() and setEnvelopeImportant() use) never
		// touches envelopeLists at all, and the generic reclassification
		// pass is deliberately conservative about removals in threaded
		// view -- so a toggle that should genuinely evict a thread from an
		// already-loaded bucket would otherwise sit wrong until that
		// bucket's own next periodic sync. This targeted, immediate
		// per-bucket resync closes that gap for the one case where it's
		// affordable: a real, comparatively rare user click, never routine
		// background polling.
		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
			MessageService.syncEnvelopes.mockResolvedValue({
				newMessages: [],
				changedMessages: [],
				vanishedMessages: [],
				stats: { unread: 0 },
			})
		})

		it('resyncs only the loaded flag-predicate buckets (bare and compound) for the envelope\'s own mailbox', async () => {
			store.mailboxes[11].envelopeLists['is:starred'] = []
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = []
			store.mailboxes[11].envelopeLists['subject:foo'] = [] // must be left alone

			await store.refreshFlagPredicateBucketsForEnvelope({ databaseId: 1, mailboxId: 11 })

			const calledQueries = MessageService.syncEnvelopes.mock.calls
				.filter((call) => call[1] === 11)
				.map((call) => call[4])
				.sort()
			expect(calledQueries).toEqual(['is:starred', 'not:starred is:pi-other'])
		})

		it('also resyncs the unified inbox\'s own loaded flag-predicate buckets', async () => {
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:pi-important'] = []

			await store.refreshFlagPredicateBucketsForEnvelope({ databaseId: 1, mailboxId: 11 })

			// syncEnvelopes() itself fans a unified mailbox's sync out to its
			// real constituent mailboxes -- it never calls the service
			// function with the virtual id directly (see the dedicated
			// "not the virtual id" test elsewhere in this file). Mailbox 11
			// is the only real inbox-role mailbox registered here, so the
			// unified list's own refresh should reach it with the same
			// query.
			const calledForUnified = MessageService.syncEnvelopes.mock.calls
				.some((call) => call[1] === 11 && call[4] === 'is:pi-important')
			expect(calledForUnified).toBe(true)
		})

		it('does nothing for an envelope whose mailbox is unknown', async () => {
			await store.refreshFlagPredicateBucketsForEnvelope({ databaseId: 1, mailboxId: 'does-not-exist' })

			expect(MessageService.syncEnvelopes).not.toHaveBeenCalled()
		})

		it('toggleEnvelopeFlagged triggers a refresh after a successful toggle', async () => {
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			store.mailboxes[11].envelopeLists['is:starred'] = []
			// Registered via addEnvelopesMutation, not a bare object literal --
			// same reasoning as the setEnvelopeImportant test below: now that
			// toggleEnvelopeFlagged() reclassifies synchronously too, an
			// unregistered envelope would put an id into envelopeLists that
			// this.envelopes doesn't know, a state no production path reaches.
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 1, mailboxId: 11, dateInt: 1, flags: { flagged: false }, tags: [] }],
				addToUnifiedMailboxes: false,
			})
			const envelope = store.envelopes[1]

			await store.toggleEnvelopeFlagged(envelope)

			expect(MessageService.syncEnvelopes.mock.calls.some((call) => call[1] === 11 && call[4] === 'is:starred')).toBe(true)
		})

		it('toggleEnvelopeFlagged does NOT trigger a refresh when the toggle itself fails', async () => {
			MessageService.setEnvelopeFlags.mockRejectedValue(new Error('network error'))
			store.mailboxes[11].envelopeLists['is:starred'] = []
			const envelope = { databaseId: 1, mailboxId: 11, flags: { flagged: false } }

			await expect(store.toggleEnvelopeFlagged(envelope)).rejects.toThrow('network error')

			expect(MessageService.syncEnvelopes).not.toHaveBeenCalled()
		})

		// Phase 4 of the unified optimistic-update plan (see
		// /home/ktogias/.claude/plans/generic-hugging-fern.md): a thrown
		// network error doesn't always mean the change never landed --
		// a client-side timeout can fire an error for a request that
		// actually completed server-side. Confirmed here against
		// toggleEnvelopeFlagged() specifically; the same
		// reconcileOrRevert() helper is wired the same way into
		// toggleEnvelopeSeen()/toggleEnvelopeJunk()/setEnvelopeImportant()/
		// moveThread().
		it('does not revert or rethrow if reconciliation confirms the flag actually landed despite the error', async () => {
			MessageService.setEnvelopeFlags.mockRejectedValue(new Error('timed out'))
			MessageService.fetchEnvelope.mockResolvedValue({ flags: { flagged: true } })
			const envelope = { databaseId: 1, mailboxId: 11, accountId: 13, flags: { flagged: false } }

			await store.toggleEnvelopeFlagged(envelope)

			expect(envelope.flags.flagged).toBe(true)
		})

		it('still reverts and rethrows if reconciliation confirms the flag genuinely never landed', async () => {
			MessageService.setEnvelopeFlags.mockRejectedValue(new Error('network error'))
			MessageService.fetchEnvelope.mockResolvedValue({ flags: { flagged: false } })
			const envelope = { databaseId: 1, mailboxId: 11, accountId: 13, flags: { flagged: false } }

			await expect(store.toggleEnvelopeFlagged(envelope)).rejects.toThrow('network error')

			expect(envelope.flags.flagged).toBe(false)
		})

		it('setEnvelopeImportant triggers a refresh after a successful toggle', async () => {
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			MessageService.setEnvelopeTag.mockResolvedValue({ id: 909, imapLabel: '$label1' })
			store.mailboxes[11].envelopeLists['is:pi-important'] = []
			// Registered via addEnvelopesMutation, not a bare object literal --
			// a real envelope is always known to the store by the time a user
			// can toggle its importance; a not-actually-registered one would
			// make the now-synchronous reclassifyFlagBucketsMutation() add an
			// id to envelopeLists that this.envelopes itself doesn't know
			// about, an unrealistic state no production code path can reach.
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 1, mailboxId: 11, dateInt: 1, flags: { important: false }, tags: [] }],
				addToUnifiedMailboxes: false,
			})
			const envelope = store.envelopes[1]

			await store.setEnvelopeImportant(envelope, true)

			expect(MessageService.syncEnvelopes.mock.calls.some((call) => call[1] === 11 && call[4] === 'is:pi-important')).toBe(true)
		})
	})

	describe('user flag toggles move Priority Inbox list membership instantly, in BOTH directions', () => {
		// Reported live: starring (or un-marking important) a message from
		// the "Other" section or from an open message updated the badge
		// instantly but the Favorites/Important section lists only caught
		// up seconds later, once the fire-and-forget bucket resync's
		// network round trips landed. Two gaps: toggleEnvelopeFlagged()
		// had no synchronous reclassify at all (setEnvelopeImportant()
		// already did), and threadStillMatchesFlagPredicate()'s
		// deliberately-conservative removal ratchet -- correct for
		// sync-driven readings -- also blocked the REMOVE half of the
		// user's own explicit toggle. Both toggles now reclassify
		// synchronously with `userInitiated: true`, which trusts the
		// toggle direction for removals immediately; the routine
		// sync-driven path keeps the ratchet unchanged (see the wave-1b
		// describe above, whose eviction tests still pass untouched).
		const importantTag = { id: 909, imapLabel: '$label1', displayName: 'Important', color: '#FF7A66' }

		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
			store.preferences['sort-order'] = 'newest'
		})

		function seedListedEnvelope(id, flags, tagIds = []) {
			const envelope = { databaseId: id, mailboxId: 11, dateInt: id, threadRootId: `thread-${id}`, flags, tags: tagIds }
			store.envelopes[id] = envelope
			return envelope
		}

		it('starring from a compound Other bucket adds to is:starred AND leaves the not:starred list synchronously, before any network call resolves', async () => {
			const envelope = seedListedEnvelope(42, { flagged: false, important: false })
			store.mailboxes[11].envelopeLists['is:starred'] = []
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = [42]
			// Never-resolving: if membership depended on the request
			// settling, these assertions would run too early to pass.
			MessageService.setEnvelopeFlags.mockReturnValue(new Promise(() => {}))

			store.toggleEnvelopeFlagged(envelope)
			await Promise.resolve()

			expect(store.mailboxes[11].envelopeLists['is:starred']).toContain(42)
			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).not.toContain(42)
		})

		it('unstarring removes from is:starred synchronously, even when the thread\'s other members are not locally known', async () => {
			// threadRootId is set and no envelope.thread member list is
			// cached -- the exact case where a SYNC-driven reading must
			// ratchet (leave it listed) but the user's own toggle must not.
			const envelope = seedListedEnvelope(43, { flagged: true, important: false })
			store.mailboxes[11].envelopeLists['is:starred'] = [43]
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = []
			MessageService.setEnvelopeFlags.mockReturnValue(new Promise(() => {}))

			store.toggleEnvelopeFlagged(envelope)
			await Promise.resolve()

			expect(store.mailboxes[11].envelopeLists['is:starred']).not.toContain(43)
			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).toContain(43)
		})

		it('restores list membership when the toggle fails and reconciliation confirms it never landed', async () => {
			const envelope = seedListedEnvelope(44, { flagged: false, important: false }, [])
			envelope.accountId = 13
			store.mailboxes[11].envelopeLists['is:starred'] = []
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = [44]
			MessageService.setEnvelopeFlags.mockRejectedValue(new Error('network error'))
			MessageService.fetchEnvelope.mockResolvedValue({ flags: { flagged: false } })

			await expect(store.toggleEnvelopeFlagged(envelope)).rejects.toThrow('network error')

			expect(store.mailboxes[11].envelopeLists['is:starred']).not.toContain(44)
			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).toContain(44)
		})

		it('unmarking important removes from is:pi-important synchronously, before any network call resolves', async () => {
			store.tags[importantTag.id] = importantTag
			const envelope = seedListedEnvelope(45, { flagged: false, important: true }, [importantTag.id])
			store.mailboxes[11].envelopeLists['not:starred is:pi-important'] = [45]
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = []
			MessageService.setEnvelopeFlags.mockReturnValue(new Promise(() => {}))
			MessageService.removeEnvelopeTag.mockReturnValue(new Promise(() => {}))

			store.setEnvelopeImportant(envelope, false)
			await Promise.resolve()

			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-important']).not.toContain(45)
			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).toContain(45)
		})

		it('unmarking important propagates the flip to a stale same-Message-ID folder copy, so the thread leaves is:pi-important at once', async () => {
			// Gmail: the INBOX copy and the [Gmail]/Important copy share one
			// Message-ID as two envelopes with independent flags. Unmarking
			// the INBOX copy must also flip the still-important Important-
			// folder copy locally, otherwise the thread-wide is:pi-important
			// match keeps the row in the Important section (with the outline
			// "conversation has an important message" badge) until that
			// folder's own sync, tens of seconds later.
			store.tags[importantTag.id] = importantTag
			store.mailboxes[12] = { id: '[Gmail]/Important', name: '[Gmail]/Important', databaseId: 12, accountId: 13, envelopeLists: {} }
			const inboxCopy = { databaseId: 51, accountId: 13, mailboxId: 11, dateInt: 51, messageId: 'shared-mid', threadRootId: 'thr-shared', thread: [51, 52], flags: { flagged: false, important: true }, tags: [importantTag.id] }
			const importantFolderCopy = { databaseId: 52, accountId: 13, mailboxId: 12, dateInt: 51, messageId: 'shared-mid', threadRootId: 'thr-shared', thread: [51, 52], flags: { flagged: false, important: true }, tags: [importantTag.id] }
			store.envelopes[51] = inboxCopy
			store.envelopes[52] = importantFolderCopy
			store.mailboxes[11].envelopeLists['not:starred is:pi-important'] = [51]
			store.mailboxes[11].envelopeLists['not:starred is:pi-other'] = []
			MessageService.setEnvelopeFlags.mockReturnValue(new Promise(() => {}))
			MessageService.removeEnvelopeTag.mockReturnValue(new Promise(() => {}))

			store.setEnvelopeImportant(inboxCopy, false)
			await Promise.resolve()

			// The stale sibling was flipped locally...
			expect(store.envelopes[52].flags.important).toBe(false)
			// ...so the thread-wide predicate no longer keeps the row listed.
			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-important']).not.toContain(51)
			expect(store.mailboxes[11].envelopeLists['not:starred is:pi-other']).toContain(51)
		})

		it('a sync-driven reading of the same partial-knowledge shape still ratchets (no regression of the Favorites-flicker fix)', () => {
			seedListedEnvelope(46, { flagged: true, important: false })
			store.mailboxes[11].envelopeLists['is:starred'] = [46]

			// Same envelope, flag now off, arriving via the routine sync
			// path (updateEnvelopeMutation) -- NOT a user toggle.
			store.updateEnvelopeMutation({ envelope: { databaseId: 46, mailboxId: 11, threadRootId: 'thread-46', flags: { flagged: false, important: false } } })

			expect(store.mailboxes[11].envelopeLists['is:starred']).toContain(46)
		})
	})

	describe('removeEnvelopeMutation distinguishes a real deletion from a filtered bucket no longer matching', () => {
		// "Vanished" from a filtered bucket's sync (is:starred, a saved
		// search, ...) means "no longer matches THIS bucket's predicate"
		// -- e.g. a message merely losing its star -- not "this message
		// is gone". Only the UNFILTERED '' query's own vanish means a
		// genuine deletion/expunge (its knownIds have no flag/text
		// restriction to fall out of). Found while building wave 1b;
		// not observed live, not yet hit in practice.
		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
		})

		function seedKnownEnvelope(id, extra = {}) {
			store.envelopes[id] = { databaseId: id, mailboxId: 11, dateInt: id, seen: true, flags: { flagged: true }, ...extra }
		}

		it('a vanish from a FILTERED bucket (e.g. is:starred, star removed) only leaves that one list', () => {
			seedKnownEnvelope(80)
			store.mailboxes[11].envelopeLists['is:starred'] = [80]
			store.mailboxes[11].envelopeLists[''] = [80]

			store.removeEnvelopeMutation({ id: 80, query: 'is:starred' })

			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([])
			// Still present everywhere else -- the message never left the
			// mailbox, it just stopped matching is:starred specifically.
			expect(store.mailboxes[11].envelopeLists['']).toEqual([80])
			expect(store.envelopes[80]).toBeDefined()
		})

		it('a vanish from the UNFILTERED \'\' bucket is a real removal: every list, and the envelope itself, are gone', () => {
			seedKnownEnvelope(81)
			store.mailboxes[11].envelopeLists['is:starred'] = [81]
			store.mailboxes[11].envelopeLists[''] = [81]

			store.removeEnvelopeMutation({ id: 81, query: undefined })

			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([])
			expect(store.mailboxes[11].envelopeLists['']).toEqual([])
			expect(store.envelopes[81]).toBeUndefined()
		})

		it('a filtered-bucket vanish does not touch the mailbox unread counter', () => {
			seedKnownEnvelope(82, { seen: false })
			store.mailboxes[11].unread = 5
			store.mailboxes[11].envelopeLists['is:starred'] = [82]

			store.removeEnvelopeMutation({ id: 82, query: 'is:starred' })

			expect(store.mailboxes[11].unread).toBe(5)
		})

		it('an unfiltered-bucket vanish still decrements the unread counter for an unseen message', () => {
			seedKnownEnvelope(83, { seen: false })
			store.mailboxes[11].unread = 5
			store.mailboxes[11].envelopeLists[''] = [83]

			store.removeEnvelopeMutation({ id: 83, query: undefined })

			expect(store.mailboxes[11].unread).toBe(4)
		})

		it('explicit user actions (delete/move/snooze, no query passed) remain full removals', () => {
			// deleteMessage/moveMessage/snoozeMessage/etc. never pass a
			// query -- the message genuinely leaves the mailbox for real
			// reasons, so the full-removal behavior must stay the default.
			seedKnownEnvelope(84)
			store.mailboxes[11].envelopeLists['is:starred'] = [84]
			store.mailboxes[11].envelopeLists[''] = [84]

			store.removeEnvelopeMutation({ id: 84 })

			expect(store.mailboxes[11].envelopeLists['is:starred']).toEqual([])
			expect(store.mailboxes[11].envelopeLists['']).toEqual([])
			expect(store.envelopes[84]).toBeUndefined()
		})

		it('a filtered-bucket vanish also removes it from the matching unified-account list', () => {
			seedKnownEnvelope(85)
			store.mailboxes[11].envelopeLists['is:starred'] = [85]
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:starred'] = [85]
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists[''] = [85]

			store.removeEnvelopeMutation({ id: 85, query: 'is:starred' })

			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:starred']).toEqual([])
			expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['']).toEqual([85])
		})
	})

	it('fetches the next individual page', async () => {
		const msgs1 = reverse(range(30, 40))
		const page1 = reverse(range(10, 30))

		const account13 = {
			id: 13,
		}

		store.preferences['sort-order'] = 'newest'
		store.preferences['layout-message-view'] = 'threaded'

		store.addAccountMutation(account13)
		store.addMailboxMutation({
			account: account13,
			mailbox: {
				name: 'INBOX',
				databaseId: 11,
				specialRole: 'inbox',
			},
		})
		store.addMailboxMutation({
			account: account13,
			mailbox: {
				name: 'Drafts',
				databaseId: 12,
				specialRole: 'draft',
			},
		})

		// Add initial envelopes
		store.addEnvelopesMutation({
			envelopes: msgs1.map(mockEnvelope(11)),
			addToUnifiedMailboxes: true,
		})

		// Mock fetching next pages
		MessageService.fetchEnvelopes.mockImplementation(async (accountId, mailboxId) => {
			if (accountId !== 13 || mailboxId !== 11) {
				return []
			}

			return page1.map(mockEnvelope(11))
		})

		await store.fetchNextEnvelopePage({
			mailboxId: UNIFIED_INBOX_ID,
			quantity: PAGE_SIZE,
		})

		expect(MessageService.fetchEnvelopes).toHaveBeenCalledTimes(1)
		expect(MessageService.fetchEnvelopes)
			.toHaveBeenNthCalledWith(1, 13, 11, undefined, 300000, PAGE_SIZE, 'newest', 'threaded')
		expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists[''].toSorted()).toEqual([
			// Initial envelopes
			...msgs1.map(mockEnvelope(11)),

			// Fetched page for mailbox 11
			...page1.map(mockEnvelope(11)),
		].map((e) => e.databaseId).sort())
		expect(store.mailboxes[11].envelopeLists[''].toSorted()).toEqual([
			// Initial envelopes
			...msgs1.map(mockEnvelope(11)),

			// Fetched page for mailbox 11
			...page1.map(mockEnvelope(11)),
		].map((e) => e.databaseId).sort())
	})

	it('builds the next unified page with local data', async () => {
		const msgs1 = reverse(range(20, 70))
		const page1 = reverse(range(50, 60))

		const account13 = {
			id: 13,
		}

		store.preferences['sort-order'] = 'newest'

		store.addAccountMutation(account13)
		store.addMailboxMutation({
			account: account13,
			mailbox: {
				name: 'INBOX',
				databaseId: 11,
				specialRole: 'inbox',
			},
		})
		store.addMailboxMutation({
			account: account13,
			mailbox: {
				name: 'Drafts',
				databaseId: 12,
				specialRole: 'draft',
			},
		})

		// Add initial envelopes
		store.addEnvelopesMutation({
			envelopes: msgs1.map(mockEnvelope(11)),
			addToUnifiedMailboxes: false,
		})

		// Also add some envelopes to the unified mailbox
		store.addEnvelopesMutation({
			envelopes: page1.map(mockEnvelope(11)),
			addToUnifiedMailboxes: true,
		})

		// Mock fetching next pages (not called but makes failures easier to understand)
		MessageService.fetchEnvelopes.mockImplementation(async () => {
			throw new Error('Tried to fetch messages')
		})

		await store.fetchNextEnvelopePage({
			mailboxId: UNIFIED_INBOX_ID,
			quantity: PAGE_SIZE,
		})

		expect(MessageService.fetchEnvelopes).not.toHaveBeenCalled()
		expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists[''].toSorted()).toEqual([
			// Initial envelopes
			...page1.map(mockEnvelope(11)),

			// Envelopes loaded from local state
			...range(30, 50).map(mockEnvelope(11)),
		].map((e) => e.databaseId).sort())
	})

	it('builds the next unified page with partial fetch', async () => {
		const page1 = reverse(range(30, 35))
		const page2 = reverse(range(25, 30))
		const msgs2 = reverse(range(60, 70))

		const account13 = {
			id: 13,
		}
		const account26 = {
			id: 26,
		}

		store.preferences['sort-order'] = 'newest'
		store.preferences['layout-message-view'] = 'threaded'

		store.addAccountMutation(account13)
		store.addAccountMutation(account26)
		store.addMailboxMutation({
			account: account13,
			mailbox: {
				name: 'INBOX',
				databaseId: 11,
				specialRole: 'inbox',
			},
		})
		store.addMailboxMutation({
			account: account13,
			mailbox: {
				name: 'Drafts',
				databaseId: 12,
				specialRole: 'draft',
			},
		})
		store.addMailboxMutation({
			account: account26,
			mailbox: {
				name: 'INBOX',
				databaseId: 21,
				specialRole: 'inbox',
			},
		})
		store.addMailboxMutation({
			account: account26,
			mailbox: {
				name: 'Drafts',
				databaseId: 22,
				specialRole: 'draft',
			},
		})

		// Add initial pages
		store.addEnvelopesMutation({
			envelopes: page1.map(mockEnvelope(11)),
		})
		store.addEnvelopesMutation({
			envelopes: msgs2.map(mockEnvelope(21)),
		})

		// Mock fetching next pages
		MessageService.fetchEnvelopes.mockImplementation(async (
			accountId,
			mailboxId,
			query,
			cursor,
			limit,
			sortOrder,
		) => {
			if (accountId !== 13 || mailboxId !== 11) {
				return []
			}

			expect(sortOrder).toBe('newest')
			return page2.map(mockEnvelope(11)).filter((e) => e.dateInt < cursor).slice(0, limit)
		})

		await store.fetchNextEnvelopePage({
			mailboxId: UNIFIED_INBOX_ID,
			quantity: PAGE_SIZE,
		})

		expect(MessageService.fetchEnvelopes).toHaveBeenCalledTimes(2)
		expect(MessageService.fetchEnvelopes)
			.toHaveBeenNthCalledWith(1, 13, 11, undefined, 300000, PAGE_SIZE, 'newest', 'threaded')
		expect(MessageService.fetchEnvelopes)
			.toHaveBeenNthCalledWith(2, 26, 21, undefined, 600000, PAGE_SIZE, 'newest', 'threaded')
		expect(store.mailboxes[UNIFIED_INBOX_ID].envelopeLists[''].toSorted()).toEqual([
			// Initial envelopes
			...page1.map(mockEnvelope(11)),
			...msgs2.map(mockEnvelope(21)),

			// Fetched page for mailbox 11
			...page2.map(mockEnvelope(11)),
		].map((e) => e.databaseId).sort())
		expect(store.mailboxes[11].envelopeLists[''].toSorted()).toEqual([
			// Initial envelopes
			...page1.map(mockEnvelope(11)),

			// Fetched page for mailbox 11
			...page2.map(mockEnvelope(11)),
		].map((e) => e.databaseId).sort())
		expect(store.mailboxes[21].envelopeLists[''].toSorted())
			.toEqual(msgs2.map(mockEnvelope(21)).map((e) => e.databaseId).toSorted())
	})

	describe('inbox sync', () => {
		it('fetches the inbox first', async () => {
			const account13 = {
				id: 13,
			}
			const account26 = {
				id: 26,
			}

			store.addAccountMutation(account13)
			store.addAccountMutation(account26)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'Drafts',
					databaseId: 12,
					specialRole: 'draft',
				},
			})
			store.addMailboxMutation({
				account: account26,
				mailbox: {
					name: 'INBOX',
					databaseId: 21,
					specialRole: 'inbox',
				},
			})
			store.addMailboxMutation({
				account: account26,
				mailbox: {
					name: 'Drafts',
					databaseId: 22,
					specialRole: 'draft',
				},
			})

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async () => {})

			await store.syncWatchedMailboxes()

			expect(store.fetchEnvelopes).toHaveBeenCalledTimes(2)
			expect(store.fetchEnvelopes).toHaveBeenNthCalledWith(1, {
				mailboxId: 11,
			})
			expect(store.fetchEnvelopes).toHaveBeenNthCalledWith(2, {
				mailboxId: 21,
			})

			expect(store.syncEnvelopes).toHaveBeenCalledTimes(2)
			expect(store.syncEnvelopes).toHaveBeenNthCalledWith(1, {
				mailboxId: 11,
			})
			expect(store.syncEnvelopes).toHaveBeenNthCalledWith(2, {
				mailboxId: 21,
			})

			// We can't detect new messages here
			expect(NotificationService.showNewMessagesNotification).not.toHaveBeenCalled()
		})

		it('syncs each individual mailbox', async () => {
			const account13 = {
				id: 13,
			}
			const account26 = {
				id: 26,
			}

			store.addAccountMutation(account13)
			store.addAccountMutation(account26)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'Drafts',
					databaseId: 12,
					specialRole: 'draft',
				},
			})
			store.addMailboxMutation({
				account: account26,
				mailbox: {
					name: 'INBOX',
					databaseId: 21,
					specialRole: 'inbox',
				},
			})
			store.addMailboxMutation({
				account: account26,
				mailbox: {
					name: 'Drafts',
					databaseId: 22,
					specialRole: 'draft',
				},
			})

			// Mock a pseudo envelope list for each mailbox to simulate existing mailboxes with
			// envelopes (and make sure that store.fetchEnvelopes() is not called).
			const envelopeListId = Symbol()
			normalizedEnvelopeListId.mockReturnValue(envelopeListId)
			for (const mailbox of Object.values(store.mailboxes)) {
				mailbox.envelopeLists[envelopeListId] = {}
			}

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				if (mailboxId === 11) {
					return [{ id: 123, flags: { seen: false } }]
				}
				if (mailboxId === 21) {
					return [{ id: 321, flags: { seen: true } }]
				}
				return []
			})

			await store.syncWatchedMailboxes()

			expect(store.fetchEnvelopes).not.toHaveBeenCalled()
			expect(store.syncEnvelopes).toHaveBeenCalledTimes(4)
			expect(store.syncEnvelopes).toHaveBeenNthCalledWith(1, {
				mailboxId: 11,
			})
			expect(store.syncEnvelopes).toHaveBeenNthCalledWith(2, {
				mailboxId: 21,
			})
			expect(store.syncEnvelopes).toHaveBeenNthCalledWith(3, {
				mailboxId: UNIFIED_INBOX_ID,
				query: 'is:pi-important',
			})
			expect(store.syncEnvelopes).toHaveBeenNthCalledWith(4, {
				mailboxId: UNIFIED_INBOX_ID,
				query: 'is:pi-other',
			})
			// Only the genuinely unseen message is news -- the one that came
			// back already marked seen (read elsewhere before this sync) must
			// not be part of the notification.
			expect(NotificationService.showNewMessagesNotification).toHaveBeenCalledTimes(1)
			expect(NotificationService.showNewMessagesNotification).toHaveBeenCalledWith([
				{ id: 123, flags: { seen: false } },
			])
		})

		it('does not notify at all when every newly synced message is already read', async () => {
			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})

			const envelopeListId = Symbol()
			normalizedEnvelopeListId.mockReturnValue(envelopeListId)
			for (const mailbox of Object.values(store.mailboxes)) {
				mailbox.envelopeLists[envelopeListId] = {}
			}

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				if (mailboxId === 11) {
					return [{ id: 123, flags: { seen: true } }]
				}
				return []
			})

			await store.syncWatchedMailboxes()

			// New messages did arrive, so the priority inbox is still refreshed
			// (inbox + the two priority queries) ...
			expect(store.syncEnvelopes).toHaveBeenCalledTimes(3)
			// ... but nothing is unseen, so there is nothing to notify about.
			expect(NotificationService.showNewMessagesNotification).not.toHaveBeenCalled()
		})

		it('notifies for a mailbox the moment its own sync resolves, not after every other mailbox', async () => {
			// The notification used to fire only after the global Promise.all
			// over every watched mailbox (plus the priority-inbox refresh)
			// settled -- so one slow/locked mailbox (e.g. the big Gmail INBOX
			// mid a lock-retry chain) delayed the desktop notification for
			// mail that had already arrived, synced, and updated its badge in
			// a completely different account.
			const account13 = {
				id: 13,
			}
			const account26 = {
				id: 26,
			}

			store.addAccountMutation(account13)
			store.addAccountMutation(account26)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})
			store.addMailboxMutation({
				account: account26,
				mailbox: {
					name: 'INBOX',
					databaseId: 21,
					specialRole: 'inbox',
				},
			})

			const envelopeListId = Symbol()
			normalizedEnvelopeListId.mockReturnValue(envelopeListId)
			for (const mailbox of Object.values(store.mailboxes)) {
				mailbox.envelopeLists[envelopeListId] = {}
			}

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				if (mailboxId === 11) {
					return [{ id: 123, flags: { seen: false } }]
				}
				// Mailbox 21 is stuck: its sync never resolves during this test.
				return new Promise(() => {})
			})

			const tickPromise = store.syncWatchedMailboxes()

			// Give mailbox 11's own (immediately resolving) sync chain a chance
			// to run -- the overall tick promise is still pending on mailbox 21.
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()

			expect(NotificationService.showNewMessagesNotification).toHaveBeenCalledTimes(1)
			expect(NotificationService.showNewMessagesNotification).toHaveBeenCalledWith([
				{ id: 123, flags: { seen: false } },
			])

			// Sanity: the tick as a whole really is still unresolved.
			let settled = false
			tickPromise.then(() => {
				settled = true
			})
			await Promise.resolve()
			expect(settled).toBe(false)
		})

		it('updateEnvelopeMutation() skips no-op updates instead of rebuilding identical reactive objects', () => {
			// The server reports every known message as "changed" on every
			// sync (upstream TODO in SyncService.php), and the watched-mailbox
			// poller syncs every bucket every ~10-15s -- unconditionally
			// replacing flags/tags with fresh objects thousands of times per
			// minute leaked memory until the browser tab died. Identical data
			// must leave the existing reactive objects untouched.
			const account13 = {
				id: 13,
			}
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 900, mailboxId: 11, uid: 1, flags: { seen: false }, tags: {} }],
				addToUnifiedMailboxes: false,
			})

			const flagsBefore = store.envelopes[900].flags
			const tagsBefore = store.envelopes[900].tags

			store.updateEnvelopeMutation({
				envelope: { databaseId: 900, mailboxId: 11, flags: { seen: false }, tags: {} },
			})

			expect(store.envelopes[900].flags).toBe(flagsBefore)
			expect(store.envelopes[900].tags).toBe(tagsBefore)

			store.updateEnvelopeMutation({
				envelope: { databaseId: 900, mailboxId: 11, flags: { seen: true }, tags: {} },
			})

			expect(store.envelopes[900].flags).not.toBe(flagsBefore)
			expect(store.envelopes[900].flags.seen).toBe(true)
			// Tags were still identical, so that object stays untouched.
			expect(store.envelopes[900].tags).toBe(tagsBefore)
		})

		it('a flag just set locally survives a sync response that still reports the pre-change value', () => {
			// toggleEnvelopeSeen() sets the flag optimistically and awaits its
			// own PUT to confirm it, but a completely independent sync
			// request (the watched-mailbox poller, or another Mailbox
			// instance's own sync() firing because the user switched
			// threads) can resolve AFTER that PUT and still report the
			// message's PRE-PUT flags -- the server reports every known
			// message as "changed" on every sync, not a real changed set.
			// Confirmed live: marking a message read updated the list
			// correctly, then reverted to unread/bold the moment the user
			// opened a different thread.
			const account13 = { id: 13 }
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 901, mailboxId: 11, uid: 1, flags: { seen: false }, tags: {} }],
				addToUnifiedMailboxes: false,
			})

			store.flagEnvelopeMutation({
				envelope: store.envelopes[901],
				flag: 'seen',
				value: true,
			})
			expect(store.envelopes[901].flags.seen).toBe(true)

			// A stale sync response for the same message, still reporting
			// the flag as it was before the user's own change.
			store.updateEnvelopeMutation({
				envelope: { databaseId: 901, mailboxId: 11, flags: { seen: false }, tags: {} },
			})

			expect(store.envelopes[901].flags.seen).toBe(true)
		})

		it('a recently-changed flag also survives a full listing refresh reporting the pre-change value', () => {
			const account13 = { id: 13 }
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 902, mailboxId: 11, uid: 1, flags: { seen: false }, tags: {} }],
				addToUnifiedMailboxes: false,
			})

			store.flagEnvelopeMutation({
				envelope: store.envelopes[902],
				flag: 'seen',
				value: true,
			})

			// A full fetchEnvelopes()-style listing refresh (replace: true),
			// still reflecting the pre-change server state.
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 902, mailboxId: 11, uid: 1, flags: { seen: false }, tags: {} }],
				query: undefined,
				replace: true,
				replaceMailboxId: 11,
				addToUnifiedMailboxes: false,
			})

			expect(store.envelopes[902].flags.seen).toBe(true)
		})

		it('stops protecting a flag once the grace window has actually elapsed', () => {
			vi.useFakeTimers()
			try {
				const account13 = { id: 13 }
				store.addAccountMutation(account13)
				store.addMailboxMutation({
					account: account13,
					mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
				})
				store.addEnvelopesMutation({
					envelopes: [{ databaseId: 903, mailboxId: 11, uid: 1, flags: { seen: false }, tags: {} }],
					addToUnifiedMailboxes: false,
				})

				store.flagEnvelopeMutation({
					envelope: store.envelopes[903],
					flag: 'seen',
					value: true,
				})

				// Past RECENT_FLAG_CHANGE_GRACE_MS (120s, raised from the
				// original 20s -- see actions.js for why).
				vi.advanceTimersByTime(130 * 1000)

				store.updateEnvelopeMutation({
					envelope: { databaseId: 903, mailboxId: 11, flags: { seen: false }, tags: {} },
				})

				// Long past the grace window: a subsequent sync reporting
				// seen:false is a genuine, later server-side change (e.g.
				// read on another device) and must win.
				expect(store.envelopes[903].flags.seen).toBe(false)
			} finally {
				vi.useRealTimers()
			}
		})

		it('still protects a flag from a stale sync landing well past the old 20s window', () => {
			// Confirmed live, 2026-07-13: this account's own IMAP sync
			// responses have been measured up to 67.8s -- comfortably
			// past the original 20s grace window, so a stale response
			// could (and did) land after protection had already expired,
			// silently reverting a flag the user had just changed (e.g.
			// starring a message), then flip-flopping back on the next
			// successful sync. Reproduces that exact timing with the
			// fixed 120s window and confirms it now holds.
			vi.useFakeTimers()
			try {
				const account13 = { id: 13 }
				store.addAccountMutation(account13)
				store.addMailboxMutation({
					account: account13,
					mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
				})
				store.addEnvelopesMutation({
					envelopes: [{ databaseId: 904, mailboxId: 11, uid: 1, flags: { flagged: false }, tags: {} }],
					addToUnifiedMailboxes: false,
				})

				store.flagEnvelopeMutation({
					envelope: store.envelopes[904],
					flag: 'flagged',
					value: true,
				})

				// A sync as slow as the worst one actually measured for
				// this account -- would have already cleared the old 20s
				// window, incorrectly reverting the star.
				vi.advanceTimersByTime(68 * 1000)

				store.updateEnvelopeMutation({
					envelope: { databaseId: 904, mailboxId: 11, flags: { flagged: false }, tags: {} },
				})

				expect(store.envelopes[904].flags.flagged).toBe(true)
			} finally {
				vi.useRealTimers()
			}
		})

		// recentFlagChanges generalized to recentLocalChanges to also
		// cover envelope.tags -- previously unprotected against the exact
		// same class of stale-sync race the flags grace window above
		// already guards against, and the field that actually drives the
		// visible "important" badge (see setEnvelopeImportant()).
		it('a recently-added tag survives a stale sync reporting the pre-change tags', () => {
			const account13 = { id: 13 }
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 905, mailboxId: 11, uid: 1, flags: {}, tags: [] }],
				addToUnifiedMailboxes: false,
			})

			store.addEnvelopeTagMutation({ envelope: store.envelopes[905], tagId: 1 })
			expect(store.envelopes[905].tags).toEqual([1])

			// A stale sync response, generated before the tag PUT landed
			// server-side, still reporting the old (empty) tags array.
			store.updateEnvelopeMutation({
				envelope: { databaseId: 905, mailboxId: 11, flags: {}, tags: [] },
			})

			expect(store.envelopes[905].tags).toEqual([1])
		})

		it('stops protecting a tag once the grace window has actually elapsed', () => {
			vi.useFakeTimers()
			try {
				const account13 = { id: 13 }
				store.addAccountMutation(account13)
				store.addMailboxMutation({
					account: account13,
					mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
				})
				store.addEnvelopesMutation({
					envelopes: [{ databaseId: 906, mailboxId: 11, uid: 1, flags: {}, tags: [] }],
					addToUnifiedMailboxes: false,
				})

				store.addEnvelopeTagMutation({ envelope: store.envelopes[906], tagId: 1 })

				vi.advanceTimersByTime(130 * 1000)

				store.updateEnvelopeMutation({
					envelope: { databaseId: 906, mailboxId: 11, flags: {}, tags: [] },
				})

				// Long past the grace window: a subsequent sync reporting
				// an empty tags array is a genuine, later server-side
				// change (e.g. removed from another client) and must win.
				expect(store.envelopes[906].tags).toEqual([])
			} finally {
				vi.useRealTimers()
			}
		})

		// removeEnvelopeMutation()'s new 'removedFromMailbox' bookkeeping,
		// consulted by addEnvelopesMutation()'s merge loop -- closes a gap
		// found (not previously reported) while building the tags
		// protection above: nothing stopped a stale sync response from
		// resurrecting a message this client had just deleted/archived/
		// junked away, previously guarded only by the much shorter
		// (4s) INTERACTION_PRIORITY_WINDOW_MS pause of the whole poller.
		it('a stale sync does not resurrect a message just removed from its mailbox', () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account13 = { id: 13 }
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 907, mailboxId: 11, uid: 1, flags: {}, tags: [] }],
				addToUnifiedMailboxes: false,
			})

			store.removeEnvelopeMutation({ id: 907 })
			expect(store.envelopes[907]).toBeUndefined()

			// A stale sync response, generated before the deletion landed
			// server-side, still reporting the message as present.
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 907, mailboxId: 11, uid: 1, dateInt: 1, flags: {}, tags: [] }],
				addToUnifiedMailboxes: false,
			})

			expect(store.envelopes[907]).toBeUndefined()
			expect(store.mailboxes[11].envelopeLists['']).not.toContain(907)
		})

		it('does not suppress the same message legitimately reappearing in a DIFFERENT mailbox', () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account13 = { id: 13 }
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'Trash', databaseId: 12, specialRole: 'trash' },
			})
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 908, mailboxId: 11, uid: 1, flags: {}, tags: [] }],
				addToUnifiedMailboxes: false,
			})

			store.removeEnvelopeMutation({ id: 908 })

			// The same message, now genuinely in a different mailbox
			// (moved to Trash) -- must not be suppressed, since the
			// removal marker is scoped to the mailbox it was removed
			// from (11), not global.
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 908, mailboxId: 12, uid: 5, dateInt: 1, flags: {}, tags: [] }],
				addToUnifiedMailboxes: false,
			})

			expect(store.envelopes[908]).toBeDefined()
			expect(store.mailboxes[12].envelopeLists['']).toContain(908)
		})

		it('a deliberate revert-on-failure re-add bypasses the removal suppression', () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account13 = { id: 13 }
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
			const envelope = { databaseId: 909, mailboxId: 11, uid: 1, dateInt: 1, flags: {}, tags: [] }
			store.addEnvelopesMutation({ envelopes: [envelope], addToUnifiedMailboxes: false })

			// Optimistic removal, then the real network call failed --
			// the exact pattern deleteMessage()/deleteThread()/
			// toggleEnvelopeJunk() etc. all use to revert.
			store.removeEnvelopeMutation({ id: 909 })
			store.addEnvelopesMutation({ envelopes: [envelope], addToUnifiedMailboxes: false, bypassRemovalSuppression: true })

			expect(store.envelopes[909]).toBeDefined()
			expect(store.mailboxes[11].envelopeLists['']).toContain(909)

			// The marker itself must be cleared, not just bypassed once --
			// a LATER, genuinely stale sync must not suppress it either.
			store.addEnvelopesMutation({
				envelopes: [{ databaseId: 909, mailboxId: 11, uid: 1, dateInt: 1, flags: {}, tags: [] }],
				addToUnifiedMailboxes: false,
			})
			expect(store.envelopes[909]).toBeDefined()
		})

		it('notifies a message only once even when several query buckets of the mailbox report it', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})

			// Two loaded buckets (e.g. '' and 'not:starred') -- both syncs
			// report the same new message relative to their own sync tokens.
			store.mailboxes[11].envelopeLists.A = []
			store.mailboxes[11].envelopeLists.B = []

			const newMessage = { databaseId: 777, flags: { seen: false } }
			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				if (mailboxId === 11) {
					return [newMessage]
				}
				return []
			})

			await store.syncWatchedMailboxes()

			expect(NotificationService.showNewMessagesNotification).toHaveBeenCalledTimes(1)
			expect(NotificationService.showNewMessagesNotification).toHaveBeenCalledWith([newMessage])
		})

		it('syncs every already-loaded query bucket of a mailbox, not just the default', async () => {
			// Reproduces a real bug: when "sort favorites separately" is on, the
			// visible list reads from envelopeLists['not:starred'], but syncWatchedMailboxes()
			// used to only ever sync the unfiltered '' bucket -- new mail landed in
			// the store under the wrong key and never appeared in the open view,
			// even though the mailbox's unread counter updated correctly (a separate
			// mechanism). This asserts every existing bucket gets its own sync call.
			//
			// 'not:starred' specifically is deliberately NOT used here anymore:
			// wave 1b coalesces it away when '' is also loaded (see the
			// dedicated coalescing describe block below), so it no longer
			// gets its own call -- that's the intended new behavior, not a
			// regression of this one. 'subject:foo' isn't coalescable and
			// still exercises the original per-bucket guarantee.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})

			// Simulate a mailbox that's been viewed both with the default query and
			// with a second, non-coalescable bucket.
			store.mailboxes[11].envelopeLists[''] = []
			store.mailboxes[11].envelopeLists['subject:foo'] = []

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async () => [])

			await store.syncWatchedMailboxes()

			expect(store.fetchEnvelopes).not.toHaveBeenCalled()
			expect(store.syncEnvelopes).toHaveBeenCalledTimes(2)
			expect(store.syncEnvelopes).toHaveBeenCalledWith({
				mailboxId: 11,
				query: '',
			})
			expect(store.syncEnvelopes).toHaveBeenCalledWith({
				mailboxId: 11,
				query: 'subject:foo',
			})
		})

		it('wave 1b: coalesces is:starred/not:starred/is:pi-important/is:pi-other into the unfiltered sync when it is also loaded', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account13 = { id: 913 }
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 911, specialRole: 'inbox' },
			})

			store.mailboxes[911].envelopeLists[''] = []
			store.mailboxes[911].envelopeLists['is:starred'] = []
			store.mailboxes[911].envelopeLists['not:starred'] = []
			store.mailboxes[911].envelopeLists['is:pi-important'] = []
			store.mailboxes[911].envelopeLists['is:pi-other'] = []

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async () => [])

			await store.syncWatchedMailboxes()

			expect(store.syncEnvelopes).toHaveBeenCalledTimes(1)
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 911, query: '' })
		})

		it('wave 1b: does NOT coalesce when the unfiltered bucket is not loaded (no regression for that case)', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account14 = { id: 914 }
			store.addAccountMutation(account14)
			store.addMailboxMutation({
				account: account14,
				mailbox: { name: 'INBOX', databaseId: 921, specialRole: 'inbox' },
			})

			// '' itself was never loaded -- e.g. "sort favorites separately"
			// hides the plain view entirely. Nothing here is guaranteed to
			// cover every known id's current flags, so each bucket keeps
			// syncing on its own, same as before wave 1b.
			store.mailboxes[921].envelopeLists['is:starred'] = []
			store.mailboxes[921].envelopeLists['not:starred'] = []

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async () => [])

			await store.syncWatchedMailboxes()

			expect(store.syncEnvelopes).toHaveBeenCalledTimes(2)
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 921, query: 'is:starred' })
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 921, query: 'not:starred' })
		})

		it('never independently syncs is:pi-important/is:pi-other on a real mailbox -- maybeStartPriorityInboxRefresh() already owns them', async () => {
			// Regression: these two buckets end up loaded on a real
			// mailbox's own envelopeLists purely as a side effect of
			// maybeStartPriorityInboxRefresh()'s own fan-out (bare or
			// compound with not:starred, see appendToSearch()) -- having
			// this separate, uncoordinated loop ALSO sync them
			// independently every tick raced two callers reading/writing
			// the same envelopeLists array, confirmed live as the same
			// message reported as "new" by both syncs over and over, tick
			// after tick, with no new mail and no user interaction.
			// is:starred/not:starred are deliberately left out of this
			// exclusion (see the "does NOT coalesce" test above) -- a real
			// folder's own Favorites section can legitimately load those
			// same bare keys too, with no way to tell the two origins
			// apart from the query string alone.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account = { id: 915 }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { name: 'INBOX', databaseId: 922, specialRole: 'inbox' },
			})

			store.mailboxes[922].envelopeLists['is:pi-important'] = []
			store.mailboxes[922].envelopeLists['not:starred is:pi-other'] = []
			store.mailboxes[922].envelopeLists['is:starred'] = []

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async () => [])

			await store.syncWatchedMailboxes()

			expect(store.syncEnvelopes).toHaveBeenCalledTimes(1)
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 922, query: 'is:starred' })
		})

		it('lightweight tick: syncs only the unfiltered bucket and skips the priority refresh', async () => {
			// Hidden tabs poll in lightweight mode (see App.vue): one
			// representative bucket per watched mailbox is enough for a
			// complete, timely new-mail notification; the full UI state is
			// reconciled by the immediate full tick on tab activation.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})

			store.mailboxes[11].envelopeLists[''] = []
			store.mailboxes[11].envelopeLists['not:starred'] = []

			const newMessage = { databaseId: 778, flags: { seen: false } }
			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => mailboxId === 11 ? [newMessage] : [])

			await store.syncWatchedMailboxes({ lightweight: true })

			// Only one bucket synced -- the unfiltered one.
			expect(store.syncEnvelopes).toHaveBeenCalledTimes(1)
			expect(store.syncEnvelopes).toHaveBeenCalledWith({
				mailboxId: 11,
				query: '',
			})
			// The notification still fired (that's the whole point).
			expect(NotificationService.showNewMessagesNotification).toHaveBeenCalledWith([newMessage])
			// No priority-inbox refresh: no sync against the unified inbox.
			expect(store.syncEnvelopes).not.toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'unified' }))
		})

		it('starts the priority refresh as soon as the first mailbox reports new mail, not after the slowest', async () => {
			// The old code ran the refresh only after EVERY watched
			// mailbox's sync settled -- one slow mailbox (7-81s Gmail
			// syncs measured live) held the priority inbox stale long
			// after the receiving mailbox's badge had updated.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			for (const [accountId, mailboxId] of [[913, 911], [914, 921]]) {
				const account = { id: accountId }
				store.addAccountMutation(account)
				store.addMailboxMutation({
					account,
					mailbox: {
						name: 'INBOX',
						databaseId: mailboxId,
						specialRole: 'inbox',
					},
				})
				store.mailboxes[mailboxId].envelopeLists[''] = []
			}

			let resolveSlow
			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(({ mailboxId }) => {
				if (mailboxId === 921) {
					// The slow mailbox: unresolved until the test says so.
					return new Promise((resolve) => {
						resolveSlow = () => resolve([])
					})
				}
				if (mailboxId === 911) {
					return Promise.resolve([{ databaseId: 777, flags: { seen: false } }])
				}
				return Promise.resolve([])
			})

			const tick = store.syncWatchedMailboxes()

			// The refresh fires while mailbox 21's sync is still pending.
			await vi.waitFor(() => {
				expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 'unified', query: 'is:pi-important' })
				expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 'unified', query: 'is:pi-other' })
			})
			expect(resolveSlow).toBeDefined()

			resolveSlow()
			await tick
		})

		it("refreshes the actually-displayed COMPOUND priority queries when 'sort favorites separately' is on, not just the bare ones", async () => {
			// Regression: "sort favorites separately" makes
			// MailboxThread.vue load compound keys for the priority inbox
			// sections (e.g. "not:starred is:pi-important", see its
			// appendToSearch()/created()), but the priority-inbox refresh
			// only ever synced the bare is:pi-important/is:pi-other keys on
			// the unified mailbox. The compound-keyed list actually shown
			// on screen never got its own resync at all -- it could only
			// ever be corrected as an incidental side effect of some
			// unrelated mailbox's own bucket sync touching the same
			// envelope id via reclassifyFlagBucketsMutation. Confirmed
			// live: a message the classifier had already downgraded
			// (flag_important flipped to false hours earlier) kept
			// showing as important indefinitely.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account = { id: 13 }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
			store.mailboxes[11].envelopeLists[''] = []

			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['not:starred is:pi-important'] = []
			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['not:starred is:pi-other'] = []

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				if (mailboxId === 11) {
					return [{ databaseId: 779, flags: { seen: false } }]
				}
				return []
			})

			await store.syncWatchedMailboxes()

			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 'unified', query: 'not:starred is:pi-important' })
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 'unified', query: 'not:starred is:pi-other' })
			expect(store.syncEnvelopes).not.toHaveBeenCalledWith({ mailboxId: 'unified', query: 'is:pi-important' })
			expect(store.syncEnvelopes).not.toHaveBeenCalledWith({ mailboxId: 'unified', query: 'is:pi-other' })
		})

		it("also refreshes the priority inbox's Favorites section (is:starred), not just Important/Other", async () => {
			// Regression: the fix above only matched tokens for
			// priorityImportantQuery/priorityOtherQuery -- the Favorites
			// section (MailboxThread.vue's favoriteQuery, 'is:starred',
			// substituted in for 'not:starred' by its own appendToSearch())
			// was left with exactly the same never-independently-resynced
			// gap the Important section had, just for a third bucket.
			// Confirmed live: the Favorites list showed messages with no
			// star at all, the same class of symptom already fixed for
			// Important.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account = { id: 13 }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
			store.mailboxes[11].envelopeLists[''] = []

			store.mailboxes[UNIFIED_INBOX_ID].envelopeLists['is:starred'] = []

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				if (mailboxId === 11) {
					return [{ databaseId: 781, flags: { seen: false } }]
				}
				return []
			})

			await store.syncWatchedMailboxes()

			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 'unified', query: 'is:starred' })
		})

		it('falls back to the bare priority queries when neither the bare nor compound keys are loaded yet', async () => {
			// First-ever load of this session: nothing loaded on the
			// unified mailbox yet, so there is nothing to distinguish bare
			// from compound -- same behavior as before this fix.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account = { id: 13 }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
			store.mailboxes[11].envelopeLists[''] = []

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				if (mailboxId === 11) {
					return [{ databaseId: 780, flags: { seen: false } }]
				}
				return []
			})

			await store.syncWatchedMailboxes()

			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 'unified', query: 'is:pi-important' })
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 'unified', query: 'is:pi-other' })
		})

		it('keeps refreshing an OPEN priority inbox when interaction priority activates mid-tick', async () => {
			// Interaction priority pauses background work, but the open
			// priority inbox is what the user is looking at -- and the
			// only view that cannot update itself. The old skip starved
			// exactly the person watching it.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			store.setCurrentViewMailboxIdMutation('priority')

			const account = { id: 13 }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})
			store.mailboxes[11].envelopeLists[''] = []

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				if (mailboxId === 11) {
					// A user interaction lands mid-tick, after the guard at
					// the top of syncWatchedMailboxes() already passed.
					store.setInteractionPriorityMutation()
					return [{ databaseId: 778, flags: { seen: false } }]
				}
				return []
			})

			await store.syncWatchedMailboxes()

			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 'unified', query: 'is:pi-important' })
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 'unified', query: 'is:pi-other' })
		})

		it('still defers the refresh on mid-tick interaction when the priority inbox is NOT open', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account = { id: 13 }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})
			store.mailboxes[11].envelopeLists[''] = []

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				if (mailboxId === 11) {
					store.setInteractionPriorityMutation()
					return [{ databaseId: 779, flags: { seen: false } }]
				}
				return []
			})

			await store.syncWatchedMailboxes()

			expect(store.syncEnvelopes).not.toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'unified' }))
		})

		it('syncs the open mailbox first, ahead of earlier accounts in the default order', async () => {
			// Active-query-first refetch: with 3 pool workers and a slow
			// mailbox early in account order, the mailbox the user is
			// looking at could otherwise wait most of the tick.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			store.setCurrentViewMailboxIdMutation('941')

			for (const [accountId, mailboxId] of [[913, 911], [914, 921], [915, 931], [916, 941]]) {
				const account = { id: accountId }
				store.addAccountMutation(account)
				store.addMailboxMutation({
					account,
					mailbox: {
						name: 'INBOX',
						databaseId: mailboxId,
						specialRole: 'inbox',
					},
				})
				store.mailboxes[mailboxId].envelopeLists[''] = []
			}

			const callOrder = []
			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				callOrder.push(mailboxId)
				return []
			})

			await store.syncWatchedMailboxes()

			expect(callOrder[0]).toBe(941)
			// The rest keep the original account order.
			expect(callOrder).toEqual([941, 911, 921, 931])
		})

		it('with the priority inbox open, every account inbox goes ahead of other watched mailboxes', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			store.setCurrentViewMailboxIdMutation('priority')

			// Account 13: a background-synced non-inbox folder first in
			// the default order; account 14: an inbox.
			const account913 = { id: 913 }
			store.addAccountMutation(account913)
			store.addMailboxMutation({
				account: account913,
				mailbox: {
					name: 'Archive',
					databaseId: 915,
					syncInBackground: true,
				},
			})
			const account914 = { id: 914 }
			store.addAccountMutation(account914)
			store.addMailboxMutation({
				account: account914,
				mailbox: {
					name: 'INBOX',
					databaseId: 921,
					specialRole: 'inbox',
				},
			})
			store.mailboxes[915].envelopeLists[''] = []
			store.mailboxes[921].envelopeLists[''] = []

			const callOrder = []
			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				callOrder.push(mailboxId)
				return []
			})

			await store.syncWatchedMailboxes()

			expect(callOrder[0]).toBe(921)
			expect(callOrder).toContain(915)
		})

		it('syncs a mailbox\'s query buckets sequentially, not concurrently', async () => {
			// syncEnvelopes() has its own internal retry-on-lock loop that keeps
			// awaiting until the mailbox unlocks (every 1.5s, see its own
			// implementation). A sync lock is mailbox-wide, not per-query, so
			// firing every bucket's sync at once would make every bucket
			// independently re-trigger its own retry chain against the same
			// lock -- multiplying request volume by the bucket count for as
			// long as the mailbox stays locked. Confirmed this actually happens
			// live: a genuinely long-held lock on a slow account produced a
			// sustained ~1 request/second storm with two buckets loaded.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')

			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})

			// Deliberately NOT 'not:starred'/is:pi-*: those are coalesced
			// away when '' is also loaded (see wave 1b, "bucket
			// coalescing" below) precisely so they DON'T fire their own
			// separate sync -- this test wants two buckets that genuinely
			// still sync independently, to exercise the sequential-not-
			// concurrent behavior itself.
			store.mailboxes[11].envelopeLists[''] = []
			store.mailboxes[11].envelopeLists['subject:foo'] = []

			store.fetchEnvelopes = vi.fn(async () => {})

			let firstCallInFlight = false
			let secondCallStartedWhileFirstWasInFlight = false
			let resolveFirstCall
			store.syncEnvelopes = vi.fn(async () => {
				if (!firstCallInFlight) {
					firstCallInFlight = true
					return new Promise((resolve) => {
						resolveFirstCall = () => resolve([])
					})
				}
				secondCallStartedWhileFirstWasInFlight = true
				return []
			})

			const syncPromise = store.syncWatchedMailboxes()

			// Give the first (still-pending) call's microtask a chance to run.
			await Promise.resolve()
			await Promise.resolve()
			expect(store.syncEnvelopes).toHaveBeenCalledTimes(1)
			expect(secondCallStartedWhileFirstWasInFlight).toBe(false)

			resolveFirstCall()
			await syncPromise

			// The second bucket's sync only fires once the first one resolves --
			// by this point that's expected and correct, unlike above.
			expect(store.syncEnvelopes).toHaveBeenCalledTimes(2)
		})

		it('also syncs non-inbox mailboxes flagged syncInBackground', async () => {
			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'Drafts',
					databaseId: 12,
					specialRole: 'draft',
				},
			})
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'Newsletters',
					databaseId: 13,
					syncInBackground: true,
				},
			})

			store.fetchEnvelopes = vi.fn(async () => {})
			store.syncEnvelopes = vi.fn(async () => {})

			await store.syncWatchedMailboxes()

			// Drafts (13) has neither specialRole 'inbox' nor syncInBackground --
			// only the inbox and the explicitly-flagged mailbox are watched.
			expect(store.syncEnvelopes).toHaveBeenCalledTimes(2)
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 11 })
			expect(store.syncEnvelopes).toHaveBeenCalledWith({ mailboxId: 13 })
			expect(store.syncEnvelopes).not.toHaveBeenCalledWith({ mailboxId: 12 })
		})

		it('skips a mailbox with a sync retry already pending, without holding back any other watched mailbox', async () => {
			// Reproduces the scenario a 10s-cadence poller must handle: one
			// watched mailbox (e.g. a large Gmail INBOX mid a genuinely long
			// full sync) is locked and already has its own retry chain
			// running. Without this check, every new tick would queue up
			// another "await the leader, then try again" continuation on top
			// of the last one, all firing in a burst once the lock finally
			// clears -- and, more importantly, every OTHER watched mailbox
			// must still get synced this tick regardless.
			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'Newsletters',
					databaseId: 13,
					syncInBackground: true,
				},
			})

			// Mailbox 11 fails its first attempt (registering as the
			// pending leader) and succeeds on any attempt after that --
			// mirroring the existing "skips a doomed network request"
			// test's pattern, so the leader's own retry chain resolves
			// cleanly once released instead of looping forever.
			const callCounts = {}
			const healthyStats = { newMessages: [], changedMessages: [], vanishedMessages: [], stats: { unread: 0 } }
			MessageService.syncEnvelopes.mockImplementation(async (accountId, mailboxId) => {
				callCounts[mailboxId] = (callCounts[mailboxId] ?? 0) + 1
				if (mailboxId === 11 && callCounts[mailboxId] === 1) {
					throw new MailboxLockedError('locked')
				}
				return healthyStats
			})

			// Hold mailbox 11's retry wait open so it stays registered as a
			// pending leader throughout this test, instead of immediately
			// retrying and resolving.
			let releaseLeaderWait
			wait.mockImplementationOnce(() => new Promise((resolve) => {
				releaseLeaderWait = resolve
			}))

			const leaderPromise = store.syncEnvelopes({ mailboxId: 11 })
			// Let the leader's failed first attempt run and register itself.
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()

			await store.syncWatchedMailboxes()

			// Mailbox 13 (healthy) synced normally this tick, unaffected by
			// mailbox 11 being locked and mid-retry.
			expect(MessageService.syncEnvelopes.mock.calls.filter(([, mailboxId]) => mailboxId === 13)).toHaveLength(1)
			// Mailbox 11 was skipped by syncWatchedMailboxes() itself -- the
			// only call attributable to it so far is the leader's own
			// original (failed) attempt, not a second one from this tick.
			expect(callCounts[11]).toBe(1)

			releaseLeaderWait()
			await leaderPromise
		})

		it('skips a mailbox whose bucket loop from an earlier tick is still in flight (not yet failed), so a new tick cannot race it', async () => {
			// Reproduces a real production bug: isMailboxSyncRetryPending only
			// starts tracking a mailbox once a request has actually FAILED
			// with MailboxLockedError -- it says nothing about a call that's
			// simply still in flight (ordinary IMAP latency, no error). A
			// ~10-15s poller tick can easily fire again before a slower
			// mailbox's own bucket loop from the PREVIOUS tick has finished,
			// and without this check, syncWatchedMailboxes() would start a
			// second, fully independent bucket loop for the same mailbox --
			// two genuinely concurrent callers racing the same mailbox's lock
			// acquisition. Confirmed live: a single tab, no other client
			// involved, produced a clean, repeating 409-with-near-maximal-
			// Retry-After cycle on one mailbox -- the signature of a real,
			// not just advisory, held lock recurring.
			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'Newsletters',
					databaseId: 13,
					syncInBackground: true,
				},
			})

			// Give both mailboxes an already-loaded default bucket so the
			// bucket loop never needs to call fetchEnvelopes().
			store.mailboxes[11].envelopeLists[''] = []
			store.mailboxes[13].envelopeLists[''] = []

			// Mock store.syncEnvelopes() directly (not the network layer)
			// for full, simple control over exactly when each mailbox's
			// call resolves, with no nested handleHttpAuthErrors/mutation
			// promise chains to account for.
			let resolveMailbox11Sync
			const mailbox11Calls = []
			const mailbox13Calls = []
			store.syncEnvelopes = vi.fn(async ({ mailboxId }) => {
				if (mailboxId === 11) {
					mailbox11Calls.push(1)
					return new Promise((resolve) => {
						resolveMailbox11Sync = () => resolve([])
					})
				}
				mailbox13Calls.push(1)
				return []
			})

			// First tick: mailbox 11's sync is still in flight (never
			// resolved yet) when the second tick starts below. Mailbox 13's
			// own call resolves immediately, so its bucket loop -- and
			// watchedMailboxSyncsInFlight entry -- is fully done by the
			// time the first tick's overall promise is awaited here (the
			// only thing left unresolved in that Promise.all is mailbox 11).
			const firstTickPromise = store.syncWatchedMailboxes()
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()

			expect(mailbox13Calls).toHaveLength(1)

			// Second tick, firing before the first has finished with
			// mailbox 11 -- must not start its own, concurrent attempt.
			await store.syncWatchedMailboxes()

			expect(mailbox11Calls).toHaveLength(1)
			// Mailbox 13 still gets synced fresh every tick, regardless.
			expect(mailbox13Calls).toHaveLength(2)

			resolveMailbox11Sync()
			await firstTickPromise
		})
	})

	describe('priority inbox: never send the virtual id to the server', () => {
		// "priority" (PRIORITY_INBOX_ID) is a virtual mailbox id with no real
		// mailbox behind it. Regression coverage for a live bug: with an
		// explicit filter active (e.g. "not:starred" from the
		// favorites-split view), both syncEnvelopes() and fetchEnvelopes()
		// fell through to the generic path and sent mailboxId="priority"
		// straight to the server, 403ing every time.
		let account13
		let account17

		beforeEach(() => {
			account13 = { id: 13 }
			account17 = { id: 17 }
			store.addAccountMutation(account13)
			store.addAccountMutation(account17)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 5, specialRole: 'inbox' },
			})
			store.addMailboxMutation({
				account: account17,
				mailbox: { name: 'INBOX', databaseId: 10, specialRole: 'inbox' },
			})
		})

		it('syncEnvelopes fans out to the real inbox mailboxes with the caller\'s own filter, not the virtual id', async () => {
			MessageService.syncEnvelopes.mockResolvedValue({
				newMessages: [],
				changedMessages: [],
				vanishedMessages: [],
				stats: { unread: 0 },
			})

			await store.syncEnvelopes({ mailboxId: 'priority', query: 'not:starred' })

			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(2)
			const calledMailboxIds = MessageService.syncEnvelopes.mock.calls.map((call) => call[1]).sort((a, b) => a - b)
			expect(calledMailboxIds).toEqual([5, 10])
			for (const call of MessageService.syncEnvelopes.mock.calls) {
				expect(call[1]).not.toBe('priority')
				expect(call[4]).toBe('not:starred')
			}
		})

		it('syncEnvelopes fans out across both priority queries when no filter is given', async () => {
			MessageService.syncEnvelopes.mockResolvedValue({
				newMessages: [],
				changedMessages: [],
				vanishedMessages: [],
				stats: { unread: 0 },
			})

			await store.syncEnvelopes({ mailboxId: 'priority' })

			// 2 real mailboxes x 2 priority queries
			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(4)
			const calledQueries = MessageService.syncEnvelopes.mock.calls.map((call) => call[4]).sort()
			expect(calledQueries).toEqual(['is:pi-important', 'is:pi-important', 'is:pi-other', 'is:pi-other'])
		})

		it('fetchEnvelopes fans out to the real inbox mailboxes with the caller\'s own filter, not the virtual id', async () => {
			MessageService.fetchEnvelopes.mockResolvedValue([])

			await store.fetchEnvelopes({ mailboxId: 'priority', query: 'not:starred' })

			expect(MessageService.fetchEnvelopes).toHaveBeenCalledTimes(2)
			const calledMailboxIds = MessageService.fetchEnvelopes.mock.calls.map((call) => call[1]).sort((a, b) => a - b)
			expect(calledMailboxIds).toEqual([5, 10])
			for (const call of MessageService.fetchEnvelopes.mock.calls) {
				expect(call[1]).not.toBe('priority')
				expect(call[2]).toBe('not:starred')
			}
		})

		it('fetchEnvelopes fans out across both priority queries when no filter is given', async () => {
			MessageService.fetchEnvelopes.mockResolvedValue([])

			await store.fetchEnvelopes({ mailboxId: 'priority' })

			expect(MessageService.fetchEnvelopes).toHaveBeenCalledTimes(4)
			const calledQueries = MessageService.fetchEnvelopes.mock.calls.map((call) => call[2]).sort()
			expect(calledQueries).toEqual(['is:pi-important', 'is:pi-important', 'is:pi-other', 'is:pi-other'])
		})

		it('fetchNextEnvelopes ("Load more") fans out to the real inbox mailboxes with the caller\'s own filter, not the virtual id', async () => {
			// Regression: this "Load more" pagination path had no
			// isPriorityInbox branch at all (unlike fetchEnvelopes()/
			// syncEnvelopes() above, which at least had a too-narrow one)
			// -- every "Load more" tap inside a priority-inbox section
			// fell straight through to the generic path and sent
			// mailboxId="priority" to the server, 403ing every time and
			// silently never loading anything further.
			let nextId = 2000
			MessageService.fetchEnvelopes.mockImplementation(async () => [{
				databaseId: nextId++,
				dateInt: 500,
				mailboxId: 5,
				flags: {},
			}])

			// Seed one known envelope per real mailbox (and, via the
			// already-fixed fan-out, the "priority" mailbox's own merged
			// list) -- fewer than `quantity`, so fetchNextEnvelopes()'s
			// own local-data-sufficiency check correctly decides a real
			// fetch is still needed.
			await store.fetchEnvelopes({ mailboxId: 'priority', query: 'is:pi-important' })
			MessageService.fetchEnvelopes.mockClear()
			MessageService.fetchEnvelopes.mockImplementation(async (accountId, mailboxId) => [{
				databaseId: nextId++,
				dateInt: 400,
				mailboxId,
				flags: {},
			}])

			await store.fetchNextEnvelopes({ mailboxId: 'priority', query: 'is:pi-important', quantity: 20 })

			expect(MessageService.fetchEnvelopes.mock.calls.length).toBeGreaterThan(0)
			for (const call of MessageService.fetchEnvelopes.mock.calls) {
				expect(call[1]).not.toBe('priority')
				expect([5, 10]).toContain(call[1])
				expect(call[2]).toBe('is:pi-important')
			}
		})
	})

	describe('fetchNextEnvelopes: a loaded-but-empty list has nothing more to page past', () => {
		// Reported live: scrolling a mailbox/priority-inbox section whose
		// current query has zero matches (e.g. after a search, or one
		// real mailbox among several fanned-out ones with nothing
		// matching) logged "mailbox is empty" and rejected with "Local
		// mailbox has no envelopes, cannot determine cursor" -- on every
		// affected mailbox, on every scroll tick. That's a perfectly
		// ordinary "nothing more to load", the same situation
		// fetchNextFannedOutPage()'s own empty-cursor guard already
		// handles gracefully one level up; this is the plain-mailbox
		// (non-priority, non-unified) counterpart of that same fix.
		it('resolves to [] instead of rejecting when the mailbox has no envelopes for the current query', async () => {
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: {
					id: 'INBOX',
					name: 'INBOX',
					databaseId: 21,
					accountId: 13,
					specialRole: 'inbox',
				},
			})

			// Seed the (mocked-to-'') query bucket as loaded but empty --
			// a real search/filter with zero matches, not "never fetched".
			MessageService.fetchEnvelopes.mockResolvedValue([])
			await store.fetchEnvelopes({ mailboxId: 21, query: 'subject:nothing-matches' })

			await expect(store.fetchNextEnvelopes({ mailboxId: 21, query: 'subject:nothing-matches', quantity: 20 }))
				.resolves.toEqual([])
		})
	})

	describe('syncEnvelopes: virtual-mailbox fan-out is bounded and deduped', () => {
		// Confirmed live: the isUnified/isPriorityInbox fan-out below used
		// to be a bare Promise.all with no concurrency limit at all -- a
		// completely separate path from fetchEnvelopes()'s own bounded
		// fan-out, so the shared cross-mechanism limiter (see
		// mapWithConcurrencyLimit's own tests) never reached it. On top of
		// that, Priority Inbox's three section components each
		// independently call sync() on mount, so the exact same
		// (mailboxId, query) could be asked for multiple times within
		// milliseconds -- each one kicking off its own full, redundant
		// fan-out. Both fixed together: bounded via
		// mapWithConcurrencyLimit(), and deduped via pendingUnifiedSyncs.
		let accounts

		beforeEach(() => {
			accounts = [11, 12, 13, 14, 15].map((id) => ({ id }))
			accounts.forEach((account, i) => {
				store.addAccountMutation(account)
				store.addMailboxMutation({
					account,
					mailbox: { name: 'INBOX', databaseId: 100 + i, specialRole: 'inbox' },
				})
			})
		})

		it('caps the priority-inbox fan-out so constituent syncs never all run at once', async () => {
			let concurrent = 0
			let maxConcurrent = 0
			const pendingResolvers = []
			MessageService.syncEnvelopes.mockImplementation(() => new Promise((resolve) => {
				concurrent++
				maxConcurrent = Math.max(maxConcurrent, concurrent)
				pendingResolvers.push(() => {
					concurrent--
					resolve({ newMessages: [], changedMessages: [], vanishedMessages: [], stats: { unread: 0 } })
				})
			}))

			const syncPromise = store.syncEnvelopes({ mailboxId: 'priority', query: 'not:starred' })

			await vi.waitFor(() => {
				if (pendingResolvers.length < 3) {
					throw new Error(`only ${pendingResolvers.length} constituent syncs have started so far`)
				}
			})

			// ENVELOPE_FETCH_CONCURRENCY: 3 of the 5 real mailboxes may be
			// mid-sync at once, not all 5 like the old bare Promise.all.
			expect(pendingResolvers.length).toBe(3)
			expect(maxConcurrent).toBe(3)

			while (pendingResolvers.length > 0) {
				pendingResolvers.splice(0).forEach((resolve) => resolve())
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
			await syncPromise

			expect(maxConcurrent).toBe(3)
			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(5)
		})

		it('shares one in-flight fan-out between two concurrent callers asking for the exact same bucket', async () => {
			MessageService.syncEnvelopes.mockResolvedValue({
				newMessages: [],
				changedMessages: [],
				vanishedMessages: [],
				stats: { unread: 0 },
			})

			const first = store.syncEnvelopes({ mailboxId: 'priority', query: 'not:starred' })
			const second = store.syncEnvelopes({ mailboxId: 'priority', query: 'not:starred' })

			await Promise.all([first, second])

			// 5 real mailboxes, ONE fan-out -- not 10 from two independent
			// fan-outs.
			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(5)
		})

		it('does NOT collapse two different buckets for the same virtual mailbox into one', async () => {
			MessageService.syncEnvelopes.mockResolvedValue({
				newMessages: [],
				changedMessages: [],
				vanishedMessages: [],
				stats: { unread: 0 },
			})

			const important = store.syncEnvelopes({ mailboxId: 'priority', query: 'is:pi-important' })
			const other = store.syncEnvelopes({ mailboxId: 'priority', query: 'is:pi-other' })

			await Promise.all([important, other])

			// 5 real mailboxes x 2 genuinely different buckets = 10, not
			// deduped down to 5.
			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(10)
		})

		it('fires a fresh fan-out for a later call once the first has resolved', async () => {
			MessageService.syncEnvelopes.mockResolvedValue({
				newMessages: [],
				changedMessages: [],
				vanishedMessages: [],
				stats: { unread: 0 },
			})

			await store.syncEnvelopes({ mailboxId: 'priority', query: 'not:starred' })
			await store.syncEnvelopes({ mailboxId: 'priority', query: 'not:starred' })

			// Unlike fetchMessage()'s cache, a sync has no "already done,
			// never again" shortcut -- a genuinely later, separate call
			// must still hit the network.
			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(10)
		})

		it('never dedupes a REAL mailbox\'s own sync -- only the virtual-mailbox fan-out entry point', async () => {
			// Two concurrent callers syncing the SAME real mailbox+query
			// are NOT collapsed into one: that mailbox's own
			// MailboxLockedException/pendingLockWaits coordination
			// already handles concurrent real-mailbox syncs, and
			// deduping here too would risk a retry chain awaiting its
			// own still-pending promise (see pendingUnifiedSyncs' own
			// comment).
			MessageService.syncEnvelopes.mockResolvedValue({
				newMessages: [],
				changedMessages: [],
				vanishedMessages: [],
				stats: { unread: 0 },
			})

			const first = store.syncEnvelopes({ mailboxId: 100, query: 'not:starred' })
			const second = store.syncEnvelopes({ mailboxId: 100, query: 'not:starred' })

			await Promise.all([first, second])

			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(2)
		})
	})

	describe('setEnvelopeImportant: toggleEnvelopeImportant/markEnvelopeImportantOrUnimportant update flag_important AND the tag together', () => {
		// Regression: both entry points used to call ONLY
		// addEnvelopeTag()/removeEnvelopeTag() -- the important badge
		// (Envelope.vue's isImportant(), which reads the tag) updated
		// instantly, but flag_important -- and therefore Priority Inbox
		// list membership -- didn't catch up until the next routine sync
		// read the IMAP keyword back, sometimes tens of seconds later.
		// NewMessagesClassifier already updates both together server-side
		// (flagMessage() + tagMessage()); these client entry points now do
		// too, via the shared setEnvelopeImportant().
		const importantTag = { id: 909, imapLabel: '$label1', displayName: 'Important', color: '#FF7A66' }

		function seedEnvelope(important, tagIds = []) {
			const envelope = { databaseId: 42, flags: { important }, tags: tagIds }
			store.envelopes[42] = envelope
			return envelope
		}

		it('toggleEnvelopeImportant on a not-yet-important message sets flag_important and adds the tag', async () => {
			const envelope = seedEnvelope(false, [])
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			MessageService.setEnvelopeTag.mockResolvedValue(importantTag)

			await store.toggleEnvelopeImportant(envelope)

			expect(envelope.flags.important).toBe(true)
			expect(MessageService.setEnvelopeFlags).toHaveBeenCalledWith(42, { $label1: true })
			expect(MessageService.setEnvelopeTag).toHaveBeenCalledWith(42, '$label1')
			expect(envelope.tags).toContain(importantTag.id)
		})

		it('toggleEnvelopeImportant on an already-important message clears flag_important and removes the tag', async () => {
			store.tags[importantTag.id] = importantTag
			const envelope = seedEnvelope(true, [importantTag.id])
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			MessageService.removeEnvelopeTag.mockResolvedValue(importantTag)

			await store.toggleEnvelopeImportant(envelope)

			expect(envelope.flags.important).toBe(false)
			expect(MessageService.setEnvelopeFlags).toHaveBeenCalledWith(42, { $label1: false })
			expect(MessageService.removeEnvelopeTag).toHaveBeenCalledWith(42, '$label1')
			expect(envelope.tags).not.toContain(importantTag.id)
		})

		it('markEnvelopeImportantOrUnimportant is a no-op when the message already matches the requested state', async () => {
			const envelope = seedEnvelope(false, [])

			await store.markEnvelopeImportantOrUnimportant({ envelope, addTag: false })

			expect(MessageService.setEnvelopeFlags).not.toHaveBeenCalled()
			expect(MessageService.setEnvelopeTag).not.toHaveBeenCalled()
			expect(MessageService.removeEnvelopeTag).not.toHaveBeenCalled()
		})

		it('markEnvelopeImportantOrUnimportant({ addTag: true }) sets flag_important and adds the tag together', async () => {
			const envelope = seedEnvelope(false, [])
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			MessageService.setEnvelopeTag.mockResolvedValue(importantTag)

			await store.markEnvelopeImportantOrUnimportant({ envelope, addTag: true })

			expect(envelope.flags.important).toBe(true)
			expect(MessageService.setEnvelopeFlags).toHaveBeenCalledWith(42, { $label1: true })
			expect(MessageService.setEnvelopeTag).toHaveBeenCalledWith(42, '$label1')
		})

		it('reverts the optimistic flag_important change if setEnvelopeFlags fails', async () => {
			const envelope = seedEnvelope(false, [])
			MessageService.setEnvelopeFlags.mockRejectedValue(new Error('network error'))
			MessageService.setEnvelopeTag.mockResolvedValue(importantTag)

			await expect(store.toggleEnvelopeImportant(envelope)).rejects.toThrow('network error')

			expect(envelope.flags.important).toBe(false)
		})

		// Phase 3 of the unified optimistic-update plan (see
		// /home/ktogias/.claude/plans/generic-hugging-fern.md): once the
		// important tag's id is already known locally (as it is here --
		// store.tags[importantTag.id] is seeded up front, same as the
		// "already-important" test above), the badge (tags) and Priority
		// Inbox list membership (reclassifyFlagBucketsMutation) must both
		// update in the same synchronous tick as the click, not wait on
		// either network call to resolve -- the exact "click -> round
		// trip -> badge -> round trip -> list membership" lag reported
		// live.
		it('updates the tag and reclassifies list membership synchronously, before any network call resolves', async () => {
			store.tags[importantTag.id] = importantTag
			const account13 = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
			const envelope = seedEnvelope(false, [])
			envelope.mailboxId = 11
			store.mailboxes[11].envelopeLists['is:pi-important'] = []

			const reclassifySpy = vi.spyOn(store, 'reclassifyFlagBucketsMutation')
			// Never-resolving promises: if the tag/list update depended on
			// either settling, this assertion would run before either
			// mutation had a chance to happen.
			MessageService.setEnvelopeFlags.mockReturnValue(new Promise(() => {}))
			MessageService.setEnvelopeTag.mockReturnValue(new Promise(() => {}))

			store.toggleEnvelopeImportant(envelope)
			await Promise.resolve() // let the synchronous portion run before the still-pending awaits

			expect(envelope.tags).toContain(importantTag.id)
			expect(reclassifySpy).toHaveBeenCalled()
			expect(store.mailboxes[11].envelopeLists['is:pi-important']).toContain(42)
		})

		// The reported live inversion: a copy whose flag_important is set
		// (classifier keyword round-tripped via IMAP) but whose user-wide
		// $label1 tag was never created. A tag-based current-state read
		// would compute "not important" and try to MARK it on toggle --
		// the exact opposite of the user's intent to unmark the badge
		// they're looking at. The flag is the source of truth now.
		it('toggleEnvelopeImportant unmarks a flag-important message even when no user-wide tag exists', async () => {
			store.tags[importantTag.id] = importantTag
			const envelope = seedEnvelope(true, []) // flag set, NO tag
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			MessageService.removeEnvelopeTag.mockResolvedValue(importantTag)

			await store.toggleEnvelopeImportant(envelope)

			expect(envelope.flags.important).toBe(false)
			expect(MessageService.setEnvelopeFlags).toHaveBeenCalledWith(42, { $label1: false })
		})

		it('setEnvelopeImportant is a no-op when the flag already matches, regardless of tag state', async () => {
			store.tags[importantTag.id] = importantTag
			const envelope = seedEnvelope(true, []) // flag set, NO tag

			await store.setEnvelopeImportant(envelope, true)

			expect(MessageService.setEnvelopeFlags).not.toHaveBeenCalled()
			expect(MessageService.setEnvelopeTag).not.toHaveBeenCalled()
		})

		it('reverts both the flag and the tag together if the network calls fail, once the tag was applied optimistically', async () => {
			store.tags[importantTag.id] = importantTag
			const envelope = seedEnvelope(false, [])
			MessageService.setEnvelopeFlags.mockRejectedValue(new Error('network error'))
			MessageService.setEnvelopeTag.mockRejectedValue(new Error('network error'))

			await expect(store.toggleEnvelopeImportant(envelope)).rejects.toThrow('network error')

			expect(envelope.flags.important).toBe(false)
			expect(envelope.tags).not.toContain(importantTag.id)
		})
	})

	describe('interaction priority: user actions over background sync', () => {
		// A direct user action (opening a message, switching folders,
		// starring/deleting/flagging, ...) arms a short priority window
		// during which syncWatchedMailboxes() steps out of the way instead
		// of competing for the FPM pool and the main thread.
		let account13
		let account17

		beforeEach(() => {
			account13 = { id: 13 }
			account17 = { id: 17 }
			store.addAccountMutation(account13)
			store.addAccountMutation(account17)
		})

		it('toggleEnvelopeFlagged arms interaction priority immediately, synchronously', () => {
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			expect(store.isInteractionPriorityActive()).toBe(false)

			store.toggleEnvelopeFlagged({ databaseId: 1, flags: { flagged: false } })

			expect(store.isInteractionPriorityActive()).toBe(true)
		})

		it('deleteMessage arms interaction priority immediately, synchronously', () => {
			MessageService.deleteMessage.mockResolvedValue({})
			expect(store.isInteractionPriorityActive()).toBe(false)

			store.deleteMessage({ id: 1 })

			expect(store.isInteractionPriorityActive()).toBe(true)
		})

		// Reported live: a duplicate/stale delete for a message the undo
		// window had already deferred once ended up hitting the server a
		// second time after the first one had already succeeded --
		// MessagesController::destroy() returns 403 (not 404) exactly and
		// only when the message row is already gone. That's the outcome
		// the user actually wanted; treating it as a hard failure
		// (resurrecting the envelope, showing "Could not delete message")
		// was actively wrong.
		it('deleteMessage treats a 403 (already deleted) as success, not an error', async () => {
			store.addMailboxMutation({ account: account13, mailbox: { databaseId: 11, accountId: 13, name: 'INBOX' } })
			MessageService.deleteMessage.mockRejectedValue({ response: { status: 403 } })
			store.addEnvelopesMutation({ envelopes: [{ databaseId: 1, mailboxId: 11, dateInt: 1, flags: {} }] })

			await expect(store.deleteMessage({ id: 1 })).resolves.toBeUndefined()

			// Must not resurrect the envelope the optimistic removal
			// already (correctly) got rid of.
			expect(store.getEnvelope(1)).toBeUndefined()
		})

		it('deleteMessage still surfaces a genuine failure (not 403)', async () => {
			store.addMailboxMutation({ account: account13, mailbox: { databaseId: 11, accountId: 13, name: 'INBOX' } })
			MessageService.deleteMessage.mockRejectedValue({ response: { status: 500 } })
			store.addEnvelopesMutation({ envelopes: [{ databaseId: 1, mailboxId: 11, dateInt: 1, flags: {} }] })

			// Unlike the 403 case above, a genuine failure must still
			// reject -- so callers' own error handling (the "Could not
			// delete message" toast) keeps firing for actual failures.
			await expect(store.deleteMessage({ id: 1 })).rejects.toBeDefined()
		})

		// Phase 5 (see /home/ktogias/.claude/plans/generic-hugging-fern.md):
		// this.getEnvelope(id) used to be called INSIDE the catch block,
		// after the optimistic removal above had already deleted it from
		// this.envelopes -- always returning undefined on a genuine
		// failure, silently skipping the revert. Fixed by capturing the
		// envelope before removing it.
		it('actually restores the envelope on a genuine failure, not just rejects', async () => {
			store.addMailboxMutation({ account: account13, mailbox: { databaseId: 11, accountId: 13, name: 'INBOX' } })
			MessageService.deleteMessage.mockRejectedValue({ response: { status: 500 } })
			MessageService.fetchEnvelope.mockResolvedValue({ databaseId: 1, mailboxId: 11, flags: {} })
			store.addEnvelopesMutation({ envelopes: [{ databaseId: 1, mailboxId: 11, dateInt: 1, flags: {} }] })

			await expect(store.deleteMessage({ id: 1 })).rejects.toBeDefined()

			expect(store.getEnvelope(1)).toBeDefined()
		})

		// The whole Thread family (deleteThread/moveThread/snoozeThread/
		// unSnoozeThread) was missing this call entirely -- unlike every
		// singular-message equivalent above, syncWatchedMailboxes()'s
		// background poller had no signal that one of these had just been
		// requested, and could race the optimistic removeEnvelopeMutation()
		// with its own priority-inbox refresh, reinstating the
		// just-removed envelope from a stale response. Confirmed live:
		// deleting a thread from Priority Inbox on a slower connection
		// sometimes reappeared seconds later.
		it('deleteThread arms interaction priority immediately, synchronously', () => {
			ThreadService.deleteThread.mockResolvedValue({})
			expect(store.isInteractionPriorityActive()).toBe(false)

			store.deleteThread({ envelope: { databaseId: 1 } })

			expect(store.isInteractionPriorityActive()).toBe(true)
		})

		// Same reasoning as deleteMessage()'s own 403 test above --
		// ThreadController::delete() returns 403 only and exactly when
		// the message is already gone.
		it('deleteThread treats a 403 (already deleted) as success, not an error', async () => {
			ThreadService.deleteThread.mockRejectedValue({ response: { status: 403 } })
			const envelope = { databaseId: 1, mailboxId: 11, dateInt: 1, flags: {} }

			await expect(store.deleteThread({ envelope })).resolves.toBeUndefined()
		})

		it('deleteThread still surfaces a genuine failure (not 403)', async () => {
			ThreadService.deleteThread.mockRejectedValue({ response: { status: 500 } })
			const envelope = { databaseId: 1, mailboxId: 11, dateInt: 1, flags: {} }

			await expect(store.deleteThread({ envelope })).rejects.toBeDefined()
		})

		it('moveThread arms interaction priority immediately, synchronously', () => {
			ThreadService.moveThread.mockResolvedValue({})
			expect(store.isInteractionPriorityActive()).toBe(false)

			store.moveThread({ envelope: { databaseId: 1 }, destMailboxId: 2 })

			expect(store.isInteractionPriorityActive()).toBe(true)
		})

		it('snoozeThread arms interaction priority immediately, synchronously', () => {
			ThreadService.snoozeThread.mockResolvedValue({})
			expect(store.isInteractionPriorityActive()).toBe(false)

			store.snoozeThread({ envelope: { databaseId: 1 }, unixTimestamp: 12345, destMailboxId: 2 })

			expect(store.isInteractionPriorityActive()).toBe(true)
		})

		it('unSnoozeThread arms interaction priority immediately, synchronously', () => {
			ThreadService.unSnoozeThread.mockResolvedValue({})
			expect(store.isInteractionPriorityActive()).toBe(false)

			store.unSnoozeThread({ envelope: { databaseId: 1 } })

			expect(store.isInteractionPriorityActive()).toBe(true)
		})

		it('syncWatchedMailboxes skips network work but still signals local housekeeping while interaction priority is active', async () => {
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 5, specialRole: 'inbox' },
			})
			store.setInteractionPriorityMutation()
			const timestampSpy = vi.spyOn(store, 'updateSyncTimestamp')

			await store.syncWatchedMailboxes()

			expect(timestampSpy).toHaveBeenCalledOnce()
			expect(MessageService.syncEnvelopes).not.toHaveBeenCalled()
		})

		it('syncWatchedMailboxes limits how many mailboxes sync concurrently', async () => {
			// 5 inbox-role mailboxes, always eligible for background sync,
			// spread across 2 accounts.
			const mailboxIds = [5, 10, 14, 16, 39]
			mailboxIds.forEach((id, i) => {
				store.addMailboxMutation({
					account: i % 2 === 0 ? account13 : account17,
					mailbox: { name: `INBOX-${id}`, databaseId: id, specialRole: 'inbox' },
				})
			})

			let concurrent = 0
			let maxConcurrent = 0
			const pendingResolvers = []
			MessageService.syncEnvelopes.mockImplementation(() => new Promise((resolve) => {
				concurrent++
				maxConcurrent = Math.max(maxConcurrent, concurrent)
				pendingResolvers.push(() => {
					concurrent--
					resolve({ newMessages: [], changedMessages: [], vanishedMessages: [], stats: { unread: 0 } })
				})
			}))

			const syncPromise = store.syncWatchedMailboxes()

			// Wait for however many microtask hops it takes (fetchEnvelopes'
			// own conditional call, handleHttpAuthErrors, the concurrency
			// pool's workers, ...) for every worker that's going to start
			// immediately to have actually started, without resolving any
			// of them yet.
			await vi.waitFor(() => {
				if (pendingResolvers.length < 3) {
					throw new Error(`only ${pendingResolvers.length} mailboxes have started syncing so far`)
				}
			})

			// Mirrors WATCHED_SYNC_CONCURRENCY in actions.js: only that many
			// of the 5 eligible mailboxes may be mid-request at once, not
			// all 5 at once like the previous unbounded Promise.all fan-out.
			expect(pendingResolvers.length).toBe(3)
			expect(maxConcurrent).toBe(3)

			// Resolve the first wave; the remaining 2 mailboxes should then
			// start, keeping concurrency at or under the same limit.
			pendingResolvers.splice(0).forEach((resolve) => resolve())

			await vi.waitFor(() => {
				if (pendingResolvers.length < 2) {
					throw new Error(`only ${pendingResolvers.length} mailboxes have started syncing so far`)
				}
			})

			expect(maxConcurrent).toBeLessThanOrEqual(3)

			pendingResolvers.splice(0).forEach((resolve) => resolve())
			await syncPromise

			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(5)
		})
	})

	// Phase 4 of the unified optimistic-update plan (see
	// /home/ktogias/.claude/plans/generic-hugging-fern.md): moveThread()'s
	// own revert-on-failure (re-adding the removed envelope) now confirms
	// against an authoritative fetch first, same reasoning as the flag-
	// based actions tested elsewhere in this file.
	describe('moveThread: reconciles before reverting on a failed move', () => {
		it('does not re-add the envelope if reconciliation confirms the move actually landed', async () => {
			ThreadService.moveThread.mockRejectedValue(new Error('timed out'))
			MessageService.fetchEnvelope.mockResolvedValue({ mailboxId: 2 })
			const envelope = { databaseId: 1, accountId: 13, mailboxId: 1 }
			const account13 = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account13)
			store.addMailboxMutation({ account: account13, mailbox: { name: 'INBOX', databaseId: 1, accountId: 13 } })

			await store.moveThread({ envelope, destMailboxId: 2 })

			expect(store.envelopes[1]).toBeUndefined()
		})

		it('re-adds the envelope if reconciliation confirms the move genuinely never landed', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			ThreadService.moveThread.mockRejectedValue(new Error('network error'))
			MessageService.fetchEnvelope.mockResolvedValue({ mailboxId: 1 })
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({ account, mailbox: { name: 'INBOX', databaseId: 1, accountId: 13 } })
			const envelope = { databaseId: 1, accountId: 13, mailboxId: 1, dateInt: 1, flags: {}, tags: [] }
			store.addEnvelopesMutation({ envelopes: [envelope], addToUnifiedMailboxes: false })

			await expect(store.moveThread({ envelope, destMailboxId: 2 })).rejects.toThrow('network error')

			expect(store.envelopes[1]).toBeDefined()
		})
	})

	// Phase 5 of the unified optimistic-update plan (see the same plan
	// file): moveMessage()/snoozeMessage()/unSnoozeMessage()/
	// snoozeThread()/unSnoozeThread() used to mutate the store only
	// AFTER their own network call already succeeded -- unlike
	// deleteMessage()/deleteThread()/toggleEnvelopeJunk()/moveThread(),
	// which all remove optimistically first. Extended the same pattern
	// (optimistic removal + reconcile-before-revert) to these too, now
	// that Phases 1-4 give it something correct to rely on.
	describe('moveMessage/snoozeMessage/unSnoozeMessage: now genuinely optimistic', () => {
		function seedEnvelope(overrides = {}) {
			const account13 = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account13)
			store.addMailboxMutation({ account: account13, mailbox: { name: 'INBOX', databaseId: 1, accountId: 13 } })
			const envelope = { databaseId: 1, accountId: 13, mailboxId: 1, dateInt: 1, flags: {}, tags: [], ...overrides }
			store.addEnvelopesMutation({ envelopes: [envelope], addToUnifiedMailboxes: false })
			return envelope
		}

		it('moveMessage removes the envelope immediately, before the network call resolves', async () => {
			seedEnvelope()
			MessageService.moveMessage.mockReturnValue(new Promise(() => {}))

			store.moveMessage({ id: 1, destMailboxId: 2 })
			await Promise.resolve()

			expect(store.envelopes[1]).toBeUndefined()
		})

		it('moveMessage does not re-add the envelope if reconciliation confirms the move landed', async () => {
			seedEnvelope()
			MessageService.moveMessage.mockRejectedValue(new Error('timed out'))
			MessageService.fetchEnvelope.mockResolvedValue({ mailboxId: 2 })

			await store.moveMessage({ id: 1, destMailboxId: 2 })

			expect(store.envelopes[1]).toBeUndefined()
		})

		it('moveMessage re-adds the envelope if reconciliation confirms the move genuinely never landed', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			seedEnvelope()
			MessageService.moveMessage.mockRejectedValue(new Error('network error'))
			MessageService.fetchEnvelope.mockResolvedValue({ mailboxId: 1 })

			await expect(store.moveMessage({ id: 1, destMailboxId: 2 })).rejects.toThrow('network error')

			expect(store.envelopes[1]).toBeDefined()
		})

		it('snoozeMessage re-adds the envelope if reconciliation confirms the snooze genuinely never landed', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			seedEnvelope()
			MessageService.snoozeMessage.mockRejectedValue(new Error('network error'))
			MessageService.fetchEnvelope.mockResolvedValue({ mailboxId: 1 })

			await expect(store.snoozeMessage({ id: 1, unixTimestamp: 12345, destMailboxId: 2 })).rejects.toThrow('network error')

			expect(store.envelopes[1]).toBeDefined()
		})

		it('unSnoozeMessage re-adds the envelope if reconciliation confirms it never actually left the snooze mailbox', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			// Already sitting in "the snooze mailbox" (mailboxId 1, for
			// this test) before unsnoozing -- there's no separate
			// caller-known destination the way move/snooze have one.
			seedEnvelope()
			MessageService.unSnoozeMessage.mockRejectedValue(new Error('network error'))
			MessageService.fetchEnvelope.mockResolvedValue({ mailboxId: 1 })

			await expect(store.unSnoozeMessage({ id: 1 })).rejects.toThrow('network error')

			expect(store.envelopes[1]).toBeDefined()
		})

		it('unSnoozeMessage does not re-add the envelope once reconciliation confirms it actually left', async () => {
			seedEnvelope()
			MessageService.unSnoozeMessage.mockRejectedValue(new Error('timed out'))
			MessageService.fetchEnvelope.mockResolvedValue({ mailboxId: 99 })

			await store.unSnoozeMessage({ id: 1 })

			expect(store.envelopes[1]).toBeUndefined()
		})
	})

	describe('snoozeThread/unSnoozeThread: now genuinely optimistic', () => {
		function seedEnvelope(overrides = {}) {
			const account13 = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account13)
			store.addMailboxMutation({ account: account13, mailbox: { name: 'INBOX', databaseId: 1, accountId: 13 } })
			const envelope = { databaseId: 1, accountId: 13, mailboxId: 1, dateInt: 1, flags: {}, tags: [], ...overrides }
			store.addEnvelopesMutation({ envelopes: [envelope], addToUnifiedMailboxes: false })
			return envelope
		}

		it('snoozeThread removes the envelope immediately, before the network call resolves', async () => {
			const envelope = seedEnvelope()
			ThreadService.snoozeThread.mockReturnValue(new Promise(() => {}))

			store.snoozeThread({ envelope, unixTimestamp: 12345, destMailboxId: 2 })
			await Promise.resolve()

			expect(store.envelopes[1]).toBeUndefined()
		})

		it('snoozeThread re-adds the envelope if reconciliation confirms the snooze genuinely never landed', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const envelope = seedEnvelope()
			ThreadService.snoozeThread.mockRejectedValue(new Error('network error'))
			MessageService.fetchEnvelope.mockResolvedValue({ mailboxId: 1 })

			await expect(store.snoozeThread({ envelope, unixTimestamp: 12345, destMailboxId: 2 })).rejects.toThrow('network error')

			expect(store.envelopes[1]).toBeDefined()
		})

		it('unSnoozeThread re-adds the envelope if reconciliation confirms it never actually left the snooze mailbox', async () => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const envelope = seedEnvelope()
			ThreadService.unSnoozeThread.mockRejectedValue(new Error('network error'))
			MessageService.fetchEnvelope.mockResolvedValue({ mailboxId: 1 })

			await expect(store.unSnoozeThread({ envelope })).rejects.toThrow('network error')

			expect(store.envelopes[1]).toBeDefined()
		})
	})

	// Phase 4's other half (see the same plan file): a normal sync merge
	// happening to observe the server agreeing confirms an entry for
	// free (tested implicitly throughout the recentLocalChanges/tags
	// tests above), but nothing else ever independently checks a
	// still-unconfirmed entry before its own grace window closes. This
	// active sweep does, piggybacked onto syncWatchedMailboxes()'s own
	// tick rather than tested through that whole call chain.
	describe('reconcileNearExpiryLocalChanges: active confirmation before a grace window closes', () => {
		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
		})

		it('actively confirms a not-yet-confirmed entry once it is near expiry, and applies the authoritative answer', async () => {
			vi.useFakeTimers()
			try {
				store.addEnvelopesMutation({
					envelopes: [{ databaseId: 950, mailboxId: 11, dateInt: 1, flags: { flagged: false }, tags: [] }],
					addToUnifiedMailboxes: false,
				})
				store.flagEnvelopeMutation({ envelope: store.envelopes[950], flag: 'flagged', value: true })

				// Nothing ever independently confirmed this one (no sync
				// merge happened to observe it) -- past RECENT_FLAG_CHANGE_GRACE_MS
				// minus the sweep's own "due soon" window, so it's now due
				// for an active check.
				vi.advanceTimersByTime(80 * 1000)

				// The server, it turns out, never actually got the change.
				MessageService.fetchEnvelope.mockResolvedValue({ databaseId: 950, mailboxId: 11, flags: { flagged: false }, tags: [] })

				await reconcileNearExpiryLocalChanges(store)

				expect(MessageService.fetchEnvelope.mock.calls.some((call) => call[1] === 950)).toBe(true)
				expect(store.envelopes[950].flags.flagged).toBe(false)
			} finally {
				vi.useRealTimers()
			}
		})

		it('does not actively check an entry a normal sync already confirmed', async () => {
			vi.useFakeTimers()
			try {
				store.addEnvelopesMutation({
					envelopes: [{ databaseId: 951, mailboxId: 11, dateInt: 1, flags: { flagged: false }, tags: [] }],
					addToUnifiedMailboxes: false,
				})
				store.flagEnvelopeMutation({ envelope: store.envelopes[951], flag: 'flagged', value: true })

				// A routine sync merge independently observes the server
				// already agreeing -- marks the entry confirmed for free.
				store.updateEnvelopeMutation({
					envelope: { databaseId: 951, mailboxId: 11, flags: { flagged: true }, tags: [] },
				})

				vi.advanceTimersByTime(80 * 1000)

				await reconcileNearExpiryLocalChanges(store)

				expect(MessageService.fetchEnvelope).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it('does not check an entry that is not near expiry yet', async () => {
			vi.useFakeTimers()
			try {
				store.addEnvelopesMutation({
					envelopes: [{ databaseId: 952, mailboxId: 11, dateInt: 1, flags: { flagged: false }, tags: [] }],
					addToUnifiedMailboxes: false,
				})
				store.flagEnvelopeMutation({ envelope: store.envelopes[952], flag: 'flagged', value: true })

				// Freshly set -- nowhere near its own 120s expiry yet.
				await reconcileNearExpiryLocalChanges(store)

				expect(MessageService.fetchEnvelope).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})
	})

	// Moved out of UndoableActionMixin.js's own component-local data()
	// specifically so it's shared state, not per-component-instance --
	// see pendingRemovals' own comment in mainStore.js for the live bug
	// this fixes (a message deleted from one simultaneously-rendered
	// Priority Inbox section stayed visible in every other one for the
	// whole undo window).
	describe('pendingRemovals: shared undo-hide bookkeeping', () => {
		it('isPendingRemoval is false until begin, true after, false again after end', () => {
			expect(store.isPendingRemoval(1)).toBe(false)

			store.beginPendingRemoval([1])
			expect(store.isPendingRemoval(1)).toBe(true)

			store.endPendingRemoval([1])
			expect(store.isPendingRemoval(1)).toBe(false)
		})

		it('tracks multiple ids independently', () => {
			store.beginPendingRemoval([1, 2])
			expect(store.isPendingRemoval(1)).toBe(true)
			expect(store.isPendingRemoval(2)).toBe(true)

			store.endPendingRemoval([1])
			expect(store.isPendingRemoval(1)).toBe(false)
			expect(store.isPendingRemoval(2)).toBe(true)
		})
	})

	describe('fetchMessage: concurrent calls for the same id are deduped', () => {
		// Thread.vue prefetches the clicked message's body in parallel
		// with the thread listing; ThreadEnvelope.vue's own fetchMessage()
		// call for the same id can land within milliseconds of that,
		// before the prefetch's network request has resolved -- too soon
		// for the `this.messages[id]` cache check alone to catch it.
		it('only fires one network request when called twice before the first resolves', async () => {
			let resolveFetch
			MessageService.fetchMessage.mockReturnValue(new Promise((resolve) => {
				resolveFetch = resolve
			}))

			const firstCall = store.fetchMessage(42)
			const secondCall = store.fetchMessage(42)

			expect(MessageService.fetchMessage).toHaveBeenCalledTimes(1)

			resolveFetch({ databaseId: 42, subject: 'Hello' })
			const [first, second] = await Promise.all([firstCall, secondCall])

			expect(first).toEqual(second)
			expect(MessageService.fetchMessage).toHaveBeenCalledTimes(1)
		})

		it('fires a fresh request for a later call once the first has resolved', async () => {
			MessageService.fetchMessage.mockResolvedValue({ databaseId: 42, subject: 'Hello' })

			await store.fetchMessage(42)
			// Already cached in store.messages -- no second network call.
			await store.fetchMessage(42)

			expect(MessageService.fetchMessage).toHaveBeenCalledTimes(1)
		})

		it('passes an abort signal so a network-level hang cannot outlive the timeout', async () => {
			// The promise gates ThreadEnvelope's loading skeleton AND is
			// shared through the dedup map -- a request hung at the
			// network level (no HTTP error ever arrives) froze every
			// later open of the same message on the skeleton for the
			// tab's lifetime (observed live, thread 119827). The signal
			// makes axios abort it after the bound.
			MessageService.fetchMessage.mockResolvedValue({ databaseId: 42 })

			await store.fetchMessage(42)

			expect(MessageService.fetchMessage).toHaveBeenCalledWith(42, { signal: expect.any(AbortSignal) })
		})

		it('a rejected request clears the dedup slot so a retry fires a fresh request', async () => {
			MessageService.fetchMessage.mockRejectedValueOnce(new Error('canceled'))

			await expect(store.fetchMessage(42)).rejects.toThrow('canceled')

			MessageService.fetchMessage.mockResolvedValue({ databaseId: 42, subject: 'Hello' })
			const message = await store.fetchMessage(42)

			expect(message).toEqual({ databaseId: 42, subject: 'Hello' })
			expect(MessageService.fetchMessage).toHaveBeenCalledTimes(2)
		})
	})

	describe('fetchMessage: a failed SPECULATIVE attempt cools down instead of being retried on every call', () => {
		// Confirmed live via a Firefox Profiler + console-log capture
		// (2026-07-21): under heavy server-side load, a couple of envelope
		// ids kept getting reported as newly-added by successive routine
		// sync ticks, each report re-firing the open-thread proactive body
		// prefetch for the SAME id -- and since a failed speculative fetch
		// was never cached in any form, every one of those repeats fired a
		// brand-new network request, piling doomed 403/404s onto the
		// already-overloaded mail-pool workers. A short cooldown after a
		// speculative failure breaks that without touching a real fetch.
		it('does not retry the same id speculatively again while the cooldown is active', async () => {
			MessageService.fetchMessage.mockRejectedValueOnce(new Error('not found'))
			await expect(store.fetchMessage(90020, { speculative: true })).rejects.toThrow('not found')

			const result = await store.fetchMessage(90020, { speculative: true })

			expect(result).toBeUndefined()
			expect(MessageService.fetchMessage).toHaveBeenCalledTimes(1)
		})

		it('still fetches fresh for a REAL (non-speculative) call, even right after a speculative failure for the same id', async () => {
			MessageService.fetchMessage.mockRejectedValueOnce(new Error('not found'))
			await expect(store.fetchMessage(90021, { speculative: true })).rejects.toThrow('not found')

			MessageService.fetchMessage.mockResolvedValue({ databaseId: 90021, subject: 'Real open' })
			const message = await store.fetchMessage(90021)

			expect(message).toEqual({ databaseId: 90021, subject: 'Real open' })
			expect(MessageService.fetchMessage).toHaveBeenCalledTimes(2)
		})

		it('retries again once the cooldown window has passed', async () => {
			vi.useFakeTimers()
			MessageService.fetchMessage.mockRejectedValueOnce(new Error('not found'))
			await expect(store.fetchMessage(90022, { speculative: true })).rejects.toThrow('not found')

			vi.advanceTimersByTime(30 * 1000 + 1)
			MessageService.fetchMessage.mockResolvedValue({ databaseId: 90022, subject: 'Retried' })
			const message = await store.fetchMessage(90022, { speculative: true })

			expect(message).toEqual({ databaseId: 90022, subject: 'Retried' })
			expect(MessageService.fetchMessage).toHaveBeenCalledTimes(2)
			vi.useRealTimers()
		})
	})

	describe('fetchThread: concurrent calls for the same id are deduped', () => {
		// Envelope.vue's hover prefetch and Thread.vue's own open-thread
		// call independently fetch the same thread id whenever a hover
		// lands just before a click (the common case). Without dedup,
		// whichever of the two redundant requests settled LAST decided
		// the outcome -- Thread.vue's own catch block documents the
		// resulting live symptom: an already-loaded thread flipping to
		// "Δεν βρέθηκε" because the OTHER, now-redundant request happened
		// to reject after the first had already succeeded.
		let threadEnvelope

		beforeEach(() => {
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
			threadEnvelope = { databaseId: 119855, mailboxId: 11 }
		})

		it('only fires one network request when called twice before the first resolves', async () => {
			let resolveFetch
			MessageService.fetchThread.mockReturnValue(new Promise((resolve) => {
				resolveFetch = resolve
			}))

			const firstCall = store.fetchThread(119855)
			const secondCall = store.fetchThread(119855)

			expect(MessageService.fetchThread).toHaveBeenCalledTimes(1)

			resolveFetch([threadEnvelope])
			const [first, second] = await Promise.all([firstCall, secondCall])

			expect(first).toEqual(second)
			expect(MessageService.fetchThread).toHaveBeenCalledTimes(1)
		})

		it('fires a fresh request for a later call once the first has resolved', async () => {
			MessageService.fetchThread.mockResolvedValue([threadEnvelope])

			await store.fetchThread(119855)
			await store.fetchThread(119855)

			// Unlike fetchMessage(), a thread has no "already fetched,
			// never refetch" cache -- new replies can arrive, so a
			// SEPARATE (non-concurrent) call must still hit the network.
			expect(MessageService.fetchThread).toHaveBeenCalledTimes(2)
		})

		it('passes an abort signal so a network-level hang cannot outlive the timeout', async () => {
			MessageService.fetchThread.mockResolvedValue([threadEnvelope])

			await store.fetchThread(119855)

			expect(MessageService.fetchThread).toHaveBeenCalledWith(119855, { signal: expect.any(AbortSignal) })
		})

		it('a rejected request clears the dedup slot so a retry fires a fresh request', async () => {
			MessageService.fetchThread.mockRejectedValueOnce(new Error('boom'))

			await expect(store.fetchThread(119855)).rejects.toThrow('boom')

			MessageService.fetchThread.mockResolvedValue([threadEnvelope])
			const thread = await store.fetchThread(119855)

			expect(thread).toEqual([threadEnvelope])
			expect(MessageService.fetchThread).toHaveBeenCalledTimes(2)
		})

		it('a refetch with byte-identical data keeps the same envelope object reference', async () => {
			// Confirmed live: a thread gets refetched repeatedly (hover/
			// viewport prefetch, and a periodic refresh of whichever
			// thread is open) -- every ~15-30s in one capture. Rebuilding
			// every message into a brand new object on every refetch, even
			// when the server reported byte-identical flags, made any
			// reactive consumer keyed off object identity (e.g. the
			// Favorites column, built from
			// envelopeLists['is:starred'].map(id => this.envelopes[id]))
			// see a "changed" dependency and re-render for no real reason
			// -- observed live as a fluctuating Favorites list.
			MessageService.fetchThread.mockResolvedValue([{ ...threadEnvelope, flags: { flagged: true } }])
			await store.fetchThread(119855)
			const firstReference = store.envelopes[119855]

			MessageService.fetchThread.mockResolvedValue([{ ...threadEnvelope, flags: { flagged: true } }])
			await store.fetchThread(119855)

			expect(store.envelopes[119855]).toBe(firstReference)
		})

		it('a refetch with genuinely different data still rebuilds the envelope', async () => {
			MessageService.fetchThread.mockResolvedValue([{ ...threadEnvelope, flags: { flagged: false } }])
			await store.fetchThread(119855)
			const firstReference = store.envelopes[119855]

			MessageService.fetchThread.mockResolvedValue([{ ...threadEnvelope, flags: { flagged: true } }])
			await store.fetchThread(119855)

			expect(store.envelopes[119855]).not.toBe(firstReference)
			expect(store.envelopes[119855].flags.flagged).toBe(true)
		})
	})

	describe('fetchThread: speculative calls cache-short-circuit, non-speculative never does', () => {
		// Unlike fetchMessage(), a thread previously had NO cache check at
		// all -- every speculative call (hover/viewport/neighbor prefetch)
		// re-requested an already-fully-known thread every time it fired.
		// A non-speculative call (the real open) must keep re-fetching
		// unconditionally, exactly as the describe block above already
		// covers -- these tests are specifically about the NEW
		// speculative-only short-circuit.
		beforeEach(() => {
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
			store.envelopes[100] = { databaseId: 100, mailboxId: 11, thread: [100, 101] }
			store.envelopes[101] = { databaseId: 101, mailboxId: 11 }
		})

		it('does not call the service at all when every thread member is already known', async () => {
			const result = await store.fetchThread(100, { speculative: true })

			expect(MessageService.fetchThread).not.toHaveBeenCalled()
			expect(result).toEqual([store.envelopes[100], store.envelopes[101]])
		})

		it('still fetches when the cached thread is only partially known', async () => {
			store.envelopes[100].thread = [100, 101, 102] // 102 not in store.envelopes
			MessageService.fetchThread.mockResolvedValue([{ databaseId: 100, mailboxId: 11 }])

			await store.fetchThread(100, { speculative: true })

			expect(MessageService.fetchThread).toHaveBeenCalledTimes(1)
		})

		it('still fetches when nothing is cached yet for this id', async () => {
			MessageService.fetchThread.mockResolvedValue([{ databaseId: 200, mailboxId: 11 }])

			await store.fetchThread(200, { speculative: true })

			expect(MessageService.fetchThread).toHaveBeenCalledTimes(1)
		})

		it('a non-speculative call always fetches fresh, even with a fully-known cached thread', async () => {
			MessageService.fetchThread.mockResolvedValue([{ databaseId: 100, mailboxId: 11 }])

			await store.fetchThread(100)

			expect(MessageService.fetchThread).toHaveBeenCalledTimes(1)
		})
	})

	describe('cancelSpeculativeFetchesExcept: aborting stale prefetches on real navigation', () => {
		// Confirmed live (2026-07-12, thread 926521): viewport-prefetch
		// firing for ~20 messages scrolled past in Priority Inbox
		// saturated the 3-worker mailwrite pool for over two minutes,
		// queueing a real, user-clicked message open behind them for
		// ~31s on top of its own ~25s execution. A speculative fetch
		// that hasn't resolved by the time the user opens something else
		// is provably wasted work from that point on -- aborting it
		// frees the worker/IMAP connection immediately.
		// Every test here uses a controllable (not eternally-pending)
		// mock promise and awaits it to completion before finishing, so
		// pendingMessageFetches/pendingThreadFetches and the speculative
		// controller maps -- all module-level, not reset between tests --
		// never leak a dangling entry into a later test that happens to
		// reuse the same id.
		it('aborts a speculative fetchMessage for a different id', async () => {
			let rejectFetch
			MessageService.fetchMessage.mockReturnValue(new Promise((resolve, reject) => {
				rejectFetch = reject
			}))

			const fetchPromise = store.fetchMessage(90001, { speculative: true }).catch(() => {})
			const signal = MessageService.fetchMessage.mock.calls[0][1].signal
			expect(signal.aborted).toBe(false)

			store.cancelSpeculativeFetchesExcept(999)

			expect(signal.aborted).toBe(true)

			rejectFetch(new Error('aborted'))
			await fetchPromise
		})

		it('does NOT abort the speculative fetch for the id actually being opened', async () => {
			let resolveFetch
			MessageService.fetchMessage.mockReturnValue(new Promise((resolve) => {
				resolveFetch = resolve
			}))

			const fetchPromise = store.fetchMessage(90002, { speculative: true })
			const signal = MessageService.fetchMessage.mock.calls[0][1].signal

			store.cancelSpeculativeFetchesExcept(90002)

			expect(signal.aborted).toBe(false)

			resolveFetch({ databaseId: 90002 })
			await fetchPromise
		})

		it('never touches a non-speculative fetch', async () => {
			let resolveFetch
			MessageService.fetchMessage.mockReturnValue(new Promise((resolve) => {
				resolveFetch = resolve
			}))

			const fetchPromise = store.fetchMessage(90003)
			const signal = MessageService.fetchMessage.mock.calls[0][1].signal

			store.cancelSpeculativeFetchesExcept(999)

			expect(signal.aborted).toBe(false)

			resolveFetch({ databaseId: 90003 })
			await fetchPromise
		})

		it('aborts a speculative fetchThread for a different id', async () => {
			let rejectFetch
			MessageService.fetchThread.mockReturnValue(new Promise((resolve, reject) => {
				rejectFetch = reject
			}))

			const fetchPromise = store.fetchThread(90004, { speculative: true }).catch(() => {})
			const signal = MessageService.fetchThread.mock.calls[0][1].signal

			store.cancelSpeculativeFetchesExcept(999)

			expect(signal.aborted).toBe(true)

			rejectFetch(new Error('aborted'))
			await fetchPromise
		})

		it('clears the speculative registration once the fetch settles, so a later cancel has nothing left to abort', async () => {
			MessageService.fetchMessage.mockResolvedValue({ databaseId: 90005 })

			await store.fetchMessage(90005, { speculative: true })

			expect(() => store.cancelSpeculativeFetchesExcept(999)).not.toThrow()
		})
	})

	describe('fetchMessage: caps concurrent speculative (prefetch) requests app-wide', () => {
		// Confirmed live (2026-07-12): a fast scroll through Priority Inbox
		// produced 7+ concurrent speculative body fetches -- several of
		// them genuine cache misses taking 10-40s against a slow-responding
		// account -- saturating the 3-worker mailwrite pool ahead of the
		// user's own click. ViewportPrefetchMixin nominally capped itself
		// to 2 via viewportPrefetchObserver.js, but its caller
		// (Envelope.vue) fired the fetches without returning their
		// promises, so that cap's own "await fn()" resolved on the next
		// microtask regardless of whether the requests were still in
		// flight -- never actually throttling anything. Hover/touch/
		// thread-neighbor/list-neighbor prefetch had no cap at all. This
		// cap replaces all of that with one enforced where every
		// speculative caller converges: fetchMessage() itself.
		it('allows up to the cap (2) concurrent speculative fetches', async () => {
			let resolveFirst
			let resolveSecond
			MessageService.fetchMessage
				.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
				.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

			const firstCall = store.fetchMessage(90010, { speculative: true })
			const secondCall = store.fetchMessage(90011, { speculative: true })

			expect(MessageService.fetchMessage).toHaveBeenCalledTimes(2)

			resolveFirst({ databaseId: 90010 })
			resolveSecond({ databaseId: 90011 })
			await firstCall
			await secondCall
		})

		it('skips a third speculative fetch once the cap is reached, without calling the service', async () => {
			let resolveFirst
			let resolveSecond
			MessageService.fetchMessage
				.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
				.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

			const firstCall = store.fetchMessage(90012, { speculative: true })
			const secondCall = store.fetchMessage(90013, { speculative: true })

			const result = await store.fetchMessage(90014, { speculative: true })

			expect(result).toBeUndefined()
			expect(MessageService.fetchMessage).toHaveBeenCalledTimes(2)

			resolveFirst({ databaseId: 90012 })
			resolveSecond({ databaseId: 90013 })
			await firstCall
			await secondCall
		})

		it('frees a slot once a speculative fetch settles, letting the next one through', async () => {
			let resolveFirst
			let resolveSecond
			MessageService.fetchMessage
				.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
				.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

			const firstCall = store.fetchMessage(90015, { speculative: true })
			const secondCall = store.fetchMessage(90016, { speculative: true })

			resolveFirst({ databaseId: 90015 })
			await firstCall

			MessageService.fetchMessage.mockResolvedValueOnce({ databaseId: 90017 })
			const thirdResult = await store.fetchMessage(90017, { speculative: true })

			expect(thirdResult).toEqual({ databaseId: 90017 })

			resolveSecond({ databaseId: 90016 })
			await secondCall
		})

		it('never caps a non-speculative (real) fetch, even with every speculative slot full', async () => {
			let resolveFirst
			let resolveSecond
			MessageService.fetchMessage
				.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
				.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

			const firstCall = store.fetchMessage(90018, { speculative: true })
			const secondCall = store.fetchMessage(90019, { speculative: true })

			MessageService.fetchMessage.mockResolvedValueOnce({ databaseId: 90020 })
			const realResult = await store.fetchMessage(90020)

			expect(realResult).toEqual({ databaseId: 90020 })

			resolveFirst({ databaseId: 90018 })
			resolveSecond({ databaseId: 90019 })
			await firstCall
			await secondCall
		})
	})

	describe('fetchThread: caps concurrent speculative (prefetch) requests app-wide', () => {
		// Same guard as fetchMessage(), but for the thread half of every
		// row prefetch. fetchThread() is usually cheaper than a body miss,
		// but hover/touch/viewport all trigger it too; without a store-level
		// cap, fixing body fan-out still left an unbounded speculative
		// thread fan-out under fast pointer/scroll movement.
		beforeEach(() => {
			const account = { id: 13 }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
		})

		it('allows up to the cap (2) concurrent speculative fetches', async () => {
			let resolveFirst
			let resolveSecond
			MessageService.fetchThread
				.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
				.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

			const firstCall = store.fetchThread(90110, { speculative: true })
			const secondCall = store.fetchThread(90111, { speculative: true })

			expect(MessageService.fetchThread).toHaveBeenCalledTimes(2)

			resolveFirst([{ databaseId: 90110, mailboxId: 11 }])
			resolveSecond([{ databaseId: 90111, mailboxId: 11 }])
			await firstCall
			await secondCall
		})

		it('skips a third speculative fetch once the cap is reached, without calling the service', async () => {
			let resolveFirst
			let resolveSecond
			MessageService.fetchThread
				.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
				.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

			const firstCall = store.fetchThread(90112, { speculative: true })
			const secondCall = store.fetchThread(90113, { speculative: true })

			const result = await store.fetchThread(90114, { speculative: true })

			expect(result).toBeUndefined()
			expect(MessageService.fetchThread).toHaveBeenCalledTimes(2)

			resolveFirst([{ databaseId: 90112, mailboxId: 11 }])
			resolveSecond([{ databaseId: 90113, mailboxId: 11 }])
			await firstCall
			await secondCall
		})

		it('frees a slot once a speculative fetch settles, letting the next one through', async () => {
			let resolveFirst
			let resolveSecond
			MessageService.fetchThread
				.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
				.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

			const firstCall = store.fetchThread(90115, { speculative: true })
			const secondCall = store.fetchThread(90116, { speculative: true })

			resolveFirst([{ databaseId: 90115, mailboxId: 11 }])
			await firstCall

			MessageService.fetchThread.mockResolvedValueOnce([{ databaseId: 90117, mailboxId: 11 }])
			const thirdResult = await store.fetchThread(90117, { speculative: true })

			expect(thirdResult).toEqual([
				expect.objectContaining({ databaseId: 90117, mailboxId: 11 }),
			])

			resolveSecond([{ databaseId: 90116, mailboxId: 11 }])
			await secondCall
		})

		it('never caps a non-speculative (real) fetch, even with every speculative slot full', async () => {
			let resolveFirst
			let resolveSecond
			MessageService.fetchThread
				.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
				.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

			const firstCall = store.fetchThread(90118, { speculative: true })
			const secondCall = store.fetchThread(90119, { speculative: true })

			MessageService.fetchThread.mockResolvedValueOnce([{ databaseId: 90120, mailboxId: 11 }])
			const realResult = await store.fetchThread(90120)

			expect(realResult).toEqual([
				expect.objectContaining({ databaseId: 90120, mailboxId: 11 }),
			])

			resolveFirst([{ databaseId: 90118, mailboxId: 11 }])
			resolveSecond([{ databaseId: 90119, mailboxId: 11 }])
			await firstCall
			await secondCall
		})

		it('dedupes a same-id speculative call before applying the cap', async () => {
			let resolveFirst
			let resolveSecond
			MessageService.fetchThread
				.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
				.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))

			const firstCall = store.fetchThread(90121, { speculative: true })
			const secondCall = store.fetchThread(90122, { speculative: true })
			const duplicateFirstCall = store.fetchThread(90121, { speculative: true })

			expect(MessageService.fetchThread).toHaveBeenCalledTimes(2)

			resolveFirst([{ databaseId: 90121, mailboxId: 11 }])
			resolveSecond([{ databaseId: 90122, mailboxId: 11 }])
			const [first, duplicateFirst] = await Promise.all([firstCall, duplicateFirstCall])
			await secondCall

			expect(duplicateFirst).toEqual(first)
			expect(MessageService.fetchThread).toHaveBeenCalledTimes(2)
		})
	})

	describe('syncEnvelopes: malformed response retry', () => {
		// Regression: confirmed live -- a sync response missing
		// newMessages/changedMessages crashed with a raw TypeError and
		// was treated as a generic, non-retried failure (unlike
		// MailboxLockedError/SyncIncompleteError, which do retry). Root
		// cause not yet pinned down (seen only under heavy concurrent
		// load), but a single transient glitch shouldn't leave the
		// mailbox stuck out of sync until an unrelated refresh.
		let account13

		beforeEach(() => {
			account13 = { id: 13 }
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})
		})

		it('retries once after a malformed response and succeeds', async () => {
			MessageService.syncEnvelopes
				.mockRejectedValueOnce(new MalformedSyncResponseError('Malformed sync response for mailbox 11'))
				.mockResolvedValueOnce({ newMessages: [], changedMessages: [], vanishedMessages: [], stats: { unread: 0 } })

			const result = await store.syncEnvelopes({ mailboxId: 11 })

			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(2)
			expect(result).toEqual([])
		})

		it('gives up after a second consecutive malformed response instead of retrying forever', async () => {
			MessageService.syncEnvelopes.mockRejectedValue(new MalformedSyncResponseError('Malformed sync response for mailbox 11'))

			await expect(store.syncEnvelopes({ mailboxId: 11 })).rejects.toThrow(MalformedSyncResponseError)

			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(2)
		})
	})

	describe('adaptive backpressure', () => {
		it('reflects the serverBusy field from the most recent sync response, from any caller', async () => {
			// The signal itself (mail-pool load) is global, not tied to one
			// specific caller -- any sync response, gated or real, keeps
			// the store's flag as fresh as the most recent one seen.
			const account13 = { id: 13 }
			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 11, specialRole: 'inbox' },
			})

			MessageService.syncEnvelopes.mockResolvedValueOnce({
				newMessages: [],
				changedMessages: [],
				vanishedMessages: [],
				stats: { unread: 0 },
				serverBusy: true,
			})
			await store.syncEnvelopes({ mailboxId: 11 })
			expect(store.serverBusy).toBe(true)

			MessageService.syncEnvelopes.mockResolvedValueOnce({
				newMessages: [],
				changedMessages: [],
				vanishedMessages: [],
				stats: { unread: 0 },
				serverBusy: false,
			})
			await store.syncEnvelopes({ mailboxId: 11 })
			expect(store.serverBusy).toBe(false)
		})
	})

	describe('sync lock coordination', () => {
		it('only retries once for a locked mailbox even when multiple queries are syncing it concurrently', async () => {
			// A sync lock is mailbox-wide, not per-query. Two different
			// callers syncing the same mailbox with different queries (e.g.
			// the plain view and the favorites-split view, each backed by
			// their own Mailbox.vue instance) would, without coordination,
			// each independently retry every 1.5s against the very same
			// lock -- multiplying request volume by the number of
			// concurrent callers for as long as the mailbox stays locked.
			// This asserts only one retry-wait actually happens: the first
			// caller becomes the "leader" and probes the lock, the second
			// just awaits that outcome instead of starting its own loop.
			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})

			// Locked for long enough that a leader needs several retry
			// rounds to get through -- long enough to clearly tell "one
			// coordinated retry chain" apart from "two independent ones"
			// by the resulting wait() call count.
			let callCount = 0
			MessageService.syncEnvelopes.mockImplementation(async () => {
				callCount++
				if (callCount <= 4) {
					throw new MailboxLockedError('locked')
				}
				return {
					newMessages: [],
					changedMessages: [],
					vanishedMessages: [],
					stats: { unread: 0 },
				}
			})

			const [resultA, resultB] = await Promise.all([
				store.syncEnvelopes({ mailboxId: 11, query: 'A' }),
				store.syncEnvelopes({ mailboxId: 11, query: 'B' }),
			])

			expect(resultA).toEqual([])
			expect(resultB).toEqual([])
			// Only the leader's retry chain ever calls wait() -- the
			// follower just awaits the leader's outcome. Without
			// coordination, the follower would run its own independent
			// wait()-then-retry loop too, roughly doubling this count.
			expect(wait).toHaveBeenCalledTimes(3)
		})

		it('honors the server-provided retryAfterMs instead of guessing a backoff', async () => {
			// The server knows exactly how long its own lock/rate-limit has
			// left (Retry-After) -- when present, that's authoritative and
			// should be used more or less as-is (plus a little jitter),
			// not overridden by our own guessed exponential backoff.
			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})

			let callCount = 0
			MessageService.syncEnvelopes.mockImplementation(async () => {
				callCount++
				if (callCount === 1) {
					const error = new MailboxLockedError('locked')
					error.retryAfterMs = 45_000
					throw error
				}
				return {
					newMessages: [],
					changedMessages: [],
					vanishedMessages: [],
					stats: { unread: 0 },
				}
			})

			await store.syncEnvelopes({ mailboxId: 11, query: 'A' })

			expect(wait).toHaveBeenCalledTimes(1)
			// The first retry is the quick ~10s probe (see
			// computeLockRetryDelayMs: the mailbox is most likely free again
			// well before the server's worst-case 45s hint) -- but still in
			// the hint-driven regime, not the unrelated, much smaller
			// exponential-backoff range starting at 1.5s.
			const actualDelay = wait.mock.calls[0][0]
			expect(actualDelay).toBeGreaterThanOrEqual(10_000)
			expect(actualDelay).toBeLessThanOrEqual(12_000)
		})

		it('skips a doomed network request when a leader is already known to be retrying', async () => {
			// A real bug: checking pendingLockWaits only inside the catch
			// handler closes the loop for a NEW cycle arriving while a
			// leader is already mid-retry, but does nothing to stop a
			// call arriving *after* a leader is already established from
			// making its own doomed request -- e.g. the main list and the
			// favorites section both reacting to the same "refresh"
			// click: one becomes leader, but if the other's own request
			// only reaches the mailbox-locked check a moment later, it
			// would previously still fire its own network request instead
			// of recognizing the already-registered leader up front.
			const account13 = {
				id: 13,
			}

			store.addAccountMutation(account13)
			store.addMailboxMutation({
				account: account13,
				mailbox: {
					name: 'INBOX',
					databaseId: 11,
					specialRole: 'inbox',
				},
			})

			let callCount = 0
			MessageService.syncEnvelopes.mockImplementation(async () => {
				callCount++
				if (callCount === 1) {
					throw new MailboxLockedError('locked')
				}
				return {
					newMessages: [],
					changedMessages: [],
					vanishedMessages: [],
					stats: { unread: 0 },
				}
			})

			// Hold the leader's retry wait open so it's still registered
			// in pendingLockWaits when the "later" call below starts --
			// simulating that call arriving strictly after the leader was
			// established, not simultaneously with it.
			let releaseLeaderWait
			wait.mockImplementationOnce(() => new Promise((resolve) => {
				releaseLeaderWait = resolve
			}))

			const leaderPromise = store.syncEnvelopes({ mailboxId: 11, query: 'A' })

			// Give the leader's synchronous work (the failed first
			// attempt, registering itself in pendingLockWaits) a chance
			// to run before the later call starts.
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()

			const laterCallPromise = store.syncEnvelopes({ mailboxId: 11, query: 'B' })

			// The later call should be waiting on the leader, not the
			// network -- confirm no second network call happened yet.
			await Promise.resolve()
			await Promise.resolve()
			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(1)

			releaseLeaderWait()
			await Promise.all([leaderPromise, laterCallPromise])

			// 1 (leader's failed first attempt) + 1 (leader's successful
			// retry) + 1 (the later call's own fresh attempt, made only
			// after awaiting the leader) = 3. If the later call had made
			// its own doomed request instead of recognizing the existing
			// leader, this would be 4.
			expect(MessageService.syncEnvelopes).toHaveBeenCalledTimes(3)
		})
	})

	describe('computeLockRetryDelayMs', () => {
		afterEach(() => {
			vi.restoreAllMocks()
		})

		it('grows the delay upper bound exponentially across attempts', () => {
			// Full jitter means the actual value is random within [0, bound]
			// -- pin Math.random to 1 (its supremum) to read the bound itself
			// back out for each attempt.
			vi.spyOn(Math, 'random').mockReturnValue(1)

			expect(computeLockRetryDelayMs(0)).toBeCloseTo(1500, 0)
			expect(computeLockRetryDelayMs(1)).toBeCloseTo(3000, 0)
			expect(computeLockRetryDelayMs(2)).toBeCloseTo(6000, 0)
			expect(computeLockRetryDelayMs(3)).toBeCloseTo(12000, 0)
		})

		it('caps the delay upper bound so it never grows unbounded', () => {
			vi.spyOn(Math, 'random').mockReturnValue(1)

			// Attempt 10 would be 1500 * 2^10 = 1,536,000ms uncapped --
			// must be clamped to the 30s ceiling instead.
			expect(computeLockRetryDelayMs(10)).toBeCloseTo(30_000, 0)
		})

		it('also caps a server-provided retryAfterMs, so a fresh long lock cannot delay a retry for minutes', () => {
			// A mailbox locked near the start of a genuinely long sync can
			// have nearly the full 300s Mailbox::LOCK_TIMEOUT left on its
			// Retry-After. Confirmed live: this uncapped formula produced a
			// ~5-6 minute wait on a real account, during which
			// syncWatchedMailboxes()'s ~10s-cadence poller skipped that
			// mailbox every single tick (see isMailboxSyncRetryPending()) --
			// its badge and message list simply didn't move for minutes.
			// (Attempt 1, not 0: the first attempt is the quick probe below.)
			vi.spyOn(Math, 'random').mockReturnValue(1)

			expect(computeLockRetryDelayMs(1, 290_000)).toBeCloseTo(90_000, 0)
		})

		it('probes quickly on the first retry instead of honoring a long hint', () => {
			// The most common 409 is a transient collision between two
			// windows' ticks -- the mailbox is free again in well under a
			// second, but the server's worst-case Retry-After can't say so.
			// Confirmed live: honoring it even capped cost the losing window
			// a ~93s silence on that mailbox right as a new message arrived.
			// The first retry probes at ~10s; only a mailbox still locked
			// then gets the full (capped) hint from the second attempt on.
			vi.spyOn(Math, 'random').mockReturnValue(0)
			expect(computeLockRetryDelayMs(0, 290_000)).toBe(10_000)

			// The probe gets the same proportional jitter as everything else.
			vi.spyOn(Math, 'random').mockReturnValue(1)
			expect(computeLockRetryDelayMs(0, 290_000)).toBe(12_000)
		})

		it('still honors a server hint shorter than the probe window on the first retry', () => {
			vi.spyOn(Math, 'random').mockReturnValue(0)

			// The hint stays the floor -- the probe only shortens waits, it
			// never retries earlier than the server asked.
			expect(computeLockRetryDelayMs(0, 3_000)).toBe(3_000)
		})

		it('never returns a negative or undefined delay at attempt 0', () => {
			vi.spyOn(Math, 'random').mockReturnValue(0)

			expect(computeLockRetryDelayMs(0)).toBe(0)
		})

		it('prefers retryAfterMs over the computed backoff when present', () => {
			vi.spyOn(Math, 'random').mockReturnValue(0)

			// Attempt number is irrelevant once the server has told us
			// exactly how long to wait.
			expect(computeLockRetryDelayMs(5, 10_000)).toBe(10_000)
		})

		it('jitters retryAfterMs proportionally instead of by a flat amount', () => {
			// At its minimum (Math.random() === 0), retryAfterMs is honored
			// as-is -- it's a floor, never retry earlier than the server said.
			vi.spyOn(Math, 'random').mockReturnValue(0)
			expect(computeLockRetryDelayMs(5, 10_000)).toBe(10_000)

			// At its supremum, the wait grows by up to 20% -- wide enough
			// that repeated collisions with a fixed-interval poller (e.g. a
			// 60s background sync) de-phase within a couple of retries,
			// unlike a flat ~1s jitter which barely dents a 300s-multiple
			// cadence, but not so wide that a mailbox stuck on a genuinely
			// long sync (not periodic-poller resonance) waits noticeably
			// longer for no corresponding benefit.
			vi.spyOn(Math, 'random').mockReturnValue(1)
			expect(computeLockRetryDelayMs(5, 10_000)).toBe(12_000)
		})
	})

	describe('mapWithConcurrencyLimit: a shared budget across independent, simultaneous callers', () => {
		// Confirmed live: a hard reload starts the priority-inbox section
		// fan-out AND the watched-mailbox poller from an empty cache at the
		// same instant. Each already had its OWN concurrency limit
		// (ENVELOPE_FETCH_CONCURRENCY, WATCHED_SYNC_CONCURRENCY), which
		// bounded each mechanism on its own -- but two SEPARATE calls to
		// mapWithConcurrencyLimit(), each requesting up to their own
		// per-call limit, used to have no shared ceiling at all: their
		// combined in-flight count was simply the sum. A wall of 504s
		// across several real mailboxes' priority-inbox buckets at once
		// resulted (see nextcloud-mail-oauth-integration.md).

		function controllablePromiseFn(track) {
			return () => new Promise((resolve) => {
				track.concurrent++
				track.maxConcurrent = Math.max(track.maxConcurrent, track.concurrent)
				track.pendingResolvers.push(() => {
					track.concurrent--
					resolve()
				})
			})
		}

		it('caps the COMBINED concurrency of two simultaneous calls, not just each one individually', async () => {
			const track = { concurrent: 0, maxConcurrent: 0, pendingResolvers: [] }
			const fn = controllablePromiseFn(track)

			// Two independent calls, each with its own limit of 3 -- exactly
			// like the priority-inbox fan-out and the watched-mailbox poller
			// each requesting up to their own per-call cap at the same time.
			// Alone, either one would peak at 3; together, unbounded, they'd
			// peak at 6. The shared limiter (SHARED_NETWORK_CONCURRENCY = 4
			// in actions.js) must keep the combined peak at 4.
			const callA = mapWithConcurrencyLimit([1, 2, 3], 3, fn)
			const callB = mapWithConcurrencyLimit([4, 5, 6], 3, fn)

			await vi.waitFor(() => {
				if (track.pendingResolvers.length < 4) {
					throw new Error(`only ${track.pendingResolvers.length} combined workers have started so far`)
				}
			})

			expect(track.pendingResolvers.length).toBe(4)
			expect(track.maxConcurrent).toBe(4)

			// Draining lets the remaining 2 (one from each call) start
			// without ever exceeding the shared cap.
			while (track.pendingResolvers.length > 0) {
				track.pendingResolvers.splice(0).forEach((resolve) => resolve())
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
			await Promise.all([callA, callB])

			expect(track.maxConcurrent).toBe(4)
		})

		it('still lets a single call reach its own lower per-call limit when nothing else is running', async () => {
			const track = { concurrent: 0, maxConcurrent: 0, pendingResolvers: [] }
			const fn = controllablePromiseFn(track)

			const call = mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, fn)

			await vi.waitFor(() => {
				if (track.pendingResolvers.length < 2) {
					throw new Error(`only ${track.pendingResolvers.length} workers have started so far`)
				}
			})

			// The per-call limit (2) is tighter than the shared budget (4)
			// here, so it -- not the shared one -- is what actually governs.
			expect(track.maxConcurrent).toBe(2)

			while (track.pendingResolvers.length > 0) {
				track.pendingResolvers.splice(0).forEach((resolve) => resolve())
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
			await call

			expect(track.maxConcurrent).toBe(2)
		})
	})

	it('should move message to junk, no mailbox configured', async () => {
		store.addAccountMutation({
			id: 42,
			junkMailboxId: null,
		})

		const removeEnvelope = await store.moveEnvelopeToJunk({
			accountId: 42,
			flags: {
				$junk: true,
			},
			mailboxId: 1,
		})

		expect(removeEnvelope).toBeFalsy()
	})

	it('should move message to inbox', async () => {
		const account = {
			id: 42,
			junkMailboxId: 10,
		}

		store.addAccountMutation(account)
		store.addMailboxMutation({
			account,
			mailbox: {
				databaseId: 1,
				specialRole: 'inbox',
				name: 'INBOX',
			},
		})

		const removeEnvelope = await store.moveEnvelopeToJunk({
			accountId: 42,
			flags: {
				$junk: true,
			},
			mailboxId: 10,
		})

		expect(removeEnvelope).toBeTruthy()
	})

	it('should move message to inbox, inbox not found', async () => {
		store.addAccountMutation({
			id: 42,
			junkMailboxId: 10,
		})

		const removeEnvelope = await store.moveEnvelopeToJunk({
			accountId: 42,
			flags: {
				$junk: true,
			},
			mailboxId: 10,
		})

		expect(removeEnvelope).toBeFalsy()
	})

	describe('toggleEnvelopeJunk actually moves the message, not just flips a flag', () => {
		// Confirmed live: marking a message as spam only ever called
		// setEnvelopeFlags($junk/$notjunk) -- nothing in the whole call
		// chain (across Envelope.vue, MenuEnvelope.vue, EnvelopeList.vue,
		// ThreadEnvelope.vue) ever called the move-message endpoint,
		// despite comments at every calling component claiming a
		// 'delete' event bubbling to Mailbox.onDelete was "the actual
		// implementation" -- traced end to end, that chain only does
		// list-navigation bookkeeping (fetch one replacement envelope,
		// jump to the next message). The optimistic UI removal made it
		// LOOK like it worked; the message was still sitting, unmoved,
		// in its original mailbox, and reappeared on the next refresh.
		// Verified directly against the live database (mailbox_id
		// unchanged after "marking as spam") before this fix.
		let account
		let junkMailbox
		let inbox

		beforeEach(() => {
			account = { id: 42, junkMailboxId: 10 }
			store.addAccountMutation(account)
			inbox = { databaseId: 1, specialRole: 'inbox', name: 'INBOX' }
			junkMailbox = { databaseId: 10, name: 'Junk' }
			store.addMailboxMutation({ account, mailbox: inbox })
			store.addMailboxMutation({ account, mailbox: junkMailbox })
		})

		function envelopeInInbox(overrides = {}) {
			return {
				databaseId: 900,
				accountId: 42,
				mailboxId: 1,
				dateInt: 900,
				flags: { $junk: false, $notjunk: false, seen: true },
				...overrides,
			}
		}

		it('marking as spam actually calls moveMessage to the account\'s junk mailbox', async () => {
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			MessageService.moveMessage.mockResolvedValue({})
			const envelope = envelopeInInbox()

			await store.toggleEnvelopeJunk({ envelope, removeEnvelope: true })

			expect(MessageService.moveMessage).toHaveBeenCalledWith(900, 10)
		})

		it('un-marking as spam moves the message back to the inbox', async () => {
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			MessageService.moveMessage.mockResolvedValue({})
			const envelope = envelopeInInbox({ mailboxId: 10, flags: { $junk: true, $notjunk: false, seen: true } })

			await store.toggleEnvelopeJunk({ envelope, removeEnvelope: true })

			expect(MessageService.moveMessage).toHaveBeenCalledWith(900, 1)
		})

		it('does not call moveMessage when there is no junk mailbox configured', async () => {
			store.addAccountMutation({ id: 43, junkMailboxId: null })
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			const envelope = envelopeInInbox({ accountId: 43 })

			await store.toggleEnvelopeJunk({ envelope, removeEnvelope: false })

			expect(MessageService.moveMessage).not.toHaveBeenCalled()
		})

		it('does not call moveMessage when the message is already in the destination mailbox', async () => {
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			// Not (yet) flagged $junk, but already sitting in the
			// account's junk mailbox for some other reason -- nothing to
			// move to, since it's already there.
			const envelope = envelopeInInbox({ mailboxId: 10, flags: { $junk: false, $notjunk: false, seen: true } })

			await store.toggleEnvelopeJunk({ envelope, removeEnvelope: false })

			expect(MessageService.moveMessage).not.toHaveBeenCalled()
		})

		it('reverts flags AND re-adds the envelope when the flag request itself fails', async () => {
			MessageService.setEnvelopeFlags.mockRejectedValue(new Error('network error'))
			const envelope = envelopeInInbox()

			await expect(store.toggleEnvelopeJunk({ envelope, removeEnvelope: true })).rejects.toThrow('network error')

			expect(envelope.flags.$junk).toBe(false)
			expect(MessageService.moveMessage).not.toHaveBeenCalled()
		})

		it('reverts flags and re-adds the envelope when the move itself fails, after flags succeeded', async () => {
			// Regression: the old revert called addEnvelopesMutation([envelope])
			// -- an ARRAY where the mutation destructures {envelopes, ...}
			// from a single object -- which threw and skipped the flag
			// revert entirely, since the throw happened before reaching it.
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			MessageService.moveMessage.mockRejectedValue(new Error('move failed'))
			const envelope = envelopeInInbox()
			store.envelopes[envelope.databaseId] = envelope

			await expect(store.toggleEnvelopeJunk({ envelope, removeEnvelope: true })).rejects.toThrow('move failed')

			// The flag revert must actually run (not be skipped by an
			// earlier crash in the re-add step) -- back to the original
			// $junk=false/$notjunk=true, not left at the optimistic
			// $junk=true/$notjunk=false the failed move never earned.
			expect(envelope.flags.$junk).toBe(false)
			expect(envelope.flags.$notjunk).toBe(true)
			// The re-add itself must not have thrown and swallowed the
			// real error.
			expect(store.envelopes[envelope.databaseId]).toBeDefined()
		})

		// Phase 4 (see /home/ktogias/.claude/plans/generic-hugging-fern.md):
		// reconciliation here is deliberately scoped to the $junk flag
		// alone, the primary always-attempted change -- not the separate
		// move-to-junk-mailbox step, which can legitimately fail on its
		// own without meaning the junk marking itself didn't work.
		it('treats the junk marking as landed (no revert, no rethrow) if the flag confirms despite the move failing', async () => {
			MessageService.setEnvelopeFlags.mockResolvedValue({})
			MessageService.moveMessage.mockRejectedValue(new Error('move failed'))
			MessageService.fetchEnvelope.mockResolvedValue({ flags: { $junk: true, $notjunk: false } })
			const envelope = envelopeInInbox()
			store.envelopes[envelope.databaseId] = envelope

			await store.toggleEnvelopeJunk({ envelope, removeEnvelope: true })

			expect(envelope.flags.$junk).toBe(true)
		})
	})

	it('includes a cache buster if requested', async () => {
		const account = {
			id: 13,
			personalNamespace: 'INBOX.',
			mailboxes: [],
		}

		store.addAccountMutation(account)
		store.addMailboxMutation({
			account,
			mailbox: {
				id: 'INBOX',
				name: 'INBOX',
				databaseId: 21,
				accountId: 13,
				specialRole: 'inbox',
				cacheBuster: 'abcdef123',
			},
		})

		store.addEnvelopesMutation = vi.fn()

		MessageService.fetchEnvelopes.mockResolvedValueOnce([])

		await store.fetchEnvelopes({
			mailboxId: 21,
			includeCacheBuster: true,
		})

		expect(MessageService.fetchEnvelopes).toHaveBeenCalledWith(
			13, // account id
			21, // mailbox id
			undefined, // query
			undefined, // cursor
			20, // limit (PAGE_SIZE)
			undefined, // sort ordre
			undefined, // layout
			'abcdef123', // cache buster
			undefined, // abort signal
		)
	})

	describe('prepareAttachments', () => {
		const original = {
			mailboxId: 1,
			attachments: [{ id: 'att1', messageId: 42, fileName: 'doc.pdf' }],
			inlineAttachments: [{ id: 'img1', messageId: 42, cid: 'abc@x', fileName: 'logo.png' }],
		}

		it('reply includes only inline attachments', () => {
			const result = store.prepareAttachments(original)

			expect(result).toHaveLength(1)
			expect(result[0]).toMatchObject({
				id: 'img1',
				type: 'message-attachment-inline',
				mailboxId: 1,
				uid: 42,
			})
		})

		it('forward includes regular and inline attachments', () => {
			const result = store.prepareAttachments(original, true)

			expect(result).toHaveLength(2)
			expect(result[0]).toMatchObject({
				id: 'att1',
				type: 'message-attachment',
				mailboxId: 1,
				uid: 42,
			})
			expect(result[1]).toMatchObject({
				id: 'img1',
				type: 'message-attachment-inline',
				mailboxId: 1,
				uid: 42,
			})
		})

		it('returns empty array when message has no attachments', () => {
			expect(store.prepareAttachments({})).toEqual([])
		})
	})

	describe('updateAccount', () => {
		it('clears the error flag and syncs mailboxes after a successful settings update', async () => {
			const account = {
				id: 7,
				personalNamespace: '',
				mailboxes: [],
				error: true,
			}
			store.addAccountMutation(account)

			const updatedAccount = { id: 7, personalNamespace: '', mailboxes: [] }
			AccountService.update.mockResolvedValue(updatedAccount)
			MailboxService.fetchAll.mockResolvedValue([])

			await store.updateAccount({ accountId: 7 })

			expect(store.accountsUnmapped[7].error).toBe(false)
			expect(MailboxService.fetchAll).toHaveBeenCalledWith(7, true)
		})

		it('still returns the updated account when the follow-up mailbox sync fails', async () => {
			// The "Reconnect Google account" flow calls updateAccount()
			// BEFORE opening the OAuth consent popup, and the forced
			// mailbox sync inside it cannot work while the account's token
			// is expired -- that's the whole reason the user is
			// reconnecting. Letting the sync failure reject the action
			// aborted the flow before the popup code was ever reached, so
			// the token could never be renewed. Confirmed live against a
			// Gmail account whose refresh token Google had expired.
			const account = {
				id: 7,
				personalNamespace: '',
				mailboxes: [],
				error: true,
			}
			store.addAccountMutation(account)

			const updatedAccount = { id: 7, personalNamespace: '', mailboxes: [] }
			AccountService.update.mockResolvedValue(updatedAccount)
			MailboxService.fetchAll.mockRejectedValue(new Error('IMAP error synchronizing account 7: token expired'))

			const returned = await store.updateAccount({ accountId: 7 })

			expect(returned).toEqual(updatedAccount)
			expect(store.accountsUnmapped[7].error).toBe(false)
		})
	})

	describe('toggleEnvelopeSeen thread-wide unread correction', () => {
		it('marks the thread unread immediately when marking a message unread, without waiting for the server', async () => {
			const envelope = {
				databaseId: 42,
				mailboxId: 11,
				flags: { seen: true, hasUnseenInThread: false },
			}
			// Resolves later, so the assertion below only holds if the
			// optimistic update happened before awaiting the server call.
			let resolveRequest
			MessageService.setEnvelopeFlags.mockReturnValue(new Promise((resolve) => {
				resolveRequest = resolve
			}))

			const pending = store.toggleEnvelopeSeen({ envelope, seen: false })

			expect(envelope.flags.hasUnseenInThread).toBe(true)

			resolveRequest({ hasUnseenInThread: true })
			await pending
		})

		it('corrects hasUnseenInThread with the server-authoritative value after marking read', async () => {
			const envelope = {
				databaseId: 42,
				mailboxId: 11,
				flags: { seen: false, hasUnseenInThread: true },
			}
			// The server is authoritative: some other message in the thread
			// is still unseen even though this one was just marked read.
			MessageService.setEnvelopeFlags.mockResolvedValue({ hasUnseenInThread: true })

			await store.toggleEnvelopeSeen({ envelope, seen: true })

			expect(envelope.flags.hasUnseenInThread).toBe(true)
		})

		it('clears hasUnseenInThread once the server confirms no other message in the thread is unseen', async () => {
			const envelope = {
				databaseId: 42,
				mailboxId: 11,
				flags: { seen: false, hasUnseenInThread: true },
			}
			MessageService.setEnvelopeFlags.mockResolvedValue({ hasUnseenInThread: false })

			await store.toggleEnvelopeSeen({ envelope, seen: true })

			expect(envelope.flags.hasUnseenInThread).toBe(false)
		})

		it('leaves hasUnseenInThread untouched if the server response omits it', async () => {
			const envelope = {
				databaseId: 42,
				mailboxId: 11,
				flags: { seen: false, hasUnseenInThread: true },
			}
			MessageService.setEnvelopeFlags.mockResolvedValue({})

			await store.toggleEnvelopeSeen({ envelope, seen: true })

			expect(envelope.flags.hasUnseenInThread).toBe(true)
		})

		// Reported live: opening a thread correctly marked its oldest
		// unread reply as read on the server (moving on to the
		// next-oldest unread reply on the next open, eventually reaching
		// a fully-read thread), but every list kept showing the thread as
		// unread throughout -- the corrected hasUnseenInThread value was
		// only ever applied to whichever reply had just been toggled,
		// never to the thread's newest message, which is what a list
		// actually renders as that thread's representative row.
		it('propagates the server-corrected hasUnseenInThread to every other locally-known message in the same thread', async () => {
			const olderReply = {
				databaseId: 100,
				accountId: 13,
				mailboxId: 11,
				threadRootId: 'thread-abc',
				dateInt: 1,
				flags: { seen: false, hasUnseenInThread: true },
			}
			const representative = {
				databaseId: 102,
				accountId: 13,
				mailboxId: 11,
				threadRootId: 'thread-abc',
				dateInt: 3,
				flags: { seen: true, hasUnseenInThread: true },
			}
			store.envelopes[olderReply.databaseId] = olderReply
			store.envelopes[representative.databaseId] = representative
			// A message from a completely different thread must be left
			// alone.
			const unrelated = {
				databaseId: 200,
				accountId: 13,
				mailboxId: 11,
				threadRootId: 'thread-xyz',
				dateInt: 1,
				flags: { seen: false, hasUnseenInThread: true },
			}
			store.envelopes[unrelated.databaseId] = unrelated

			// The thread has no other unread message left once this one is
			// marked read.
			MessageService.setEnvelopeFlags.mockResolvedValue({ hasUnseenInThread: false })

			await store.toggleEnvelopeSeen({ envelope: olderReply, seen: true })

			expect(olderReply.flags.hasUnseenInThread).toBe(false)
			expect(representative.flags.hasUnseenInThread).toBe(false)
			expect(unrelated.flags.hasUnseenInThread).toBe(true)
		})

		it('marking a message unread immediately marks every other message in the same thread unread too, optimistically', () => {
			const olderReply = {
				databaseId: 100,
				accountId: 13,
				mailboxId: 11,
				threadRootId: 'thread-abc',
				dateInt: 1,
				flags: { seen: true, hasUnseenInThread: false },
			}
			const representative = {
				databaseId: 102,
				accountId: 13,
				mailboxId: 11,
				threadRootId: 'thread-abc',
				dateInt: 3,
				flags: { seen: true, hasUnseenInThread: false },
			}
			store.envelopes[olderReply.databaseId] = olderReply
			store.envelopes[representative.databaseId] = representative
			MessageService.setEnvelopeFlags.mockReturnValue(new Promise(() => {})) // never resolves in this test

			store.toggleEnvelopeSeen({ envelope: olderReply, seen: false })

			expect(olderReply.flags.hasUnseenInThread).toBe(true)
			expect(representative.flags.hasUnseenInThread).toBe(true)
		})
	})

	describe('setMailboxUnreadCountMutation: badge protected against a stale sync clobbering an unconfirmed toggle', () => {
		// Regression: flagEnvelopeMutation() already adjusts mailbox.unread
		// optimistically the instant a message is marked read/unread, but
		// setMailboxUnreadCountMutation() (called on every routine
		// background sync) used to overwrite that with the server's raw
		// stats.unread unconditionally -- unlike every other field this
		// file protects with a grace window. A sync response computed
		// before this client's own still-in-flight toggle actually landed
		// server-side silently clobbered the badge back to the stale
		// count. Confirmed live as a visible flicker: the badge briefly
		// reverting moments after marking a message read, then correcting
		// itself again on the next sync after that.
		let account
		let mailbox

		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
			mailbox = store.mailboxes[11]
		})

		it('corrects a stale server count that does not yet reflect an unconfirmed "marked read"', () => {
			const envelope = { databaseId: 42, mailboxId: 11, flags: { seen: false } }
			store.addEnvelopesMutation({ query: '', envelopes: [envelope] })
			// Optimistically marks read -- flagEnvelopeMutation()'s own
			// 'seen' branch already decremented mailbox.unread once for
			// this; the server hasn't independently confirmed it yet.
			store.flagEnvelopeMutation({ envelope, flag: 'seen', value: true })

			// A sync computed before the read landed server-side still
			// reports the old, higher count.
			store.setMailboxUnreadCountMutation({ id: 11, unread: 5 })

			expect(mailbox.unread).toBe(4)
		})

		it('corrects a stale server count that does not yet reflect an unconfirmed "marked unread"', () => {
			const envelope = { databaseId: 43, mailboxId: 11, flags: { seen: true } }
			store.addEnvelopesMutation({ query: '', envelopes: [envelope] })
			store.flagEnvelopeMutation({ envelope, flag: 'seen', value: false })

			store.setMailboxUnreadCountMutation({ id: 11, unread: 5 })

			expect(mailbox.unread).toBe(6)
		})

		it('applies no correction once the change is independently confirmed by the same sync', () => {
			const envelope = { databaseId: 44, mailboxId: 11, flags: { seen: false } }
			store.addEnvelopesMutation({ query: '', envelopes: [envelope] })
			store.flagEnvelopeMutation({ envelope, flag: 'seen', value: true })

			// The confirming sync response processes changedMessages (via
			// updateEnvelopeMutation(), which flips confirmed true) before
			// setMailboxUnreadCountMutation() runs -- the server's own
			// count already reflects the change by the time it gets here.
			store.updateEnvelopeMutation({ envelope: { databaseId: 44, mailboxId: 11, flags: { seen: true } } })
			store.setMailboxUnreadCountMutation({ id: 11, unread: 4 })

			expect(mailbox.unread).toBe(4)
		})

		it('applies no correction for an envelope belonging to a different mailbox', () => {
			store.addMailboxMutation({
				account,
				mailbox: { id: 'Archive', name: 'Archive', databaseId: 12, accountId: 13, specialRole: 'archive' },
			})
			const envelope = { databaseId: 45, mailboxId: 12, flags: { seen: false } }
			store.addEnvelopesMutation({ query: '', envelopes: [envelope] })
			store.flagEnvelopeMutation({ envelope, flag: 'seen', value: true })

			store.setMailboxUnreadCountMutation({ id: 11, unread: 5 })

			expect(mailbox.unread).toBe(5)
		})

		it('applies no correction once the grace window has expired', () => {
			vi.useFakeTimers()
			try {
				const envelope = { databaseId: 46, mailboxId: 11, flags: { seen: false } }
				store.addEnvelopesMutation({ query: '', envelopes: [envelope] })
				store.flagEnvelopeMutation({ envelope, flag: 'seen', value: true })

				vi.advanceTimersByTime(121 * 1000)
				store.setMailboxUnreadCountMutation({ id: 11, unread: 5 })

				expect(mailbox.unread).toBe(5)
			} finally {
				vi.useRealTimers()
			}
		})

		it('never lets the corrected count go negative', () => {
			// Marked read but unconfirmed -> correction is -1; a server
			// count that has already dropped to 0 by some other means
			// must not be pushed below zero by this correction.
			const envelope = { databaseId: 47, mailboxId: 11, flags: { seen: false } }
			store.addEnvelopesMutation({ query: '', envelopes: [envelope] })
			store.flagEnvelopeMutation({ envelope, flag: 'seen', value: true })

			store.setMailboxUnreadCountMutation({ id: 11, unread: 0 })

			expect(mailbox.unread).toBe(0)
		})

		it('still resets to 0 for an explicit clear (unread omitted), bypassing correction', () => {
			const envelope = { databaseId: 48, mailboxId: 11, flags: { seen: false } }
			store.addEnvelopesMutation({ query: '', envelopes: [envelope] })
			store.flagEnvelopeMutation({ envelope, flag: 'seen', value: true })

			store.setMailboxUnreadCountMutation({ id: 11 })

			expect(mailbox.unread).toBe(0)
		})
	})

	describe('startComposerSession reply-to resolution', () => {
		const account = {
			id: 1,
			emailAddress: 'me@example.com',
			personalNamespace: '',
			mailboxes: [],
			name: 'Me',
		}
		const from = [{ email: 'sender@example.com', label: 'Sender' }]
		const to = [{ email: 'me@example.com', label: 'Me' }]
		const replyTo = [{ email: 'personal-replyto@example.com', label: 'Reply Here' }]

		const makeEnvelope = (overrides = {}) => ({
			databaseId: 42,
			accountId: 1,
			from,
			to,
			replyTo: undefined,
			subject: 'Test subject',
			...overrides,
		})

		const makeOriginal = (overrides = {}) => ({
			databaseId: 42,
			hasHtmlBody: false,
			body: 'Message body',
			replyTo: undefined,
			unsubscribeUrl: null,
			unsubscribeMailto: null,
			...overrides,
		})

		beforeEach(() => {
			store.addAccountMutation(account)
			vi.spyOn(store, 'startComposerSessionMutation')
		})

		it('uses From for mailing list emails even when Reply-To is set', async () => {
			MessageService.fetchMessage.mockResolvedValue(makeOriginal({
				replyTo,
				unsubscribeUrl: 'https://list.example.com/unsubscribe',
			}))

			await store.startComposerSession({
				reply: {
					mode: 'reply',
					data: makeEnvelope({ replyTo }),
				},
			})

			expect(store.startComposerSessionMutation).toHaveBeenCalledWith(expect.objectContaining({
				data: expect.objectContaining({ to: from }),
			}))
		})

		it('honours Reply-To for regular emails with a personal Reply-To', async () => {
			MessageService.fetchMessage.mockResolvedValue(makeOriginal({ replyTo }))

			await store.startComposerSession({
				reply: {
					mode: 'reply',
					data: makeEnvelope({ replyTo }),
				},
			})

			expect(store.startComposerSessionMutation).toHaveBeenCalledWith(expect.objectContaining({
				data: expect.objectContaining({ to: replyTo }),
			}))
		})

		it('uses To for own sent messages (isOwnMessage follow-up)', async () => {
			const ownFrom = [{ email: 'me@example.com', label: 'Me' }]
			MessageService.fetchMessage.mockResolvedValue(makeOriginal())

			await store.startComposerSession({
				reply: {
					mode: 'reply',
					data: makeEnvelope({ from: ownFrom }),
				},
			})

			expect(store.startComposerSessionMutation).toHaveBeenCalledWith(expect.objectContaining({
				data: expect.objectContaining({ to }),
			}))
		})

		it('uses To when followUp flag is set', async () => {
			MessageService.fetchMessage.mockResolvedValue(makeOriginal())

			await store.startComposerSession({
				reply: {
					mode: 'reply',
					data: makeEnvelope(),
					followUp: true,
				},
			})

			expect(store.startComposerSessionMutation).toHaveBeenCalledWith(expect.objectContaining({
				data: expect.objectContaining({ to }),
			}))
		})
	})

	describe('trimIdleEnvelopeListTailMutation: idle-and-unselected tail trimming', () => {
		beforeEach(() => {
			normalizedEnvelopeListId.mockImplementation((query) => query ?? '')
			const account = { id: 13, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account)
			store.addMailboxMutation({
				account,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 11, accountId: 13, specialRole: 'inbox' },
			})
		})

		// A little over the baseline (100) so the tail is non-empty but
		// small, keeping each test's own setup readable.
		const seedList = (count) => {
			const ids = []
			for (let i = 1; i <= count; i++) {
				store.envelopes[i] = { databaseId: i, mailboxId: 11, accountId: 13 }
				ids.push(i)
			}
			store.mailboxes[11].envelopeLists[''] = ids
			return ids
		}

		it('trims the tail back to the baseline size', () => {
			seedList(105)

			store.trimIdleEnvelopeListTailMutation({ mailboxId: 11, query: undefined })

			expect(store.mailboxes[11].envelopeLists['']).toHaveLength(100)
			expect(store.mailboxes[11].envelopeLists['']).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
		})

		it('does nothing when the list is at or under the baseline', () => {
			const ids = seedList(100)

			store.trimIdleEnvelopeListTailMutation({ mailboxId: 11, query: undefined })

			expect(store.mailboxes[11].envelopeLists['']).toEqual(ids)
		})

		it('keeps the whole list when a selected row is inside the tail', () => {
			const ids = seedList(105)
			store.setListSelectionMutation({ mailboxId: 11, query: undefined, selectedIds: [105] })

			store.trimIdleEnvelopeListTailMutation({ mailboxId: 11, query: undefined })

			expect(store.mailboxes[11].envelopeLists['']).toEqual(ids)
		})

		it('still trims the tail when the only selected row is in the kept head', () => {
			seedList(105)
			store.setListSelectionMutation({ mailboxId: 11, query: undefined, selectedIds: [1] })

			store.trimIdleEnvelopeListTailMutation({ mailboxId: 11, query: undefined })

			expect(store.mailboxes[11].envelopeLists['']).toHaveLength(100)
			expect(store.mailboxes[11].envelopeLists['']).toContain(1)
		})

		it('combines selections reported by multiple grouped-list owners', () => {
			const ids = seedList(105)
			store.setListSelectionMutation({ mailboxId: 11, query: undefined, ownerId: 1, selectedIds: [1] })
			store.setListSelectionMutation({ mailboxId: 11, query: undefined, ownerId: 2, selectedIds: [105] })
			store.setListSelectionMutation({ mailboxId: 11, query: undefined, ownerId: 1, selectedIds: [] })

			store.trimIdleEnvelopeListTailMutation({ mailboxId: 11, query: undefined })

			expect(store.mailboxes[11].envelopeLists['']).toEqual(ids)
		})

		it('garbage-collects this.messages/this.envelopes for a dropped id not referenced anywhere else', () => {
			seedList(105)
			store.messages[105] = { databaseId: 105, body: 'hello' }

			store.trimIdleEnvelopeListTailMutation({ mailboxId: 11, query: undefined })

			expect(store.envelopes[105]).toBeUndefined()
			expect(store.messages[105]).toBeUndefined()
		})

		it('leaves this.envelopes/this.messages alone for a dropped id still referenced by another loaded list', () => {
			seedList(105)
			store.messages[105] = { databaseId: 105, body: 'hello' }
			// e.g. the same message also visible via a different bucket/
			// the unified fan-out.
			store.mailboxes[11].envelopeLists['is:starred'] = [105]

			store.trimIdleEnvelopeListTailMutation({ mailboxId: 11, query: undefined })

			expect(store.envelopes[105]).toBeDefined()
			expect(store.messages[105]).toBeDefined()
		})

		it('leaves this.envelopes/this.messages alone for a dropped id that is the currently open thread', () => {
			seedList(105)
			store.messages[105] = { databaseId: 105, body: 'hello' }
			store.setCurrentOpenThreadIdMutation(105)

			store.trimIdleEnvelopeListTailMutation({ mailboxId: 11, query: undefined })

			expect(store.envelopes[105]).toBeDefined()
			expect(store.messages[105]).toBeDefined()
		})

		it('trims Priority Inbox constituent buckets and releases their dropped lookahead caches', () => {
			const account17 = { id: 17, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account17)
			store.addMailboxMutation({
				account: account17,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 12, accountId: 17, specialRole: 'inbox' },
			})

			const query = 'is:pi-other'
			normalizedEnvelopeListId.mockImplementation((value) => value ?? '')
			const virtualIds = []
			const mailbox11Ids = []
			const mailbox12Ids = []
			for (let i = 1; i <= 120; i++) {
				const mailboxId = i % 2 === 0 ? 12 : 11
				store.envelopes[i] = { databaseId: i, mailboxId, accountId: mailboxId === 11 ? 13 : 17 }
				virtualIds.push(i)
				if (mailboxId === 11) {
					mailbox11Ids.push(i)
				} else {
					mailbox12Ids.push(i)
				}
			}
			// Constituent pagination can hold lookahead rows that have not
			// yet been appended to the virtual page.
			store.envelopes[121] = { databaseId: 121, mailboxId: 11, accountId: 13 }
			store.messages[121] = { databaseId: 121, body: 'lookahead' }
			mailbox11Ids.push(121)
			store.mailboxes.priority.envelopeLists[query] = virtualIds
			store.mailboxes[11].envelopeLists[query] = mailbox11Ids
			store.mailboxes[12].envelopeLists[query] = mailbox12Ids

			const result = store.trimIdleEnvelopeListTailMutation({ mailboxId: 'priority', query })

			expect(result).toEqual({ trimmedCount: 20, constituentTrimmedCount: 21 })
			expect(store.mailboxes.priority.envelopeLists[query]).toEqual(virtualIds.slice(0, 100))
			expect(store.mailboxes[11].envelopeLists[query]).toEqual(mailbox11Ids.filter((id) => id <= 100))
			expect(store.mailboxes[12].envelopeLists[query]).toEqual(mailbox12Ids.filter((id) => id <= 100))
			expect(store.envelopes[121]).toBeUndefined()
			expect(store.messages[121]).toBeUndefined()
		})

		it('keeps one pagination anchor for a constituent absent from the virtual head', () => {
			const account17 = { id: 17, personalNamespace: '', mailboxes: [] }
			store.addAccountMutation(account17)
			store.addMailboxMutation({
				account: account17,
				mailbox: { id: 'INBOX', name: 'INBOX', databaseId: 12, accountId: 17, specialRole: 'inbox' },
			})

			const query = 'is:pi-other'
			normalizedEnvelopeListId.mockImplementation((value) => value ?? '')
			const virtualIds = seedList(105)
			store.mailboxes.priority.envelopeLists[query] = virtualIds
			store.envelopes[201] = { databaseId: 201, mailboxId: 12, accountId: 17 }
			store.envelopes[202] = { databaseId: 202, mailboxId: 12, accountId: 17 }
			store.mailboxes[12].envelopeLists[query] = [201, 202]

			store.trimIdleEnvelopeListTailMutation({ mailboxId: 'priority', query })

			expect(store.mailboxes[12].envelopeLists[query]).toEqual([201])
			expect(store.envelopes[201]).toBeDefined()
			expect(store.envelopes[202]).toBeUndefined()
		})
	})
})
