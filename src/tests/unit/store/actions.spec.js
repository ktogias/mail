/**
 * SPDX-FileCopyrightText: 2020-2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createPinia, setActivePinia } from 'pinia'
import { curry, range, reverse } from 'ramda'
import MailboxLockedError from '../../../errors/MailboxLockedError.js'
import MalformedSyncResponseError from '../../../errors/MalformedSyncResponseError.js'
import * as AccountService from '../../../service/AccountService.js'
import * as MailboxService from '../../../service/MailboxService.js'
import * as MessageService from '../../../service/MessageService.js'
import * as NotificationService from '../../../service/NotificationService.js'
import { PAGE_SIZE, UNIFIED_INBOX_ID } from '../../../store/constants.js'
import useMainStore from '../../../store/mainStore.js'
import { computeLockRetryDelayMs } from '../../../store/mainStore/actions.js'
import { normalizedEnvelopeListId } from '../../../util/normalization.js'
import { wait } from '../../../util/wait.js'

vi.mock('../../../service/AccountService.js')
vi.mock('../../../service/MailboxService.js')
vi.mock('../../../service/MessageService.js')
vi.mock('../../../service/NotificationService.js')
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
			// with favorites split out -- both buckets already exist in the store.
			store.mailboxes[11].envelopeLists[''] = []
			store.mailboxes[11].envelopeLists['not:starred'] = []

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
				query: 'not:starred',
			})
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

			store.mailboxes[11].envelopeLists[''] = []
			store.mailboxes[11].envelopeLists['not:starred'] = []

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

		it('syncWatchedMailboxes skips the whole tick while interaction priority is active', async () => {
			store.addMailboxMutation({
				account: account13,
				mailbox: { name: 'INBOX', databaseId: 5, specialRole: 'inbox' },
			})
			store.setInteractionPriorityMutation()

			await store.syncWatchedMailboxes()

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
})
