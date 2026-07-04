/**
 * SPDX-FileCopyrightText: 2020-2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createPinia, setActivePinia } from 'pinia'
import { curry, range, reverse } from 'ramda'
import MailboxLockedError from '../../../errors/MailboxLockedError.js'
import * as AccountService from '../../../service/AccountService.js'
import * as MailboxService from '../../../service/MailboxService.js'
import * as MessageService from '../../../service/MessageService.js'
import * as NotificationService from '../../../service/NotificationService.js'
import { PAGE_SIZE, UNIFIED_INBOX_ID } from '../../../store/constants.js'
import useMainStore from '../../../store/mainStore.js'
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

			await store.syncInboxes()

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
			store.syncEnvelopes = vi.fn(async () => [{ id: 123 }, { id: 321 }])

			await store.syncInboxes()

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
			// Here we expect notifications
			expect(NotificationService.showNewMessagesNotification).toHaveBeenCalled()
		})

		it('syncs every already-loaded query bucket of a mailbox, not just the default', async () => {
			// Reproduces a real bug: when "sort favorites separately" is on, the
			// visible list reads from envelopeLists['not:starred'], but syncInboxes()
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

			await store.syncInboxes()

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

			const syncPromise = store.syncInboxes()

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
