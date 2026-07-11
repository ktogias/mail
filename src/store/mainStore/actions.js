/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import axios from '@nextcloud/axios'
import { showError, showWarning, TOAST_DEFAULT_TIMEOUT } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import DOMPurify from 'dompurify'
import escapeRegExp from 'lodash/fp/escapeRegExp.js'
import flatMapDeep from 'lodash/fp/flatMapDeep.js'
import isEqual from 'lodash/fp/isEqual.js'
import orderBy from 'lodash/fp/orderBy.js'
import uniq from 'lodash/fp/uniq.js'
import {
	andThen,
	complement,
	curry,
	defaultTo,
	filter,
	flatten,
	gt,
	head,
	identity,
	last,
	lt,
	map,
	pipe,
	prop,
	propEq,
	slice,
	sortBy,
	tap,
	where,
} from 'ramda'
import Vue from 'vue'
import MailboxLockedError from '../../errors/MailboxLockedError.js'
import MalformedSyncResponseError from '../../errors/MalformedSyncResponseError.js'
import { matchError } from '../../errors/match.js'
import SyncIncompleteError from '../../errors/SyncIncompleteError.js'
import { handleHttpAuthErrors } from '../../http/sessionExpiryHandler.js'
import { sortMailboxes } from '../../imap/MailboxSorter.js'
import logger from '../../logger.js'
import {
	buildForwardSubject,
	buildRecipients as buildReplyRecipients,
	buildReplySubject,
} from '../../ReplyBuilder.js'
import {
	create as createAccount,
	deleteAccount,
	fetch as fetchAccount,
	fetchAll as fetchAllAccounts,
	patch as patchAccount,
	update as updateAccount,
	updateSmimeCertificate as updateAccountSmimeCertificate,
	updateSignature,
} from '../../service/AccountService.js'
import * as AliasService from '../../service/AliasService.js'
import {
	findAll,
	getCurrentUserPrincipal,
	initializeClientForUserView,
} from '../../service/caldavService.js'
import { moveDraft, updateDraft } from '../../service/DraftService.js'
import * as FollowUpService from '../../service/FollowUpService.js'
import {
	addInternalAddress,
	removeInternalAddress,
} from '../../service/InternalAddressService.js'
import {
	clearMailbox,
	create as createMailbox,
	deleteMailbox,
	fetchAll as fetchAllMailboxes,
	markMailboxRead,
	patchMailbox,
} from '../../service/MailboxService.js'
import {
	createEnvelopeTag,
	deleteMessage,
	deleteTag,
	fetchEnvelope,
	fetchEnvelopes,
	fetchMessage,
	fetchMessageDkim,
	fetchMessageHtmlBody,
	fetchMessageItineraries,
	fetchThread,
	moveMessage,
	removeEnvelopeTag,
	setEnvelopeFlags,
	setEnvelopeTag,
	snoozeMessage,
	syncEnvelopes as syncEnvelopesExternal,
	unSnoozeMessage,
	updateEnvelopeTag,
} from '../../service/MessageService.js'
import { showNewMessagesNotification } from '../../service/NotificationService.js'
import { savePreference } from '../../service/PreferenceService.js'
import {
	createQuickAction,
	deleteQuickAction,
	updateQuickAction,
} from '../../service/QuickActionsService.js'
import {
	getActiveScript,
	updateActiveScript,
	updateAccount as updateSieveAccount,
} from '../../service/SieveService.js'
import * as SmimeCertificateService
	from '../../service/SmimeCertificateService.js'
import {
	createTextBlock,
	deleteTextBlock,
	fetchMyTextBlocks,
	fetchSharedTextBlocks,
	updateTextBlock,
} from '../../service/TextBlockService.js'
import * as ThreadService from '../../service/ThreadService.js'
import { normalizedEnvelopeListId } from '../../util/normalization.js'
import {
	getPrioritySearchQueries,
	priorityImportantQuery,
	priorityOtherQuery,
} from '../../util/priorityInbox.js'
import { wait } from '../../util/wait.js'
import {
	FOLLOW_UP_MAILBOX_ID,
	FOLLOW_UP_TAG_LABEL,
	PAGE_SIZE,
	PRIORITY_INBOX_ID,
	UNIFIED_ACCOUNT_ID,
	UNIFIED_INBOX_ID,
} from '../constants.js'
import useOutboxStore from '../outboxStore.js'

/**
 * @todo Type definition for ComposerSessionData is incomplete
 *
 * @typedef {object} ComposerSessionData
 * @property {boolean} isHtml whether this is a html message
 * @property {string} bodyHtml the body as html
 * @property {string} bodyPlain the body as plain text
 */

const sliceToPage = slice(0, PAGE_SIZE)

const findIndividualMailboxes = curry((getMailboxes, specialRole) => pipe(
	filter(complement(prop('isUnified'))),
	map(prop('id')),
	map(getMailboxes),
	flatten,
	filter(propEq(specialRole, 'specialRole')),
))

function combineEnvelopeLists(sortOrder) {
	if (sortOrder === 'oldest') {
		return pipe(flatten, orderBy(prop('dateInt'), 'asc'))
	}

	return pipe(flatten, orderBy(prop('dateInt'), 'desc'))
}

const addMailboxToState = curry((mailboxes, account, mailbox) => {
	mailbox.accountId = account.id
	mailbox.mailboxes = []
	Vue.set(mailbox, 'envelopeLists', {})

	transformMailboxName(account, mailbox)

	Vue.set(mailboxes, mailbox.databaseId, mailbox)
	const parent = Object.values(mailboxes)
		.filter((mb) => mb.accountId === account.id)
		.find((mb) => mb.name === mailbox.path)
	if (mailbox.path === '' || !parent) {
		account.mailboxes.push(mailbox.databaseId)
	} else {
		parent.mailboxes.push(mailbox.databaseId)
	}

	Object.defineProperty(mailbox, 'isSubscribed', {
		get() {
			return this.attributes?.includes('\\subscribed') ?? false
		},
	})
})

function transformMailboxName(account, mailbox) {
	// Add all mailboxes (including submailboxes to state, but only toplevel to account
	const nameWithoutPrefix = account.personalNamespace
		? mailbox.name.replace(new RegExp(escapeRegExp(account.personalNamespace)), '')
		: mailbox.name
	if (nameWithoutPrefix.includes(mailbox.delimiter)) {
		/**
		 * Sub-mailbox, e.g. 'Archive.2020' or 'INBOX.Archive.2020'
		 */
		mailbox.displayName = mailbox.name.substring(mailbox.name.lastIndexOf(mailbox.delimiter) + 1)
		mailbox.path = mailbox.name.substring(0, mailbox.name.lastIndexOf(mailbox.delimiter))
	} else if (account.personalNamespace && mailbox.name.startsWith(account.personalNamespace)) {
		/**
		 * Top-level mailbox, but with a personal namespace, e.g. 'INBOX.Sent'
		 */
		mailbox.displayName = nameWithoutPrefix
		mailbox.path = account.personalNamespace
	} else {
		/**
		 * Top-level mailbox, e.g. 'INBOX' or 'Draft'
		 */
		mailbox.displayName = nameWithoutPrefix
		mailbox.path = ''
	}
}

// A mailbox sync lock is mailbox-wide, not per-query. Several independent
// call sites can all be syncing the same mailbox concurrently (App.vue's
// background loop across several query buckets -- now sequenced internally,
// see syncWatchedMailboxes() -- and Mailbox.vue's own per-instance timer,
// doubled up when "sort favorites separately" renders two separate Mailbox
// components for one mailbox). Without coordination, every one of them
// independently re-triggers its own 1.5s retry-on-lock loop against the same
// lock, multiplying request volume by however many call sites happen to be
// syncing that mailbox at once -- confirmed live: a genuinely long-held
// lock on a slow account produced a sustained ~1 request/second 409 storm.
// This map lets only one such retry loop actually run per mailbox at a
// time; anyone else who hits the same lock just awaits it instead of
// starting their own.
const pendingLockWaits = new Map()

// Thread.vue prefetches the clicked message's body in parallel with the
// thread listing (instead of waiting for the thread to resolve and
// ThreadEnvelope.vue to mount before firing it), so that call and
// ThreadEnvelope.vue's own later fetchMessage() call for the same id can
// land within milliseconds of each other -- before the prefetch's
// network request has resolved, so the `this.messages[id]` cache check
// alone wouldn't catch it. This map lets the second caller await the
// first's in-flight request instead of firing a duplicate one.
const pendingMessageFetches = new Map()

// Same reasoning, same fix, for fetchThread(): Envelope.vue's hover
// prefetch and Thread.vue's own open-thread call independently fetch
// the SAME thread id whenever a hover lands just before a click (very
// common -- hovering is usually how the click happens). Without dedup
// here, Thread.vue documented the resulting race directly in its own
// fetchThread() catch block: one of the two redundant requests could
// reject (timeout, transient error) AFTER the other had already
// resolved and populated the store, flipping an already-correctly-
// loaded thread to "Δεν βρέθηκε" for no real reason. That catch-block
// workaround is a symptom guard, not a fix -- it papers over the
// duplicate request instead of preventing it. This map does the same
// job pendingMessageFetches does above: the second caller awaits the
// first's in-flight request instead of firing its own.
const pendingThreadFetches = new Map()

// Upper bound for a single message/thread fetch -- see fetchMessage()
// for the reasoning. Well above the slowest legitimate fetch observed
// (~25-60s cache-miss body via a slow provider), well below forever.
const FETCH_MESSAGE_TIMEOUT_MS = 90 * 1000

// toggleEnvelopeSeen()/toggleEnvelopeJunk()/markEnvelopeFavoriteOrUnfavorite()
// all optimistically set a flag via flagEnvelopeMutation() and await their
// own PUT to confirm it -- but a completely independent sync request
// (the watched-mailbox poller, or another Mailbox instance's own sync()
// firing because the user switched threads) can resolve AFTER that PUT
// and still report the message's PRE-PUT flags: SyncService.php reports
// every known message as "changed" on every sync, not a real changed
// set (see updateEnvelopeMutation() below), so this isn't a rare edge
// case -- any sync racing the PUT will do it. Confirmed live: marking a
// message read updated the list correctly, then reverted to
// unread/bold the moment the user opened a different thread. This map
// lets a flag mutation protect itself from being clobbered by a stale
// sync response for a short window after being set.
const RECENT_FLAG_CHANGE_GRACE_MS = 20 * 1000
const recentFlagChanges = new Map()

/**
 * A flag this client changed moments ago (see flagEnvelopeMutation())
 * wins over whatever a sync/listing response says, since that response
 * may have been generated before the server-side change actually
 * landed. Anything NOT recently changed locally still comes straight
 * from the server.
 *
 * @param {string|number} envelopeId
 * @param {object} incomingFlags
 * @return {object}
 */
function withRecentFlagOverrides(envelopeId, incomingFlags) {
	const perEnvelope = recentFlagChanges.get(envelopeId)
	if (!perEnvelope) {
		return incomingFlags
	}
	const now = Date.now()
	let overridden
	for (const [flag, change] of perEnvelope) {
		if (change.expiresAt <= now) {
			perEnvelope.delete(flag)
			continue
		}
		if (incomingFlags[flag] !== change.value) {
			overridden = overridden || { ...incomingFlags }
			overridden[flag] = change.value
		}
	}
	if (perEnvelope.size === 0) {
		recentFlagChanges.delete(envelopeId)
	}
	return overridden || incomingFlags
}

/**
 * Whether some caller is already mid-retry against mailbox's lock.
 *
 * Used by syncWatchedMailboxes() to skip a mailbox entirely for the current
 * tick rather than queue up yet another "await the leader, then try again"
 * chain on top of an already-running one -- see the tick-piling comment
 * there for why that matters once ticks fire every ~10s instead of once
 * every 30-60s.
 *
 * @param mailboxId
 */
export function isMailboxSyncRetryPending(mailboxId) {
	return pendingLockWaits.has(mailboxId)
}

// Tracks mailboxes syncWatchedMailboxes() is *currently* working through
// (registered before its bucket loop starts, cleared once that loop ends --
// success or failure). isMailboxSyncRetryPending()/pendingLockWaits only
// starts tracking a mailbox once a request has actually FAILED with
// MailboxLockedError; it says nothing about a call that's simply still
// in flight, taking longer than one ~10-15s tick to get through every
// loaded query bucket (ordinary IMAP latency, no error at all). Without
// this, a new tick firing before the previous one finished for the same
// mailbox would start a SECOND, fully independent bucket loop for it --
// and since Mailbox::LOCK_TIMEOUT locking is acquired in three separate
// steps (new/changed/vanished) with no yield between them for a single
// caller, two genuinely concurrent callers racing those three lock
// acquisitions against each other can leave one of them holding a
// partially-acquired lock that's never released until it expires
// naturally (up to the full 300s) -- confirmed live: mailbox 31, polled
// by a single tab with no other client involved, kept hitting a 409 with
// a Retry-After close to the full lock timeout on a clean, repeating
// cycle, which is the signature of a genuine (not merely advisory) held
// lock recurring, not of the pessimistic Retry-After estimate alone.
const watchedMailboxSyncsInFlight = new Set()

// How long a direct user action (opening a message, switching folders,
// starring/deleting/flagging, ...) gets priority over the background
// watched-mailbox poller. Long enough to cover a normal interaction's
// full request sequence; short enough to self-heal quickly and get out
// of the way once the user goes idle, without needing a matching "clear"
// call at every possible exit path (including errors) of every
// interaction it guards -- the same self-healing-via-expiry shape as
// the load counter TTL and the lock-retry backoff above.
const INTERACTION_PRIORITY_WINDOW_MS = 4000

// How many watched mailboxes' background syncs syncWatchedMailboxes()
// runs concurrently. Unbounded concurrency (the previous behavior) meant
// a single poll tick fired requests for every watched mailbox at once --
// confirmed live via HAR: 9 mailboxes' sync responses landing and being
// reactively processed within the same couple of seconds a user opened
// an email, visibly starving the main thread while the message's
// already-fetched content sat ready to render, but hadn't painted yet.
// A small pool keeps the poller making steady progress without
// contending that heavily with foreground work.
const WATCHED_SYNC_CONCURRENCY = 3

// Per-list cap on the unified/priority-inbox constituent fetches in
// fetchEnvelopes(). The priority inbox fetches up to 3 sections
// concurrently, so the total in-flight requests of one search is
// 3 x this -- keep the product comfortably below the FPM pool size.
const ENVELOPE_FETCH_CONCURRENCY = 3

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once.
 *
 * Each item's own promise settles independently -- unlike Promise.all,
 * one item throwing does not reject the others. Callers are expected to
 * handle their own errors inside `fn`, matching how the previous
 * unbounded Promise.all fan-out already behaved here.
 *
 * @param items
 * @param limit
 * @param fn
 */
async function mapWithConcurrencyLimit(items, limit, fn) {
	const results = new Array(items.length)
	let nextIndex = 0
	async function worker() {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex++
			results[currentIndex] = await fn(items[currentIndex], currentIndex)
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
	return results
}

const LOCK_RETRY_BASE_MS = 1500
const LOCK_RETRY_MAX_MS = 30 * 1000
// A mailbox freshly locked near the start of a long sync can have nearly
// the full Mailbox::LOCK_TIMEOUT (300s) left on its Retry-After -- honoring
// that server hint verbatim (see below) meant a caller could go up to ~6
// minutes between retries. That's tolerable for a one-off manual sync, but
// syncWatchedMailboxes()'s ~10s-cadence poller explicitly needs any one
// stuck mailbox's own backoff to stay within 1-2 minutes, since every
// watched mailbox skips re-attempting a mailbox for as long as its retry is
// pending (see isMailboxSyncRetryPending()). Confirmed live: mailbox 31 got
// a fresh lock, computed an uncapped ~5-6 minute delay, and every tick
// skipped it for that entire window -- the badge and message list for that
// mailbox simply didn't move until the wait finally elapsed.
const LOCK_RETRY_ABSOLUTE_MAX_MS = 90 * 1000
// The by far most common 409 is a transient collision -- two windows'
// jittered ~10-15s ticks landing on the same mailbox together -- where the
// loser's mailbox is actually free again well under a second later, because
// a healthy sync releases its lock almost immediately. The server's
// Retry-After cannot tell that case apart from a genuinely long sync (it
// only knows the worst case: the holder keeping the lock for its entire
// remaining window), so honoring it even capped meant every lost collision
// cost that window up to ~90s of silence on that mailbox -- confirmed live
// as a 93s gap in an otherwise ~10-15s sync cadence, exactly while a new
// message was arriving. The first retry therefore probes quickly (a 409
// reject is cheap: one DB row check, no IMAP); only a mailbox found STILL
// locked on that probe -- a genuinely long sync, not a collision -- gets
// the server's estimate honored from the second attempt on.
const LOCK_RETRY_FIRST_PROBE_MS = 10 * 1000

/**
 * How long to wait before the next lock-retry attempt.
 *
 * When the server tells us how long its lock has left (retryAfterMs, from
 * the Retry-After response header), that's a worst-case estimate -- it
 * assumes the current holder uses its full lock window, which real syncs
 * rarely do. Treat it as a floor and jitter proportionally above it, not
 * just by a flat ~1s: a flat jitter leaves every caller that lost the same
 * race retrying at (near enough) the same fixed cadence, which can resonate
 * with any other fixed-interval poller and starve one caller indefinitely.
 * Confirmed live: a Priority Inbox query bucket kept losing its mailbox lock
 * race to its own sibling buckets for over two hours, because the ~300s
 * Retry-After it kept receiving is an exact multiple of the 60s background
 * poll interval those siblings run on, so every retry landed on a fresh
 * collision. Proportional jitter spreads retries across a wide enough
 * window to break that phase-lock within a couple of attempts.
 *
 * Kept deliberately modest (up to 20%, not 50%): the jitter only needs to be
 * wide enough to eventually escape a resonant collision with a fixed-interval
 * poller, which a random walk does within a handful of retries even at a
 * fairly small spread. A wider spread doesn't resolve resonance any faster,
 * it just adds avoidable wait on top of retries that were never resonating
 * with anything in the first place -- confirmed live: a mailbox undergoing a
 * genuinely long, still-in-progress sync (not periodic-poller resonance) had
 * every retry pushed out by up to 50% for no corresponding benefit, making
 * an already slow mailbox feel even less responsive.
 *
 * Otherwise, fall back to exponential backoff with full jitter (see the AWS
 * Architecture Blog's "Exponential Backoff and Jitter"): the delay's upper
 * bound grows with each attempt, and the actual wait is randomized across
 * the full range up to that bound. This is what actually protects a
 * contended mailbox lock from several independent, uncoordinated clients
 * (different browser tabs, devices, or users) -- unlike a fixed retry
 * interval, which just means every such client keeps hammering the lock at
 * the same fixed cadence for as long as it stays held.
 *
 * @param attempt
 * @param retryAfterMs
 */
export function computeLockRetryDelayMs(attempt, retryAfterMs) {
	if (retryAfterMs !== undefined) {
		// First retry after a 409: quick probe for the transient-collision
		// case (see LOCK_RETRY_FIRST_PROBE_MS above). A hint shorter than
		// the probe window is still honored as the floor.
		if (attempt === 0) {
			return Math.min(retryAfterMs, LOCK_RETRY_FIRST_PROBE_MS) * (1 + Math.random() * 0.2)
		}
		return Math.min(retryAfterMs * (1 + Math.random() * 0.2), LOCK_RETRY_ABSOLUTE_MAX_MS)
	}

	const upperBound = Math.min(LOCK_RETRY_MAX_MS, LOCK_RETRY_BASE_MS * (2 ** attempt))
	return Math.random() * upperBound
}

export default function mainStoreActions() {
	return {
		updateSyncTimestamp() {
			this.syncTimestamp = Date.now()
		},
		savePreference({
			key,
			value,
		}) {
			return handleHttpAuthErrors(async () => {
				const newValue = await savePreference(key, value)
				this.savePreferenceMutation({
					key,
					value: newValue.value,
				})
			})
		},
		async fetchAccounts() {
			return handleHttpAuthErrors(async () => {
				const accounts = await fetchAllAccounts()
				accounts.forEach((account) => this.addAccountMutation(account))
				return this.getAccounts
			})
		},
		async fetchAccount(id) {
			return handleHttpAuthErrors(async () => {
				const account = await fetchAccount(id)
				this.addAccountMutation(account)
				return account
			})
		},
		async startAccountSetup(config) {
			const account = await createAccount(config)
			logger.debug(`account ${account.id} created`, { account })
			return account
		},
		async syncMailboxesForAccount(account) {
			logger.debug(`Fetching mailboxes for account ${account.id},  …`, { account })
			account.mailboxes = await fetchAllMailboxes(account.id, true)
			const mailboxes = sortMailboxes(account.mailboxes || [], account)
			Vue.set(account, 'mailboxes', [])
			mailboxes.map(addMailboxToState(this.mailboxes, account))
		},
		async finishAccountSetup({ account }) {
			logger.debug(`Fetching mailboxes for account ${account.id},  …`, { account })
			account.mailboxes = await fetchAllMailboxes(account.id)
			this.addAccountMutation(account)
			logger.debug('New account mailboxes fetched', {
				account,
				mailboxes: account.mailboxes,
			})
			return account
		},
		async updateAccount(config) {
			return handleHttpAuthErrors(async () => {
				const account = await updateAccount(config)
				logger.debug('account updated', { account })
				this.editAccountMutation({ ...account, error: false })
				// Non-fatal: the account update itself already succeeded.
				// Failing here failed the whole action -- which broke OAuth
				// reconnection outright, a chicken-and-egg deadlock: the
				// "Reconnect Google account" flow calls this action BEFORE
				// opening the consent popup, this forced sync can't work
				// while the account's token is expired (that's the whole
				// reason the user is reconnecting), so the throw aborted the
				// flow before the popup code was ever reached, and the token
				// could never be renewed. Confirmed live against a Gmail
				// account whose refresh token Google had expired.
				try {
					await this.syncMailboxesForAccount(this.accountsUnmapped[account.id])
				} catch (error) {
					logger.warn(`Could not sync mailboxes for updated account ${account.id} -- continuing, the update itself succeeded`, { error })
				}
				return account
			})
		},
		async patchAccount({
			account,
			data,
		}) {
			return handleHttpAuthErrors(async () => {
				const patchedAccount = await patchAccount(account, data)
				logger.debug('account patched', {
					account: patchedAccount,
					data,
				})
				this.patchAccountMutation({
					account,
					data,
				})
				return account
			})
		},
		async updateAccountSignature({
			account,
			signature,
		}) {
			return handleHttpAuthErrors(async () => {
				await updateSignature(account, signature)
				logger.debug('account signature updated', {
					account,
					signature,
				})
				const updated = { ...account, signature }
				this.editAccountMutation(updated)
				return account
			})
		},
		async setAccountSetting({
			accountId,
			key,
			value,
		}) {
			return handleHttpAuthErrors(async () => {
				this.setAccountSettingMutation({
					accountId,
					key,
					value,
				})
				return await savePreference('account-settings', JSON.stringify(this.allAccountSettings))
			})
		},
		async deleteAccount(account) {
			return handleHttpAuthErrors(async () => {
				try {
					await deleteAccount(account.id)
				} catch (error) {
					logger.error('could not delete account', { error })
					throw error
				}
			})
		},
		async deleteMailbox({ mailbox }) {
			return handleHttpAuthErrors(async () => {
				await deleteMailbox(mailbox.databaseId)
				this.removeMailboxMutation({ id: mailbox.databaseId })
			})
		},
		async clearMailbox({ mailbox }) {
			return handleHttpAuthErrors(async () => {
				await clearMailbox(mailbox.databaseId)
				this.removeEnvelopesMutation({ id: mailbox.databaseId })
				this.setMailboxUnreadCountMutation({ id: mailbox.databaseId })
			})
		},
		async createMailbox({
			account,
			name,
		}) {
			return handleHttpAuthErrors(async () => {
				const prefixed = (account.personalNamespace && !name.startsWith(account.personalNamespace))
					? account.personalNamespace + name
					: name
				const mailbox = await createMailbox(account.id, prefixed)
				logger.debug(`mailbox ${prefixed} created for account ${account.id}`, { mailbox })
				this.addMailboxMutation({
					account,
					mailbox,
				})
				this.expandAccountMutation(account.id)
				this.setAccountSettingMutation({
					accountId: account.id,
					key: 'collapsed',
					value: false,
				})
				return mailbox
			})
		},
		async moveAccount({
			account,
			up,
		}) {
			return handleHttpAuthErrors(async () => {
				const accounts = this.getAccounts
				const index = accounts.indexOf(account)
				if (up) {
					const previous = accounts[index - 1]
					accounts[index - 1] = account
					accounts[index] = previous
				} else {
					const next = accounts[index + 1]
					accounts[index + 1] = account
					accounts[index] = next
				}
				return await Promise.all(accounts.map((account, idx) => {
					if (account.id === 0) {
						return Promise.resolve()
					}
					this.saveAccountsOrderMutation({
						account,
						order: idx,
					})
					return patchAccount(account, { order: idx })
				}))
			})
		},
		async markMailboxRead({
			accountId,
			mailboxId,
		}) {
			return handleHttpAuthErrors(async () => {
				const mailbox = this.getMailbox(mailboxId)

				if (mailbox.isUnified) {
					const findIndividual = findIndividualMailboxes(this.getMailboxes, mailbox.specialRole)
					const individualMailboxes = findIndividual(this.getAccounts)
					return Promise.all(individualMailboxes.map((mb) => this.markMailboxReadMutation({
						accountId: mb.accountId,
						mailboxId: mb.databaseId,
					})))
				}

				const updated = { ...mailbox }
				updated.unread = 0

				await markMailboxRead(mailboxId)
				this.updateMailboxMutation({
					mailbox: updated,
				})

				await this.syncEnvelopes({
					accountId,
					mailboxId,
				})
			})
		},
		async changeMailboxSubscription({
			mailbox,
			subscribed,
		}) {
			return handleHttpAuthErrors(async () => {
				logger.debug(`toggle subscription for mailbox ${mailbox.databaseId}`, {
					mailbox,
					subscribed,
				})
				const updated = await patchMailbox(mailbox.databaseId, { subscribed })

				this.updateMailboxMutation({
					mailbox: updated,
				})
				logger.debug(`subscription for mailbox ${mailbox.databaseId} updated`, {
					mailbox,
					updated,
				})
			})
		},
		async patchMailbox({
			mailbox,
			attributes,
		}) {
			return handleHttpAuthErrors(async () => {
				logger.debug('patching mailbox', {
					mailbox,
					attributes,
				})

				const updated = await patchMailbox(mailbox.databaseId, attributes)

				this.updateMailboxMutation({
					mailbox: updated,
				})
				logger.debug(`mailbox ${mailbox.databaseId} patched`, {
					mailbox,
					updated,
				})
			})
		},
		async startComposerSession({
			type = 'imap',
			data = {},
			reply,
			forwardedMessages = [],
			templateMessageId,
			isBlankMessage = false,
		}) {
			// Silently close old session if already saved and show a discard modal otherwise
			if (this.composerSessionId && !this.composerMessageIsSaved) {
				// TODO: Nice to have: Add button to save current pending message
				const discard = await new Promise((resolve) => OC.dialogs.confirmDestructive(
					t('mail', 'There is already a message in progress. All unsaved changes will be lost if you continue!'),
					t('mail', 'Discard changes'),
					{
						type: OC.dialogs.YES_NO_BUTTONS,
						confirm: t('mail', 'Discard unsaved changes'),
						confirmClasses: 'error',
						cancel: t('mail', 'Keep editing message'),
					},
					(decision) => {
						resolve(decision)
					},
				))
				if (!discard) {
					this.showMessageComposer()
					return
				}
			}

			return handleHttpAuthErrors(async () => {
				if (reply) {
					const original = await this.fetchMessage(reply.data.databaseId)
					if (reply?.smartReply) {
						const aiDisclaimerText = t('mail', '(All or part of this reply was generated by AI)')

						if (original.hasHtmlBody) {
							reply.smartReply = `${reply.smartReply}
								<p></p>
					<em>${aiDisclaimerText}</em>`
						} else {
							reply.smartReply = `${reply.smartReply}\n\n<p></p> ${aiDisclaimerText}`
						}
					}
					// Fetch and transform the body into a rich text object
					if (original.hasHtmlBody) {
						data.isHtml = true
						data.bodyHtml = await this.processHtmlBody(original.databaseId)
						if (reply.suggestedReply) {
							data.bodyHtml = `<p>${reply.suggestedReply}</p>` + data.bodyHtml
						}
					} else {
						data.isHtml = false
						data.bodyPlain = original.body
						if (reply.suggestedReply) {
							data.bodyPlain = `${reply.suggestedReply}\n` + data.bodyPlain
						}
					}

					if (reply.mode === 'reply') {
						logger.debug('Show simple reply composer', { reply })
						const account = this.getAccount(reply.data.accountId)
						// For mailing list emails, "Reply to sender" must use From because
						// Reply-To points to the list address, not the original sender.
						// For regular emails, honor Reply-To if the sender set one.
						const isMailingList = !!(original.unsubscribeUrl || original.unsubscribeMailto)
						let to = (!isMailingList && original.replyTo !== undefined)
							? original.replyTo
							: reply.data.from
						// Replying to a message we sent ourselves: follow up with the
						// original recipient(s) instead of addressing ourselves.
						const isOwnMessage = to.length > 0
							&& to.every((addr) => addr.email === account.emailAddress)
						if (reply.followUp || isOwnMessage) {
							to = reply.data.to
						}
						this.startComposerSessionMutation({
							data: {
								accountId: reply.data.accountId,
								to,
								cc: [],
								subject: buildReplySubject(reply.data.subject),
								isHtml: data.isHtml,
								bodyHtml: data.bodyHtml,
								bodyPlain: data.bodyPlain,
								replyTo: reply.data,
								smartReply: reply.smartReply,
								attachments: this.prepareAttachments(original),
							},
						})
						return
					} else if (reply.mode === 'replyAll') {
						logger.debug('Show reply all reply composer', { reply })
						const account = this.getAccount(reply.data.accountId)
						const recipients = buildReplyRecipients(reply.data, {
							email: account.emailAddress,
							label: account.name,
						}, original.replyTo)
						this.startComposerSessionMutation({
							data: {
								accountId: reply.data.accountId,
								to: recipients.to,
								cc: recipients.cc,
								subject: buildReplySubject(reply.data.subject),
								isHtml: data.isHtml,
								bodyHtml: data.bodyHtml,
								bodyPlain: data.bodyPlain,
								replyTo: reply.data,
								smartReply: reply.smartReply,
								attachments: this.prepareAttachments(original),
							},
						})
						return
					} else if (reply.mode === 'forward') {
						logger.debug('Show forward composer', { reply })
						this.startComposerSessionMutation({
							data: {
								accountId: reply.data.accountId,
								to: [],
								cc: [],
								subject: buildForwardSubject(reply.data.subject),
								isHtml: data.isHtml,
								bodyHtml: data.bodyHtml,
								bodyPlain: data.bodyPlain,
								forwardFrom: reply.data,
								attachments: this.prepareAttachments(original, true),
							},
						})
						return
					}
				} else if (templateMessageId) {
					const message = await this.fetchMessage(templateMessageId)
					// Merge the original into any existing data
					data = {
						...data,
						message,
					}

					// Fetch and transform the body into a rich text object
					if (message.hasHtmlBody) {
						data.isHtml = true
						data.bodyHtml = await this.processHtmlBody(templateMessageId)
					} else {
						data.isHtml = false
						data.bodyPlain = message.body
					}

					// TODO: implement attachments
					if (message.attachments.length) {
						showWarning(t('mail', 'Attachments were not copied. Please add them manually.'))
					}
				}

				// Stop schedule when editing outbox messages and backup sendAt timestamp
				let originalSendAt
				if (type === 'outbox' && data.id && data.sendAt) {
					originalSendAt = data.sendAt
					const outboxStore = useOutboxStore()
					await outboxStore.stopMessage({ message: { ...data } })
				}

				this.startComposerSessionMutation({
					type,
					data,
					forwardedMessages,
					templateMessageId,
					originalSendAt,
				})

				// Blank messages can be safely discarded (without saving a draft) until changes are made
				if (isBlankMessage) {
					this.setComposerMessageSavedMutation(true)
				}
			})
		},
		prepareAttachments(original, forward = false) {
			const attachments = []

			if (forward && original.attachments) {
				for (const attachment of original.attachments) {
					attachments.push({
						...attachment,
						mailboxId: original.mailboxId,
						// messageId for attachments is actually the uid
						uid: attachment.messageId,
						type: 'message-attachment',
					})
				}
			}

			if (original.inlineAttachments) {
				for (const inlineAttachment of original.inlineAttachments) {
					attachments.push({
						...inlineAttachment,
						mailboxId: original.mailboxId,
						// messageId for attachments is actually the uid
						uid: inlineAttachment.messageId,
						type: 'message-attachment-inline',
					})
				}
			}

			return attachments
		},
		async stopComposerSession({
			restoreOriginalSendAt = false,
			moveToImap = false,
			id,
		} = {}) {
			return handleHttpAuthErrors(async () => {
				// Restore original sendAt timestamp when requested
				const message = this.composerMessage
				const messageData = { ...this.composerMessage.data }
				if (restoreOriginalSendAt && message.type === 'outbox' && message.options?.originalSendAt) {
					messageData.sendAt = message.options.originalSendAt
					updateDraft(messageData)
				}
				if (moveToImap) {
					await moveDraft(id)
				}

				this.stopComposerSessionMutation()
			})
		},
		patchComposerData(data) {
			this.patchComposerDataMutation(data)
			this.setComposerMessageSavedMutation(false)
		},
		async fetchEnvelope({
			accountId,
			id,
		}) {
			return handleHttpAuthErrors(async () => {
				const cached = this.getEnvelope(id)
				if (cached) {
					logger.debug(`using cached value for envelope ${id}`)
					return cached
				}

				const envelope = await fetchEnvelope(accountId, id)
				// Only commit if not undefined (not found)
				if (envelope) {
					this.addEnvelopesMutation({
						envelopes: [envelope],
					})
				}

				// Always use the object from the store
				return this.getEnvelope(id)
			})
		},
		setCurrentViewMailboxIdMutation(mailboxId) {
			this.currentViewMailboxId = mailboxId
		},
		envelopeFetchStartedMutation({ mailboxId, query }) {
			const key = mailboxId + '::' + normalizedEnvelopeListId(query)
			Vue.set(this.envelopeFetchCounts, key, (this.envelopeFetchCounts[key] ?? 0) + 1)
		},
		envelopeFetchFinishedMutation({ mailboxId, query }) {
			const key = mailboxId + '::' + normalizedEnvelopeListId(query)
			const count = (this.envelopeFetchCounts[key] ?? 1) - 1
			if (count <= 0) {
				Vue.delete(this.envelopeFetchCounts, key)
			} else {
				Vue.set(this.envelopeFetchCounts, key, count)
			}
		},
		isFetchingEnvelopes(mailboxId, query) {
			return (this.envelopeFetchCounts[mailboxId + '::' + normalizedEnvelopeListId(query)] ?? 0) > 0
		},
		fetchEnvelopes({
			mailboxId,
			query,
			addToUnifiedMailboxes = true,
			includeCacheBuster = false,
			signal,
		}) {
			this.envelopeFetchStartedMutation({ mailboxId, query })
			return handleHttpAuthErrors(async () => {
				const mailbox = this.getMailbox(mailboxId)

				if (mailbox.isUnified) {
					// One account's fetch rejecting must not discard every
					// other account's already-successful envelopes. Promise.all()
					// rejects as soon as any single promise rejects, so a single
					// slow/unreachable account used to make the whole unified
					// mailbox render nothing at all instead of everything except
					// that one account. See #9072.
					//
					// Bounded concurrency, same reasoning as
					// syncWatchedMailboxes(): unbounded fan-out across all
					// constituent mailboxes can occupy every FPM worker at
					// once. Worst measured case was a priority-inbox search
					// (5 mailboxes x 3 sections, twice while typing = 30
					// concurrent slow queries) where every request 504ed.
					const fetchIndividualLists = (mbs) => mapWithConcurrencyLimit(
						mbs,
						ENVELOPE_FETCH_CONCURRENCY,
						(mb) => this.fetchEnvelopes({
							mailboxId: mb.databaseId,
							query,
							addToUnifiedMailboxes: false,
							sort: this.getPreference('sort-order'),
							view: this.getPreference('layout-message-view'),
							signal,
						}).catch((error) => {
							if (axios.isCancel(error)) {
								// The whole unified fetch was superseded --
								// don't degrade the abort into an "empty
								// account" result.
								throw error
							}
							logger.error(`Failed to fetch envelopes for unified constituent mailbox ${mb.databaseId}: ${error}`, { error })
							return []
						}),
					).then(map(sliceToPage))
					const fetchUnifiedEnvelopes = pipe(
						findIndividualMailboxes(this.getMailboxes, mailbox.specialRole),
						fetchIndividualLists,
						andThen(combineEnvelopeLists(this.getPreference('sort-order'))),
						andThen(sliceToPage),
						andThen(tap((envelopes) => {
							this.addEnvelopesMutation({
								envelopes,
								query,
							})
							// Same tick as the list write above, not the
							// outer .finally() below (an extra microtask
							// hop later) -- see the note by that .finally()
							// for why the gap matters.
							this.envelopeFetchFinishedMutation({ mailboxId, query })
						})),
					)

					return fetchUnifiedEnvelopes(this.getAccounts)
				} else if (mailbox.isPriorityInbox) {
					// Same reasoning as syncEnvelopes()'s isPriorityInbox
					// branch (see there): "priority" is a virtual id with no
					// real mailbox behind it. Without this branch, every
					// call reached the generic path below and sent
					// mailboxId=priority straight to the server -- 403,
					// every time, since this branch didn't exist at all
					// (unlike syncEnvelopes(), which at least had a partial,
					// too-narrow version of it).
					const queriesToFanOut = query === undefined ? getPrioritySearchQueries() : [query]
					return Promise.all(queriesToFanOut.map((query) => {
						// Bounded like the isUnified branch above; the
						// concurrent sections multiply the per-section limit,
						// so this is what keeps a priority search's total
						// in-flight requests below the FPM pool size.
						const fetchIndividualLists = (mbs) => mapWithConcurrencyLimit(
							mbs,
							ENVELOPE_FETCH_CONCURRENCY,
							(mb) => this.fetchEnvelopes({
								mailboxId: mb.databaseId,
								query,
								addToUnifiedMailboxes: false,
								signal,
							}).catch((error) => {
								if (axios.isCancel(error)) {
									// Superseded search -- propagate, see
									// the isUnified branch above.
									throw error
								}
								logger.error(`Failed to fetch envelopes for priority-inbox constituent mailbox ${mb.databaseId}: ${error}`, { error })
								return []
							}),
						).then(map(sliceToPage))
						const fetchPriorityEnvelopes = pipe(
							findIndividualMailboxes(this.getMailboxes, mailbox.specialRole),
							fetchIndividualLists,
							andThen(combineEnvelopeLists(this.getPreference('sort-order'))),
							andThen(sliceToPage),
							andThen(tap((envelopes) => this.addEnvelopesMutation({
								envelopes,
								query,
							}))),
						)
						return fetchPriorityEnvelopes(this.getAccounts)
					}))
				}

				return pipe(
					fetchEnvelopes,
					andThen(tap((envelopes) => {
						this.addEnvelopesMutation({
							query,
							envelopes,
							addToUnifiedMailboxes,
							replace: true,
							replaceMailboxId: mailboxId,
						})
						// Same tick as the list write above -- see the note
						// on the outer .finally() below for why.
						this.envelopeFetchFinishedMutation({ mailboxId, query })
					})),
				)(mailbox.accountId, mailboxId, query, undefined, PAGE_SIZE, this.getPreference('sort-order'), this.getPreference('layout-message-view'), includeCacheBuster ? mailbox.cacheBuster : undefined, signal)
			}).finally(() => {
				// Safety net for paths that reject before reaching their
				// own tap() above (including the isUnified/isPriorityInbox
				// branches, which don't call it eagerly at all): idempotent
				// against an already-cleared marker, since
				// envelopeFetchFinishedMutation() treats a missing key as
				// count 0 and no-ops. NOT relied on for the success path
				// below -- that extra microtask hop (this .finally()'s
				// callback runs one tick after the tap() above already
				// ran) used to let hasFavoriteEnvelopes/hasOtherEnvelopes
				// see "list is empty, 0 results" for one render while
				// isFetchingEnvelopes() was still stuck true from the
				// PREVIOUS request's marker, or vice versa the marker
				// clear could land before a sibling section's own list
				// write -- either way, a section could flash its own
				// "No messages" empty state for one frame before the
				// v-show gating it caught up and hid it (confirmed live:
				// a favorites section during a no-match search).
				this.envelopeFetchFinishedMutation({ mailboxId, query })
			})
		},
		async fetchNextEnvelopePage({
			mailboxId,
			query,
		}) {
			return handleHttpAuthErrors(async () => {
				const envelopes = await this.fetchNextEnvelopes({
					mailboxId,
					query,
					quantity: PAGE_SIZE,
				})
				return envelopes
			})
		},
		async fetchNextEnvelopes({
			mailboxId,
			query,
			quantity,
			rec = true,
			addToUnifiedMailboxes = true,
		}) {
			return handleHttpAuthErrors(async () => {
				const mailbox = this.getMailbox(mailboxId)

				if (mailbox.isUnified || mailbox.isPriorityInbox) {
					// "priority" and "unified" are virtual ids with no real
					// mailbox behind them and must never reach the actual
					// fetch endpoint -- same reasoning as fetchEnvelopes()/
					// syncEnvelopes()'s isPriorityInbox branches elsewhere in
					// this file. This "Load more" pagination path was missing
					// the equivalent branch entirely until now: falling
					// through to the generic path below sent
					// mailboxId=priority straight to the server on every
					// "Load more" tap inside a priority-inbox section,
					// 403ing every time and silently never loading more
					// messages (the tap just did nothing, repeatably).
					const fetchNextFannedOutPage = async (query, allowRecursiveFetch = rec) => {
						const getIndivisualLists = curry((query, m) => this.getEnvelopes(m.databaseId, query))
						const individualCursor = curry((query, m) => prop('dateInt', last(this.getEnvelopes(m.databaseId, query))))
						const cursor = individualCursor(query, mailbox)

						if (cursor === undefined) {
							// An empty list has no tail to page past --
							// nothing more to load, by definition. The
							// infinite-scroll observer fires even over an
							// empty list (e.g. a priority-inbox search with
							// no matches), and throwing here turned every
							// such scroll into a console error instead of a
							// clean "end reached".
							logger.debug('no tail to page past, list is empty', { mailboxId, query })
							return []
						}
						const newestFirst = this.getPreference('sort-order') === 'newest'
						const nextLocalEnvelopes = pipe(
							findIndividualMailboxes(this.getMailboxes, mailbox.specialRole),
							map(getIndivisualLists(query)),
							combineEnvelopeLists(this.getPreference('sort-order')),
							filter(where({
								dateInt: newestFirst ? gt(cursor) : lt(cursor),
							})),
							slice(0, quantity),
						)
						// We know the next envelopes based on local data
						// We have to fetch individual envelopes only if it ends in the known
						// next fetch. If it ends after, we have all the relevant data already.
						const needsFetch = curry((query, nextEnvelopes, mb) => {
							const c = individualCursor(query, mb)
							if (nextEnvelopes.length < quantity) {
								return true
							}

							if (this.getPreference('sort-order') === 'newest') {
								return c >= last(nextEnvelopes).dateInt
							} else {
								return c <= last(nextEnvelopes).dateInt
							}
						})

						const mailboxesToFetch = (accounts) => pipe(
							findIndividualMailboxes(this.getMailboxes, mailbox.specialRole),
							tap((mbs) => logger.info('individual mailboxes', { mbs })),
							filter(needsFetch(query, nextLocalEnvelopes(accounts))),
						)(accounts)
						const mbs = mailboxesToFetch(this.getAccounts)

						if (allowRecursiveFetch && mbs.length) {
							logger.debug('not enough local envelopes for the next fanned-out page. ' + mbs.length + ' fetches required', {
								mailboxes: mbs.map((mb) => mb.databaseId),
							})
							// Same reasoning as fetchEnvelopes() above: one account
							// failing must not fail pagination for every other
							// account sharing this unified/priority mailbox.
							return pipe(
								map((mb) => this.fetchNextEnvelopes({
									mailboxId: mb.databaseId,
									query,
									quantity,
									addToUnifiedMailboxes: false,
								}).catch((error) => {
									logger.error(`Failed to fetch next envelopes for fanned-out constituent mailbox ${mb.databaseId}: ${error}`, { error })
									return []
								})),
								Promise.all.bind(Promise),
								andThen(() => fetchNextFannedOutPage(query, false)),
							)(mbs)
						}

						const envelopes = nextLocalEnvelopes(this.getAccounts)
						logger.debug('next fanned-out page can be built locally and consists of ' + envelopes.length + ' envelopes', { addToUnifiedMailboxes })
						this.addEnvelopesMutation({
							query,
							envelopes,
							addToUnifiedMailboxes,
						})
						return envelopes
					}

					if (mailbox.isPriorityInbox && query === undefined) {
						const results = await Promise.all(getPrioritySearchQueries().map((query) => fetchNextFannedOutPage(query)))
						return flatten(results)
					}
					return fetchNextFannedOutPage(query)
				}

				const list = mailbox.envelopeLists[normalizedEnvelopeListId(query)]
				if (list === undefined) {
					logger.warn("envelope list is not defined, can't fetch next envelopes", { mailboxId, query })
					return Promise.resolve([])
				}
				const lastEnvelopeId = last(list)
				if (typeof lastEnvelopeId === 'undefined') {
					logger.error('mailbox is empty', { list })
					return Promise.reject(new Error('Local mailbox has no envelopes, cannot determine cursor'))
				}
				const lastEnvelope = this.getEnvelope(lastEnvelopeId)
				if (typeof lastEnvelope === 'undefined') {
					return Promise.reject(new Error('Cannot find last envelope. Required for the mailbox cursor'))
				}

				return fetchEnvelopes(
					mailbox.accountId,
					mailboxId,
					query,
					lastEnvelope.dateInt,
					quantity,
					this.getPreference('sort-order'),
					this.getPreference('layout-message-view'),
				).then((envelopes) => {
					logger.debug(`fetched ${envelopes.length} messages for mailbox ${mailboxId}`, {
						envelopes,
						addToUnifiedMailboxes,
					})
					this.addEnvelopesMutation({
						query,
						envelopes,
						addToUnifiedMailboxes,
					})
					return envelopes
				})
			})
		},
		async syncEnvelopes({
			mailboxId,
			query,
			init = false,
			// Internal only, never passed by external callers -- true only
			// for the recursive retry chain that "won" the right to
			// actually probe this mailbox's lock (see pendingLockWaits
			// above). Lets that chain keep retrying via this same function
			// without re-registering itself as a new, separate leader.
			isLockRetryLeader = false,
			// Internal only: how many times the leader chain has already
			// retried, used to grow the backoff delay (see
			// computeLockRetryDelayMs above).
			lockRetryAttempt = 0,
			// Internal only: whether a malformed sync response (see
			// MalformedSyncResponseError below) has already been
			// retried once for this call. Capped at one retry -- if
			// the server is genuinely, persistently returning a
			// malformed body (not just a transient glitch under
			// load), retrying forever would just add to the load that
			// may have caused it in the first place.
			malformedResponseRetried = false,
		}) {
			return handleHttpAuthErrors(async () => {
				logger.debug(`starting mailbox sync of ${mailboxId} (${query})`)

				const mailbox = this.getMailbox(mailboxId)

				// Skip superfluous requests if using passwordless authentication. They will fail anyway.
				const passwordIsUnavailable = this.getPreference('password-is-unavailable', false)
				const isDisabled = (account) => passwordIsUnavailable && !!account.provisioningId

				if (mailbox.isUnified) {
					return Promise.all(this.getAccounts
						.filter((account) => !account.isUnified && !isDisabled(account))
						.map((account) => Promise.all(this
							.getMailboxes(account.id)
							.filter((mb) => mb.specialRole === mailbox.specialRole)
							.map((mailbox) => this.syncEnvelopes({
								mailboxId: mailbox.databaseId,
								query,
								init,
							})))))
				} else if (mailbox.isPriorityInbox) {
					// "priority" is a virtual id with no real mailbox behind
					// it and must never reach the actual sync endpoint. With
					// no explicit filter, fan out across both priority
					// buckets (is:pi-important, is:pi-other); a caller with
					// its own filter (e.g. "not:starred" from the
					// favorites-split view) keeps exactly that filter
					// instead. The old `&& query === undefined` guard let a
					// defined query fall through to the generic path below,
					// which sends mailboxId=priority straight to the server
					// -- confirmed live: a steady stream of 403s on
					// mailboxes?mailboxId=priority&filter=not:starred, every
					// time the priority inbox's own refresh cycle ran with a
					// favorites-split filter active.
					const queriesToFanOut = query === undefined ? getPrioritySearchQueries() : [query]
					return Promise.all(queriesToFanOut.map((query) => {
						return Promise.all(this.getAccounts
							.filter((account) => !account.isUnified && !isDisabled(account))
							.map((account) => Promise.all(this
								.getMailboxes(account.id)
								.filter((mb) => mb.specialRole === mailbox.specialRole)
								.map((mailbox) => this.syncEnvelopes({
									mailboxId: mailbox.databaseId,
									query,
									init,
								})))))
					}))
				}

				// Checking pendingLockWaits only inside the catch handler
				// below closes the loop for a NEW cycle arriving while an
				// existing leader is already mid-retry -- but it can't stop
				// two calls that are BOTH making their very first attempt
				// at nearly the same moment (e.g. two Vue components, the
				// main list and the favorites section, both reacting to
				// the same "refresh" event) from both hitting the network
				// before either has had a chance to register as leader.
				// Checking here too, before the request is even made,
				// closes that gap: if a leader is already known to be
				// retrying this mailbox, don't bother making a doomed
				// request at all -- go straight to waiting on it.
				if (!init && !isLockRetryLeader && pendingLockWaits.has(mailboxId)) {
					logger.info(`Mailbox ${mailboxId} already has a caller retrying it -- awaiting that instead of making another doomed request`, { query })
					return pendingLockWaits.get(mailboxId).catch(() => {}).then(() => this.syncEnvelopes({
						mailboxId,
						query,
						init,
					}))
				}

				const ids = this.getEnvelopes(mailboxId, query).map((env) => env.databaseId)
				const lastTimestamp = this.getPreference('sort-order') === 'newest' ? null : this.getEnvelopes(mailboxId, query)[0]?.dateInt
				logger.debug(`mailbox sync of ${mailboxId} (${query}) has ${ids.length} known IDs. ${lastTimestamp} is the last known message timestamp`, { mailbox })
				return syncEnvelopesExternal(mailbox.accountId, mailboxId, ids, lastTimestamp, query, init, this.getPreference('sort-order'))
					.then((syncData) => {
						logger.debug(`mailbox ${mailboxId} (${query}) synchronized, ${syncData.newMessages.length} new, ${syncData.changedMessages.length} changed and ${syncData.vanishedMessages.length} vanished messages`)

						// Every sync response (gated or real) carries the
						// server's current view of its own load -- keep the
						// store's flag as fresh as the most recent response
						// from ANY caller, not just the watched-mailbox
						// poller, since the signal itself (mail-pool load)
						// is global, not tied to one specific caller.
						this.setServerBusyMutation(syncData.serverBusy === true)

						const unifiedMailbox = this.getUnifiedMailbox(mailbox.specialRole)

						this.addEnvelopesMutation({
							envelopes: syncData.newMessages,
							query,
						})

						syncData.newMessages.forEach((envelope) => {
							if (unifiedMailbox) {
								this.updateEnvelopeMutation({
									envelope,
								})
							}
						})
						syncData.changedMessages.forEach((envelope) => {
							this.updateEnvelopeMutation({
								envelope,
							})
						})
						syncData.vanishedMessages.forEach((id) => {
							this.removeEnvelopeMutation({
								id,
								query,
							})
						})

						this.setMailboxUnreadCountMutation({
							id: mailboxId,
							unread: syncData.stats.unread,
						})

						return syncData.newMessages
					})
					.catch((error) => {
						return matchError(error, {
							[SyncIncompleteError.getName()]: () => {
								logger.warn(`(initial) sync of mailbox ${mailboxId} (${query}) is incomplete, retriggering`)
								return this.syncEnvelopes({
									mailboxId,
									query,
									init,
								})
							},
							[MalformedSyncResponseError.getName()]: (error) => {
								if (malformedResponseRetried) {
									logger.error(`Sync response for mailbox ${mailboxId} (${query}) was malformed again after a retry, giving up`, { error })
									throw error
								}
								logger.warn(`Sync response for mailbox ${mailboxId} (${query}) was malformed, retrying once`, { error })
								return this.syncEnvelopes({
									mailboxId,
									query,
									init,
									malformedResponseRetried: true,
								})
							},
							[MailboxLockedError.getName()]: (error) => {
								if (init) {
									logger.info('Sync failed because the mailbox is locked, stopping here because this is an initial sync', { error })
									throw error
								}

								if (isLockRetryLeader || !pendingLockWaits.has(mailboxId)) {
									const delay = computeLockRetryDelayMs(lockRetryAttempt, error.retryAfterMs)
									logger.info(`Sync failed because mailbox ${mailboxId} is locked, retrying in ${Math.round(delay)}ms (attempt ${lockRetryAttempt + 1})`, { error })
									const retry = wait(delay).then(() => this.syncEnvelopes({
										mailboxId,
										query,
										init,
										isLockRetryLeader: true,
										lockRetryAttempt: lockRetryAttempt + 1,
									}))
									if (!isLockRetryLeader) {
										const tracked = retry.finally(() => pendingLockWaits.delete(mailboxId))
										pendingLockWaits.set(mailboxId, tracked)
										return tracked
									}
									return retry
								}

								logger.info(`Sync failed because mailbox ${mailboxId} is locked; another caller is already retrying it -- awaiting that instead of starting an independent retry loop`, { error })
								return pendingLockWaits.get(mailboxId).catch(() => {}).then(() => this.syncEnvelopes({
									mailboxId,
									query,
									init,
								}))
							},
							default(error) {
								logger.error('Could not sync envelopes: ' + error.message, { error })
								throw error
							},
						})
					})
			})
		},
		/**
		 * @param {object} options
		 * @param {boolean} options.lightweight Sync only ONE representative
		 *                                      query bucket per watched
		 *                                      mailbox and skip the
		 *                                      priority-inbox refresh. Used
		 *                                      by hidden tabs (see
		 *                                      App.vue): enough for a full,
		 *                                      timely new-mail notification
		 *                                      (the sync response carries
		 *                                      sender/subject/preview), at a
		 *                                      fraction of a full tick's
		 *                                      request volume -- the rest of
		 *                                      the UI state is reconciled by
		 *                                      the immediate full tick that
		 *                                      fires when the tab becomes
		 *                                      visible again.
		 */
		async syncWatchedMailboxes({ lightweight = false } = {}) {
			// Skip superfluous requests if using passwordless authentication. They will fail anyway.
			const passwordIsUnavailable = this.getPreference('password-is-unavailable', false)
			const isDisabled = (account) => passwordIsUnavailable && !!account.provisioningId

			// A direct user action (opening a message, switching folders,
			// starring/deleting/flagging, ...) is in progress or just
			// happened -- give it the FPM pool and the main thread instead
			// of starting a fresh round of background syncs right now.
			// Anything skipped this tick gets a fresh attempt next tick,
			// same as every other "skip, don't queue" guard below.
			if (this.isInteractionPriorityActive()) {
				logger.debug('interaction priority active, skipping this watched-mailbox sync tick entirely')
				return
			}

			return handleHttpAuthErrors(async () => {
				const mailboxTargets = this.getAccounts
					.filter((a) => !a.isUnified && !isDisabled(a))
					.flatMap((account) => [...this.getRecursiveMailboxIterator(account.id)])

				// View-aware ordering (the active-query-first refetch
				// practice, cf. React Query refetching active queries
				// before inactive ones): the concurrency pool below pulls
				// mailboxes off this list in order, so with 3 workers and
				// a slow mailbox early in account order, the mailbox the
				// user is actually looking at could wait most of the tick
				// for a worker. Put the open mailbox first; when the
				// priority/unified inbox is open, its feeders (every
				// account's inbox) come first instead. Stable sort keeps
				// the original account order within each rank.
				const openMailboxId = this.currentViewMailboxId
				const openVirtualInbox = openMailboxId === PRIORITY_INBOX_ID || openMailboxId === UNIFIED_INBOX_ID
				const viewRank = (mailbox) => {
					if (String(mailbox.databaseId) === String(openMailboxId)) {
						return 0
					}
					if (openVirtualInbox && mailbox.specialRole === 'inbox') {
						return 1
					}
					return 2
				}
				mailboxTargets.sort((a, b) => viewRank(a) - viewRank(b))

				let priorityRefreshPromise
				const maybeStartPriorityInboxRefresh = () => {
					if (priorityRefreshPromise !== undefined) {
						return
					}

					// Interaction priority pauses background work -- but an
					// OPEN priority inbox is foreground: it's exactly what
					// the user is looking at, and it's the one view that
					// cannot update itself (its sections are
					// server-materialized lists). Skipping its refresh here
					// starved precisely the person watching it. Only
					// mid-tick activations reach this check; a tick that
					// starts during interaction priority never gets past
					// the guard at the top of syncWatchedMailboxes().
					const priorityInboxIsOpen = this.currentViewMailboxId === PRIORITY_INBOX_ID
					if (this.isInteractionPriorityActive() && !priorityInboxIsOpen) {
						logger.debug('interaction priority active, deferring the priority-inbox refresh')
						return
					}

					// Started the moment the FIRST watched mailbox reports
					// new messages instead of after every mailbox's sync
					// settles: the old all-mailboxes barrier let one slow
					// mailbox (7-81s Gmail syncs measured live) hold the
					// priority inbox stale long after the receiving
					// mailbox's badge had updated -- the same head-of-line
					// problem already fixed for the desktop notification
					// above. Errors are logged rather than rethrown: the
					// refresh is reconciliation on top of the local
					// classification insert in addEnvelopesMutation(), not
					// the primary delivery path anymore.
					priorityRefreshPromise = (async () => {
						logger.info('updating priority inbox')
						for (const query of [priorityImportantQuery, priorityOtherQuery]) {
							logger.info("sync'ing priority inbox section", { query })
							const mailbox = this.getMailbox(UNIFIED_INBOX_ID)
							const list = mailbox.envelopeLists[normalizedEnvelopeListId(query)]
							if (list === undefined) {
								await this.fetchEnvelopes({
									mailboxId: UNIFIED_INBOX_ID,
									query,
								})
							}

							await this.syncEnvelopes({
								mailboxId: UNIFIED_INBOX_ID,
								query,
							})
						}
					})().catch((error) => {
						logger.error('priority inbox refresh failed', { error })
					})
				}

				const syncOneWatchedMailbox = async (mailbox) => {
					if (mailbox.specialRole !== 'inbox' && !mailbox.syncInBackground) {
						return
					}

					// Checked again per mailbox, not just once at the top of
					// syncWatchedMailboxes(): the concurrency-limited pool
					// below only pulls a new mailbox off the queue once a
					// worker frees up, which can be seconds into an
					// already-running tick -- if interaction priority
					// activates mid-tick, this stops any NOT-YET-STARTED
					// mailbox from beginning, while ones already in flight
					// (already past this check) are left to finish rather
					// than aborted mid-request.
					if (this.isInteractionPriorityActive()) {
						logger.debug(`interaction priority active, skipping mailbox ${mailbox.databaseId} for this tick`)
						return
					}

					// A locked mailbox (e.g. a Gmail account's INBOX mid a
					// genuinely long full sync) already has its own
					// retry-on-lock chain running via pendingLockWaits,
					// backing off on its own up to LOCK_RETRY_MAX_MS
					// between attempts. Ticks fire every ~10s here, much
					// faster than that backoff -- without this check,
					// each new tick would queue up another "await the
					// current leader, then try again" continuation on
					// top of the last one (syncEnvelopes():1020-1027),
					// and they'd all fire in a burst the moment the
					// leader finally settles. Skipping instead means the
					// stuck mailbox's own chain is left alone to retry at
					// its own paced cadence, while every other watched
					// mailbox keeps getting a fresh attempt every tick,
					// completely unaffected by the stuck one.
					if (isMailboxSyncRetryPending(mailbox.databaseId)) {
						logger.debug(`mailbox ${mailbox.databaseId} already has a sync retry pending, skipping this tick`)
						return
					}

					if (watchedMailboxSyncsInFlight.has(mailbox.databaseId)) {
						logger.debug(`mailbox ${mailbox.databaseId} still has a watched-sync in flight from an earlier tick, skipping`)
						return
					}
					watchedMailboxSyncsInFlight.add(mailbox.databaseId)

					// Sync every query bucket already loaded for this mailbox
					// (e.g. '' for the plain view, 'not:starred' when the user
					// has "sort favorites separately" enabled), not just the
					// unfiltered default -- new messages synced under a query
					// nobody's envelopeLists key matches the currently
					// displayed one are added to the store but never rendered.
					// Falls back to the unfiltered default for a mailbox with
					// no envelopeLists yet (never opened this session).
					//
					// Sequential, not Promise.all: syncEnvelopes() has its own
					// internal retry-on-lock loop (every 1.5s) that keeps
					// awaiting until the mailbox unlocks. A sync lock is
					// mailbox-wide, not per-query -- firing every bucket's
					// sync concurrently means every bucket independently
					// re-triggers its own 1.5s retry chain against the same
					// lock, multiplying request volume by the bucket count
					// for as long as the mailbox stays locked (confirmed
					// live: a genuinely long lock on the slow Gmail account
					// produced a sustained ~1 request/second storm with two
					// buckets loaded). Going sequential means only one
					// bucket's sync (and its retry chain, if any) is ever
					// in flight for a given mailbox at a time; the rest
					// simply wait their turn, and once the lock clears they
					// resolve immediately since nothing else needed re-sent.
					const queries = Object.keys(mailbox.envelopeLists)
					let queriesToSync = queries.length > 0 ? queries : [undefined]

					// Wave 1b bucket coalescing: is:starred/not:starred and
					// is:pi-important/is:pi-other are pure predicates over a
					// flag every envelope already carries (flags.flagged /
					// flags.important) -- when the unfiltered '' bucket is
					// ALSO loaded for this mailbox, its own sync response
					// already reports every changed flag for every known
					// message (an unfiltered query has no flag restriction,
					// so nothing is excluded from "changed"), and
					// reclassifyFlagBucketsMutation (see addEnvelopesMutation/
					// updateEnvelopeMutation) keeps every OTHER loaded
					// flag-predicate bucket correct from that same response.
					// Syncing them separately -- up to 5 buckets, each its
					// own request -- was pure duplication of that same
					// question against the same server-side state. Only
					// collapses when '' is present: without it, there is no
					// single sync whose response is guaranteed to cover
					// every known id's current flags, so the old one-sync-
					// per-bucket behaviour is left untouched (no regression,
					// just no coalescing) for that less common case.
					const coalescedQueries = new Set(['is:starred', 'not:starred', priorityImportantQuery, priorityOtherQuery])
					if (queriesToSync.includes('')) {
						queriesToSync = queriesToSync.filter((query) => !coalescedQueries.has(query))
					}

					if (lightweight) {
						// One representative bucket is enough to pull new
						// messages into the store and fire the notification:
						// prefer the unfiltered bucket when it's loaded,
						// otherwise whichever bucket happens to be first.
						// The remaining buckets read the same store and are
						// reconciled by the full tick on tab activation.
						queriesToSync = queries.includes('') ? [''] : [queriesToSync[0]]
					}

					try {
						const newMessagesPerQuery = []
						for (const query of queriesToSync) {
							const list = mailbox.envelopeLists[normalizedEnvelopeListId(query)]
							if (list === undefined) {
								await this.fetchEnvelopes({
									mailboxId: mailbox.databaseId,
									query,
								})
							}

							newMessagesPerQuery.push(await this.syncEnvelopes({
								mailboxId: mailbox.databaseId,
								query,
							}))
						}

						// Notify HERE, per mailbox, the moment its own sync
						// resolved -- not after every mailbox's sync settles.
						// The desktop notification used to wait for every
						// other watched mailbox's sync (plus the priority
						// inbox refresh) to settle first, so one slow/locked
						// mailbox mid its own lock-retry chain held every
						// notification hostage for seconds to minutes after
						// the receiving mailbox's badge had already updated.
						//
						// Only explicitly unseen messages are news: a message
						// can reach this tab's sync already read (marked seen
						// in another window, on the phone, or via IMAP before
						// a delayed sync caught up). flags.seen === false, not
						// merely falsy -- same as initiallyExpandedEnvelopeId()
						// in Thread.vue. Deduped by databaseId since several
						// query buckets of the same mailbox can each report
						// the same new message.
						const notifiedIds = new Set()
						const unseenMessages = flatMapDeep(identity, newMessagesPerQuery)
							.filter((message) => {
								if (message === undefined || message.flags?.seen !== false || notifiedIds.has(message.databaseId)) {
									return false
								}
								notifiedIds.add(message.databaseId)
								return true
							})
						if (unseenMessages.length > 0) {
							showNewMessagesNotification(unseenMessages)
							this.notificationBurstFiredMutation()
						}

						if (!lightweight && flatMapDeep(identity, newMessagesPerQuery).some((m) => m !== undefined)) {
							maybeStartPriorityInboxRefresh()
						}

						return newMessagesPerQuery
					} finally {
						watchedMailboxSyncsInFlight.delete(mailbox.databaseId)
					}
				}

				const results = await mapWithConcurrencyLimit(mailboxTargets, WATCHED_SYNC_CONCURRENCY, syncOneWatchedMailbox)
				const newMessages = flatMapDeep(identity, results).filter((m) => m !== undefined)
				if (newMessages.length === 0) {
					return priorityRefreshPromise
				}

				if (lightweight) {
					// Nobody is looking at the priority inbox right now --
					// its sections are reconciled by the full tick that
					// fires on tab activation.
					logger.debug('lightweight tick, skipping the priority-inbox refresh')
					return
				}

				// Re-attempt in case every early attempt was vetoed by a
				// mid-tick interaction that has since expired.
				maybeStartPriorityInboxRefresh()
				return priorityRefreshPromise
			})
		},
		toggleEnvelopeFlagged(envelope) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				// Change immediately and switch back on error
				const oldState = envelope.flags.flagged
				this.flagEnvelopeMutation({
					envelope,
					flag: 'flagged',
					value: !oldState,
				})

				try {
					await setEnvelopeFlags(envelope.databaseId, {
						flagged: !oldState,
					})
				} catch (error) {
					logger.error('Could not toggle message flagged state', { error })

					// Revert change
					this.flagEnvelopeMutation({
						envelope,
						flag: 'flagged',
						value: oldState,
					})

					throw error
				}
			})
		},
		async toggleEnvelopeImportant(envelope) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				const importantLabel = '$label1'
				const hasTag = this
					.getEnvelopeTags(envelope.databaseId)
					.some((tag) => tag.imapLabel === importantLabel)
				if (hasTag) {
					await this.removeEnvelopeTag({
						envelope,
						imapLabel: importantLabel,
					})
				} else {
					await this.addEnvelopeTag({
						envelope,
						imapLabel: importantLabel,
					})
				}
			})
		},
		async toggleEnvelopeSeen({
			envelope,
			seen,
		}) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				// Change immediately and switch back on error
				const oldState = envelope.flags.seen
				const newState = seen === undefined ? !oldState : seen
				this.flagEnvelopeMutation({
					envelope,
					flag: 'seen',
					value: newState,
				})
				if (newState === false) {
					// Marking unread definitely means this thread has an
					// unseen message now (this one) -- no need to wait for
					// the server to know that much.
					this.flagEnvelopeMutation({
						envelope,
						flag: 'hasUnseenInThread',
						value: true,
					})
				}

				try {
					const response = await setEnvelopeFlags(envelope.databaseId, {
						seen: newState,
					})
					// Marking read: only the server knows whether some OTHER
					// message in this thread is still unseen, so correct the
					// optimistic value with the authoritative one once it's
					// back, instead of leaving it stale until the next full
					// listing fetch.
					if (response?.hasUnseenInThread !== undefined) {
						this.flagEnvelopeMutation({
							envelope,
							flag: 'hasUnseenInThread',
							value: response.hasUnseenInThread,
						})
					}
				} catch (error) {
					logger.error('could not toggle message seen state', { error })

					// Revert change
					this.flagEnvelopeMutation({
						envelope,
						flag: 'seen',
						value: oldState,
					})

					throw error
				}
			})
		},
		async toggleEnvelopeJunk({
			envelope,
			removeEnvelope,
		}) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				// Change immediately and switch back on error
				const oldState = envelope.flags.$junk
				// Confirmed live: marking a message as spam only ever set
				// this custom $junk/$notjunk IMAP flag -- it never actually
				// moved the message to the account's junk mailbox (nothing
				// in this whole call chain ever called moveMessage/the
				// move-message endpoint, despite comments at every calling
				// component claiming "our backend implements move as
				// copy+delete" and describing a delete-event chain that,
				// traced end to end, only does list-navigation bookkeeping
				// -- Mailbox.onDelete() fetches one replacement envelope
				// and navigates the route, nothing else). The optimistic
				// UI removal made it LOOK like it worked; a refresh
				// re-fetched the message from its real, unchanged mailbox
				// and it reappeared. destMailboxId is the actual fix.
				const destMailboxId = this.junkMoveDestinationMailboxId(envelope)

				this.flagEnvelopeMutation({
					envelope,
					flag: '$junk',
					value: !oldState,
				})
				this.flagEnvelopeMutation({
					envelope,
					flag: '$notjunk',
					value: oldState,
				})

				if (removeEnvelope) {
					this.removeEnvelopeMutation({ id: envelope.databaseId })
				}

				try {
					await setEnvelopeFlags(envelope.databaseId, {
						$junk: !oldState,
						$notjunk: oldState,
					})

					if (destMailboxId !== null) {
						await moveMessage(envelope.databaseId, destMailboxId)
						this.removeMessageMutation({ id: envelope.databaseId })
					}
				} catch (error) {
					logger.error('could not toggle message junk state', { error })

					if (removeEnvelope) {
						this.addEnvelopesMutation({ envelopes: [envelope] })
					}

					// Revert change
					this.flagEnvelopeMutation({
						envelope,
						flag: '$junk',
						value: oldState,
					})
					this.flagEnvelopeMutation({
						envelope,
						flag: '$notjunk',
						value: !oldState,
					})

					throw error
				}
			})
		},
		async markEnvelopeFavoriteOrUnfavorite({
			envelope,
			favFlag,
		}) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				// Change immediately and switch back on error
				const oldState = envelope.flags.flagged
				this.flagEnvelopeMutation({
					envelope,
					flag: 'flagged',
					value: favFlag,
				})

				try {
					await setEnvelopeFlags(envelope.databaseId, {
						flagged: favFlag,
					})
				} catch (error) {
					logger.error('could not favorite/unfavorite message ' + envelope.uid, { error })

					// Revert change
					this.flagEnvelopeMutation({
						envelope,
						flag: 'flagged',
						value: oldState,
					})

					throw error
				}
			})
		},
		async markEnvelopeImportantOrUnimportant({
			envelope,
			addTag,
		}) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				const importantLabel = '$label1'
				const hasTag = this
					.getEnvelopeTags(envelope.databaseId)
					.some((tag) => tag.imapLabel === importantLabel)
				if (hasTag && !addTag) {
					await this.removeEnvelopeTag({
						envelope,
						imapLabel: importantLabel,
					})
				} else if (!hasTag && addTag) {
					await this.addEnvelopeTag({
						envelope,
						imapLabel: importantLabel,
					})
				}
			})
		},
		async fetchThread(id) {
			if (pendingThreadFetches.has(id)) {
				return pendingThreadFetches.get(id)
			}

			// Same reasoning as fetchMessage() below: this promise gates
			// Thread.vue's loading state and must always settle, and is
			// shared via the dedup map so a concurrent caller (hover
			// prefetch racing an actual open) reuses it instead of firing
			// a duplicate request.
			const promise = handleHttpAuthErrors(async () => {
				const thread = await fetchThread(id, { signal: AbortSignal.timeout(FETCH_MESSAGE_TIMEOUT_MS) })
				this.addEnvelopeThreadMutation({
					id,
					thread,
				})
				return thread
			}).finally(() => {
				pendingThreadFetches.delete(id)
			})
			pendingThreadFetches.set(id, promise)
			return promise
		},
		async fetchMessage(id) {
			if (this.messages[id]) {
				return this.messages[id]
			}

			if (pendingMessageFetches.has(id)) {
				return pendingMessageFetches.get(id)
			}

			// A promise held by UI (ThreadEnvelope's loading skeleton
			// clears only when this settles) and SHARED via the dedup map
			// must never be able to stay pending forever: a single hung
			// request -- e.g. a hover prefetch that stalled at the network
			// level, where no HTTP error ever arrives -- would otherwise
			// freeze every later open of the same message on the skeleton
			// for the tab's lifetime (observed live, thread 119827).
			// AbortSignal.timeout() is the standard cancellation primitive:
			// it actually cancels the underlying request, and the finally
			// below evicts the map entry so the next attempt starts fresh.
			// Generous bound: a legitimate cache-miss body fetch through a
			// slow provider measured up to ~25-60s; nginx's own upstream
			// timeout (120s on the body tier) makes anything beyond this a
			// dead connection, not a slow response.
			const signal = AbortSignal.timeout(FETCH_MESSAGE_TIMEOUT_MS)

			const promise = handleHttpAuthErrors(async () => {
				const message = await fetchMessage(id, { signal })
				// Only commit if not undefined (not found)
				if (message) {
					this.addMessageMutation({
						message,
					})
				}
				return message
			}).finally(() => {
				pendingMessageFetches.delete(id)
			})
			pendingMessageFetches.set(id, promise)
			return promise
		},
		async fetchItineraries(id) {
			return handleHttpAuthErrors(async () => {
				const itineraries = await fetchMessageItineraries(id)
				this.addMessageItinerariesMutation({
					id,
					itineraries,
				})
				return itineraries
			})
		},
		async fetchDkim(id) {
			return handleHttpAuthErrors(async () => {
				const result = await fetchMessageDkim(id)
				this.addMessageDkimMutation({
					id,
					result,
				})
				return result
			})
		},
		async addInternalAddress({
			address,
			type,
		}) {
			return handleHttpAuthErrors(async () => {
				const internalAddress = await addInternalAddress(address, type)
				this.addInternalAddressMutation(internalAddress)
				logger.debug('internal address added')
			})
		},
		async removeInternalAddress({
			id,
			address,
			type,
		}) {
			return handleHttpAuthErrors(async () => {
				try {
					await removeInternalAddress(address, type)
					this.removeInternalAddressMutation({ addressId: id })
					logger.debug('internal address removed')
				} catch (error) {
					logger.error('could not delete internal address', { error })
					throw error
				}
			})
		},
		async deleteMessage({ id }) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				this.removeEnvelopeMutation({ id })

				try {
					await deleteMessage(id)
					this.removeMessageMutation({ id })
					logger.debug('message removed')
				} catch (err) {
					logger.error('could not delete message', { error: err })
					const envelope = this.getEnvelope(id)
					if (envelope) {
						this.addEnvelopesMutation({ envelopes: [envelope] })
					} else {
						logger.error('could not find envelope', { id })
					}
					throw err
				}
			})
		},
		async createAlias({
			account,
			alias,
			name,
		}) {
			return handleHttpAuthErrors(async () => {
				const entity = await AliasService.createAlias(account.id, alias, name)
				this.createAliasMutation({
					account,
					alias: entity,
				})
			})
		},
		async deleteAlias({
			account,
			aliasId,
		}) {
			return handleHttpAuthErrors(async () => {
				const entity = await AliasService.deleteAlias(account.id, aliasId)
				this.deleteAliasMutation({
					account,
					aliasId: entity.id,
				})
			})
		},
		async updateAlias({
			account,
			aliasId,
			alias,
			name,
			smimeCertificateId,
		}) {
			return handleHttpAuthErrors(async () => {
				const entity = await AliasService.updateAlias(
					account.id,
					aliasId,
					alias,
					name,
					smimeCertificateId,
				)
				this.patchAliasMutation({
					account,
					aliasId: entity.id,
					data: {
						alias: entity.alias,
						name: entity.name,
						smimeCertificateId: entity.smimeCertificateId,
					},
				})
				this.editAccountMutation(account)
			})
		},
		async updateAliasSignature({
			account,
			aliasId,
			signature,
		}) {
			return handleHttpAuthErrors(async () => {
				const entity = await AliasService.updateSignature(account.id, aliasId, signature)
				this.patchAliasMutation({
					account,
					aliasId: entity.id,
					data: { signature: entity.signature },
				})
				this.editAccountMutation(account)
			})
		},
		async renameMailbox({
			account,
			mailbox,
			newName,
		}) {
			return handleHttpAuthErrors(async () => {
				const newMailbox = await patchMailbox(mailbox.databaseId, {
					name: newName,
				})

				logger.debug(`mailbox ${mailbox.databaseId} renamed to ${newName}`, { mailbox })
				this.removeMailboxMutation({ id: mailbox.databaseId })
				this.addMailboxMutation({
					account,
					mailbox: newMailbox,
				})
			})
		},
		async moveMessage({
			id,
			destMailboxId,
		}) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				await moveMessage(id, destMailboxId)
				this.removeEnvelopeMutation({ id })
				this.removeMessageMutation({ id })
			})
		},
		async snoozeMessage({
			id,
			unixTimestamp,
			destMailboxId,
		}) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				await snoozeMessage(id, unixTimestamp, destMailboxId)
				this.removeEnvelopeMutation({ id })
				this.removeMessageMutation({ id })
			})
		},
		async unSnoozeMessage({ id }) {
			return handleHttpAuthErrors(async () => {
				await unSnoozeMessage(id)
				this.removeEnvelopeMutation({ id })
				this.removeMessageMutation({ id })
			})
		},
		async fetchActiveSieveScript({ accountId }) {
			return handleHttpAuthErrors(async () => {
				const scriptData = await getActiveScript(accountId)
				this.setActiveSieveScriptMutation({
					accountId,
					scriptData,
				})
			})
		},
		async updateActiveSieveScript({
			accountId,
			scriptData,
		}) {
			return handleHttpAuthErrors(async () => {
				await updateActiveScript(accountId, scriptData)
				this.setActiveSieveScriptMutation({
					accountId,
					scriptData,
				})
			})
		},
		async updateSieveAccount({
			account,
			data,
		}) {
			return handleHttpAuthErrors(async () => {
				logger.debug(`update sieve settings for account ${account.id}`)
				try {
					await updateSieveAccount(account.id, data)
					this.patchAccountMutation({
						account,
						data,
					})
				} catch (error) {
					logger.error('failed to update sieve account: ', { error })
					throw error
				}
			})
		},
		async createTag({
			displayName,
			color,
		}) {
			return handleHttpAuthErrors(async () => {
				const tag = await createEnvelopeTag(displayName, color)
				this.addTagMutation({ tag })
			})
		},
		async addEnvelopeTag({
			envelope,
			imapLabel,
		}) {
			return handleHttpAuthErrors(async () => {
				// TODO: fetch tags indepently of envelopes and only send tag id here
				const tag = await setEnvelopeTag(envelope.databaseId, imapLabel)
				if (!this.getTag(tag.id)) {
					this.addTagMutation({ tag })
				}

				this.addEnvelopeTagMutation({
					envelope,
					tagId: tag.id,
				})
			})
		},
		async removeEnvelopeTag({
			envelope,
			imapLabel,
		}) {
			return handleHttpAuthErrors(async () => {
				const tag = await removeEnvelopeTag(envelope.databaseId, imapLabel)
				this.removeEnvelopeTagMutation({
					envelope,
					tagId: tag.id,
				})
			})
		},
		async updateTag({
			tag,
			displayName,
			color,
		}) {
			return handleHttpAuthErrors(async () => {
				await updateEnvelopeTag(tag.id, displayName, color)
				this.updateTagMutation({
					tag,
					displayName,
					color,
				})
				logger.debug('tag updated', {
					tag,
					displayName,
					color,
				})
			})
		},
		async deleteTag({
			tag,
			accountId,
		}) {
			return handleHttpAuthErrors(async () => {
				await deleteTag(tag.id, accountId)
				this.deleteTagMutation({ tagId: tag.id })
				logger.debug('tag deleted', { tag })
			})
		},
		async deleteThread({ envelope }) {
			return handleHttpAuthErrors(async () => {
				this.removeEnvelopeMutation({ id: envelope.databaseId })

				try {
					await ThreadService.deleteThread(envelope.databaseId)
					logger.debug('thread removed')
				} catch (e) {
					this.addEnvelopesMutation({ envelopes: [envelope] })
					logger.error('could not delete thread', { error: e })
					throw e
				}
			})
		},
		async moveThread({
			envelope,
			destMailboxId,
		}) {
			return handleHttpAuthErrors(async () => {
				this.removeEnvelopeMutation({ id: envelope.databaseId })

				try {
					await ThreadService.moveThread(envelope.databaseId, destMailboxId)
					logger.debug('thread moved')
				} catch (e) {
					this.addEnvelopesMutation({ envelopes: [envelope] })
					logger.error('could not move thread', { error: e })
					throw e
				}
			})
		},
		async snoozeThread({
			envelope,
			unixTimestamp,
			destMailboxId,
		}) {
			return handleHttpAuthErrors(async () => {
				try {
					await ThreadService.snoozeThread(envelope.databaseId, unixTimestamp, destMailboxId)
					logger.debug('thread snoozed')
				} catch (e) {
					this.addEnvelopesMutation({ envelopes: [envelope] })
					logger.error('could not snooze thread', { error: e })
					throw e
				}
				this.removeEnvelopeMutation({ id: envelope.databaseId })
			})
		},
		async unSnoozeThread({ envelope }) {
			return handleHttpAuthErrors(async () => {
				try {
					await ThreadService.unSnoozeThread(envelope.databaseId)
					logger.debug('thread unSnoozed')
				} catch (e) {
					logger.error('could not unsnooze thread', { error: e })
					throw e
				}
				this.removeEnvelopeMutation({ id: envelope.databaseId })
			})
		},

		/**
		 * Retrieve and commit the principal of the current user.
		 *
		 * @param {object} context Vuex store context
		 * @param {Function} context.commit Vuex store mutations
		 */
		async fetchCurrentUserPrincipal() {
			return handleHttpAuthErrors(async () => {
				await initializeClientForUserView()
				this.setCurrentUserPrincipalMutation({ currentUserPrincipal: getCurrentUserPrincipal() })
			})
		},

		/**
		 * Retrieve and commit calendars.
		 *
		 * @param {object} context Vuex store context
		 * @param {Function} context.commit Vuex store mutations
		 * @return {Promise<void>}
		 */
		async loadCollections() {
			await handleHttpAuthErrors(async () => {
				const { calendars } = await findAll()
				for (const calendar of calendars) {
					this.addCalendarMutation({ calendar })
				}
			})
		},

		/**
		 * Fetch and commit all S/MIME certificate of the current user.
		 *
		 * @param {object} context Vuex store context
		 * @param {Function} context.commit Vuex store mutations
		 * @return {Promise<void>}
		 */
		async fetchSmimeCertificates() {
			return handleHttpAuthErrors(async () => {
				const certificates = await SmimeCertificateService.fetchAll()
				this.setSmimeCertificatesMutation(certificates)
			})
		},

		/**
		 * Delete an imported S/MIME certificate.
		 *
		 * @param {object} context Vuex store context
		 * @param {Function} context.commit Vuex store mutations
		 * @param id The id of the certificate to be deleted
		 * @return {Promise<void>}
		 */
		async deleteSmimeCertificate(id) {
			return handleHttpAuthErrors(async () => {
				await SmimeCertificateService.deleteCertificate(id)
				this.deleteSmimeCertificateMutation({ id })
			})
		},

		/**
		 * Create a new S/MIME certificate and persist it on the backend.
		 *
		 * @param {object} context Vuex store context
		 * @param {Function} context.commit Vuex store mutations
		 * @param {object} files
		 * @param {Blob} files.certificate
		 * @param {Blob=} files.privateKey
		 * @return {Promise<object>}
		 */
		async createSmimeCertificate(files) {
			return handleHttpAuthErrors(async () => {
				const certificate = await SmimeCertificateService.createCertificate(files)
				this.addSmimeCertificateMutation({ certificate })
				return certificate
			})
		},

		/**
		 * Update the S/MIME certificate of an account.
		 *
		 * @param {object} context Vuex store context
		 * @param {Function} context.commit Vuex store mutations
		 * @param {Function} context.this Vuex store this
		 * @param {object} data
		 * @param {object} data.accountId
		 * @param {number=} data.smimeCertificateId
		 * @param data.account
		 * @param context.account
		 * @param context.smimeCertificateId
		 * @return {Promise<void>}
		 */
		async updateAccountSmimeCertificate({
			account,
			smimeCertificateId,
		}) {
			return handleHttpAuthErrors(async () => {
				await updateAccountSmimeCertificate(account.id, smimeCertificateId)
				this.patchAccountMutation({
					account,
					data: { smimeCertificateId },
				})
			})
		},

		/**
		 * Should the envelope moved to the junk (or back to inbox)
		 *
		 * @param {object} context Vuex store context
		 * @param {object} context.this Vuex store this
		 * @param {object} envelope envelope object@
		 * @return {boolean}
		 */
		// Shared by moveEnvelopeToJunk() (below, a "should the UI treat
		// this as leaving the current view" boolean used by several
		// components to decide whether to fire their own 'delete' event
		// for navigation bookkeeping) and toggleEnvelopeJunk() (which
		// actually performs the move) so both agree on the same
		// destination without computing it twice.
		//
		// Returns the real destination mailbox id, or null if there's
		// nowhere to move the message (no junk mailbox configured, no
		// inbox found, or it's already exactly where it should be).
		junkMoveDestinationMailboxId(envelope) {
			const account = this.getAccount(envelope.accountId)
			if (!account || account.junkMailboxId === null) {
				return null
			}

			if (!envelope.flags.$junk) {
				// marking as spam: move to the junk mailbox
				return envelope.mailboxId !== account.junkMailboxId ? account.junkMailboxId : null
			}

			// un-marking: move back to the inbox
			const inbox = this.getInbox(account.id)
			if (inbox === undefined) {
				return null
			}
			return envelope.mailboxId !== inbox.databaseId ? inbox.databaseId : null
		},
		async moveEnvelopeToJunk(envelope) {
			this.setInteractionPriorityMutation()
			return this.junkMoveDestinationMailboxId(envelope) !== null
		},
		async createAndSetSnoozeMailbox(account) {
			const name = 'Snoozed'
			let snoozeMailboxId

			try {
				const createMailboxResponse = await this.createMailbox({
					account,
					name,
				})
				snoozeMailboxId = createMailboxResponse.databaseId
				logger.info(`mailbox ${name} created as ${snoozeMailboxId}`)
			} catch (e) {
				logger.error('could not create mailbox', { e })
			}

			if (snoozeMailboxId === undefined) {
				snoozeMailboxId = this.findMailboxByName(account.id, name).databaseId
			}

			if (snoozeMailboxId === undefined) {
				logger.error('Could not create snooze mailbox')
				showError(t('mail', 'Could not create snooze mailbox'))
				return
			}

			await this.patchAccount({
				account,
				data: {
					snoozeMailboxId,
				},
			})
		},
		async setLayout({ list }) {
			try {
				this.setOneLineLayoutMutation({
					list,
				})
			} catch (error) {
				logger.error('Could not set layouts', { error })
			}
		},
		async clearFollowUpReminder({ envelope }) {
			await this.removeEnvelopeTag({
				envelope,
				imapLabel: FOLLOW_UP_TAG_LABEL,
			})
			this.removeEnvelopeFromFollowUpMailboxMutation({
				id: envelope.databaseId,
			})
		},
		async checkFollowUpReminders() {
			const envelopes = this.getFollowUpReminderEnvelopes
			const messageIds = envelopes.map((envelope) => envelope.databaseId)
			if (messageIds.length === 0) {
				return
			}

			const data = await FollowUpService.checkMessageIds(messageIds)
			for (const messageId of data.wasFollowedUp) {
				const envelope = this.getEnvelope(messageId)
				if (!envelope) {
					continue
				}

				await this.clearFollowUpReminder({ envelope })
			}
		},
		async fetchMyTextBlocks() {
			const textBlocks = await fetchMyTextBlocks()
			this.setMyTextBlocks(textBlocks)
		},
		async fetchSharedTextBlocks() {
			const textBlocks = await fetchSharedTextBlocks()
			this.setSharedTextBlocks(textBlocks)
		},
		async createTextBlock({ title, content }) {
			const textBlock = await createTextBlock(title, content)
			this.addTextBlock(textBlock)
		},
		async deleteTextBlock({ id }) {
			await deleteTextBlock(id)
			this.deleteTextBlockLocally(id)
		},
		async patchTextBlock(textBlock) {
			const result = await updateTextBlock(textBlock)
			this.patchTextBlockLocally(result)
		},
		async createQuickAction(name, accountId) {
			const quickAction = await createQuickAction(name, accountId)
			this.addQuickActionLocally(quickAction)
			return quickAction
		},
		async deleteQuickAction(id) {
			await deleteQuickAction(id)
			this.deleteQuickActionLocally(id)
		},
		async patchQuickAction(id, name) {
			const quickAction = await updateQuickAction(id, name)
			this.patchQuickActionLocally(quickAction)
			return quickAction
		},
		sortAccounts(accounts) {
			accounts.sort((a1, a2) => a1.order - a2.order)
			return accounts
		},
		/**
		 * Convert envelope tag objects to references and add new tags to global list.
		 *
		 * @param {object} envelope envelope with tag objects
		 */
		normalizeTags(envelope) {
			if (Array.isArray(envelope.tags)) {
				// Tags have been normalized already
				return
			}

			const tags = Object
				.entries(envelope.tags ?? {})
				.map(([imapLabel, tag]) => {
					if (!this.tags[tag.id]) {
						Vue.set(this.tags, tag.id, tag)
					}
					if (!this.tagList.includes(tag.id)) {
						this.tagList.push(tag.id)
					}
					return tag.id
				})

			Vue.set(envelope, 'tags', tags)
		},

		/**
		 * Append or replace an envelope id for an existing message list
		 *
		 * If the given thread root id exist the message is replaced
		 * otherwise appended
		 *
		 * @param {Array} existing list of envelope ids for a message list
		 * @param {object} envelope envelope with tag objects
		 * @return {Array} list of envelope ids
		 */
		appendOrReplaceEnvelopeId(existing, envelope) {
			if (this.getPreference('layout-message-view') === 'singleton') {
				existing.push(envelope.databaseId)
			} else {
				const index = existing.findIndex((id) => this.envelopes[id].threadRootId === envelope.threadRootId)
				if (index === -1) {
					existing.push(envelope.databaseId)
				} else {
					existing[index] = envelope.databaseId
				}
			}

			return existing
		},
		savePreferenceMutation({
			key,
			value,
		}) {
			Vue.set(this.preferences, key, value)
		},
		setSessionExpiredMutation() {
			this.isExpiredSession = true
		},
		addAccountMutation(account) {
			account.collapsed = account.collapsed ?? true

			Vue.set(this.accountsUnmapped, account.id, account)

			this.accountList.push(account.id)

			const mappedAccounts = this.accountList.map((id) => this.accountsUnmapped[id])
			this.accountList = this.sortAccounts(mappedAccounts).map((a) => a.id)

			// Save the mailboxes to the store, but only keep IDs in the account's mailboxes list
			const mailboxes = sortMailboxes(account.mailboxes || [], account)
			Vue.set(account, 'mailboxes', [])
			Vue.set(account, 'aliases', account.aliases ?? [])

			mailboxes.map(addMailboxToState(this.mailboxes, account))
		},
		editAccountMutation(account) {
			Vue.set(this.accountsUnmapped, account.id, { ...this.accountsUnmapped[account.id], ...account })
		},
		patchAccountMutation({
			account,
			data,
		}) {
			Vue.set(this.accountsUnmapped, account.id, { ...this.accountsUnmapped[account.id], ...data })
		},
		saveAccountsOrderMutation({
			account,
			order,
		}) {
			Vue.set(account, 'order', order)
			this.accountList = this
				.sortAccounts(this.accountList.map((id) => this.accountsUnmapped[id]))
				.map((a) => a.id)
		},
		toggleAccountCollapsedMutation(accountId) {
			this.accountsUnmapped[accountId].collapsed = !this.accountsUnmapped[accountId].collapsed
		},
		expandAccountMutation(accountId) {
			this.accountsUnmapped[accountId].collapsed = false
		},
		setAccountSettingMutation({
			accountId,
			key,
			value,
		}) {
			const accountSettings = this.allAccountSettings.find((settings) => settings.accountId === accountId)
			if (accountSettings) {
				accountSettings[key] = value
			} else {
				const newAccountSettings = { accountId }
				newAccountSettings[key] = value
				this.allAccountSettings.push(newAccountSettings)
			}
		},
		addMailboxMutation({
			account,
			mailbox,
		}) {
			addMailboxToState(this.mailboxes, account, mailbox)
		},
		updateMailboxMutation({ mailbox }) {
			const account = this.accountsUnmapped[mailbox.accountId]
			transformMailboxName(account, mailbox)
			Object.defineProperty(mailbox, 'isSubscribed', {
				get() {
					return this.attributes?.includes('\\subscribed') ?? false
				},
			})
			Vue.set(this.mailboxes, mailbox.databaseId, mailbox)
		},
		removeMailboxMutation({ id }) {
			const mailbox = this.mailboxes[id]
			if (mailbox === undefined) {
				throw new Error(`Mailbox ${id} does not exist`)
			}
			const account = this.accountsUnmapped[mailbox.accountId]
			if (account === undefined) {
				throw new Error(`Account ${mailbox.accountId} of mailbox ${id} is unknown`)
			}
			Vue.delete(this.mailboxes, id)

			// Travers through the account and the full mailbox tree to find any dangling pointers
			const removeRec = (parent) => {
				parent.mailboxes = parent.mailboxes.filter((mbId) => mbId !== id)
				parent.mailboxes.map((mbid) => removeRec(this.mailboxes[mbid]))
			}
			removeRec(account)
		},
		/**
		 * Start a new composer session and open the modal.
		 *
		 * @param {object} payload Data for the new message
		 * @param payload.type
		 * @param {ComposerSessionData} payload.data
		 * @param payload.forwardedMessages
		 * @param payload.originalSendAt
		 * @param payload.smartReply
		 */
		startComposerSessionMutation({
			type,
			data,
			forwardedMessages,
			originalSendAt,
			smartReply,
		}) {
			this.composerSessionId = this.nextComposerSessionId
			this.nextComposerSessionId++
			this.newMessage = {
				type,
				data,
				options: {
					forwardedMessages,
					originalSendAt,
					smartReply,
				},
				indicatorDisabled: false,
			}
			this.composerMessageIsSaved = false
			this.showMessageComposer = true
		},
		/**
		 * Stop current composer session and close the modal.
		 * This discards all data from the current message.
		 *
		 */
		stopComposerSessionMutation() {
			this.composerSessionId = undefined
			this.newMessage = undefined
			this.showMessageComposer = false
		},
		/**
		 * Show composer modal if there is an ongoing session.
		 *
		 */
		showMessageComposerMutation() {
			if (this.composerSessionId) {
				this.showMessageComposer = true
			}
		},
		/**
		 * Hide composer modal without ending the current session.
		 *
		 */
		hideMessageComposerMutation() {
			this.showMessageComposer = false
		},
		setComposerMessageSavedMutation(saved) {
			this.composerMessageIsSaved = saved
		},
		patchComposerDataMutation(data) {
			this.newMessage.data = {
				...this.newMessage.data,
				...data,
			}
		},
		setComposerIndicatorDisabledMutation(disabled) {
			this.newMessage.indicatorDisabled = disabled
		},
		convertComposerMessageToOutboxMutation({ message }) {
			if (!this.newMessage) {
				// If the message is dispatched in the background there is no newMessage data in state
				return
			}
			Vue.set(this.newMessage, 'type', 'outbox')
			Vue.set(this.newMessage.data, 'id', message.id)
		},
		addEnvelopesMutation({
			query,
			envelopes,
			addToUnifiedMailboxes = true,
			// fetchEnvelopes() fetches a fresh, authoritative "what
			// currently matches this query" snapshot (at least the first
			// page) -- unlike an incremental sync's newMessages, a message
			// that no longer matches the query (e.g. a message that was
			// unread in an 'is:unread' filter's list and has since been
			// read) must not linger in the cached envelopeLists array just
			// because this particular call didn't mention it. The default
			// (merge-only) behaviour stays correct for incremental sync
			// and pagination, which only ever report a subset of changes,
			// not a full current-state snapshot. Only meaningful together
			// with replaceMailboxId, since an empty envelopes array alone
			// can't say which mailbox's list to clear.
			replace = false,
			replaceMailboxId,
		}) {
			// A list must never break on an id whose envelope is gone from
			// this.envelopes (left behind by an incomplete removal). Reading
			// .dateInt off undefined threw here, which killed the WHOLE
			// mutation -- from that moment on, the affected bucket silently
			// rejected every new envelope: the sync response kept re-serving
			// the same messages as "new" on every poll (their ids never made
			// it into the list the client reports as known), the listing
			// froze for new arrivals, and everything chained after the sync
			// (e.g. the new-message notification) never ran. Confirmed live
			// on a mailbox whose messages get deleted by another client
			// between polls. Stale ids are dropped with a warning so the
			// leaving mutation can be identified from the console.
			const idToDateInt = (id) => this.envelopes[id]?.dateInt ?? 0
			const dropStaleIds = (list, mailboxId) => list.filter((knownId) => {
				if (this.envelopes[knownId] === undefined) {
					logger.warn(`dropping stale envelope id ${knownId} from a list of mailbox ${mailboxId} -- some removal left it behind`)
					return false
				}
				return true
			})

			const listId = normalizedEnvelopeListId(query)
			const orderByDateInt = orderBy(idToDateInt, this.preferences['sort-order'] === 'newest' ? 'desc' : 'asc')

			if (replace) {
				const mailbox = this.mailboxes[replaceMailboxId]
				envelopes.forEach((envelope) => {
					this.normalizeTags(envelope)
					Vue.set(this.envelopes, envelope.databaseId, { ...this.envelopes[envelope.databaseId] || {}, ...envelope, flags: withRecentFlagOverrides(envelope.databaseId, envelope.flags) })
					Vue.set(envelope, 'accountId', mailbox.accountId)
				})
				Vue.set(mailbox.envelopeLists, listId, uniq(orderByDateInt(envelopes.map((e) => e.databaseId))))

				if (addToUnifiedMailboxes) {
					const unifiedAccount = this.accountsUnmapped[UNIFIED_ACCOUNT_ID]
					unifiedAccount.mailboxes
						.map((mbId) => this.mailboxes[mbId])
						.filter((mb) => mb.specialRole && mb.specialRole === mailbox.specialRole)
						.forEach((unifiedMailbox) => {
							const existing = dropStaleIds(unifiedMailbox.envelopeLists[listId] || [], unifiedMailbox.databaseId)
							Vue.set(
								unifiedMailbox.envelopeLists,
								listId,
								uniq(orderByDateInt(existing.concat(envelopes.map((e) => e.databaseId)))),
							)
						})
				}
				return
			}

			if (envelopes.length === 0) {
				return
			}

			envelopes.forEach((envelope) => {
				const mailbox = this.mailboxes[envelope.mailboxId]
				const existing = dropStaleIds(mailbox.envelopeLists[listId] || [], mailbox.databaseId)
				this.normalizeTags(envelope)
				Vue.set(this.envelopes, envelope.databaseId, { ...this.envelopes[envelope.databaseId] || {}, ...envelope, flags: withRecentFlagOverrides(envelope.databaseId, envelope.flags) })
				Vue.set(envelope, 'accountId', mailbox.accountId)
				Vue.set(mailbox.envelopeLists, listId, uniq(orderByDateInt(this.appendOrReplaceEnvelopeId(existing, envelope))))
				if (addToUnifiedMailboxes) {
					const unifiedAccount = this.accountsUnmapped[UNIFIED_ACCOUNT_ID]
					unifiedAccount.mailboxes
						.map((mbId) => this.mailboxes[mbId])
						.filter((mb) => mb.specialRole && mb.specialRole === mailbox.specialRole)
						.forEach((mailbox) => {
							const existing = dropStaleIds(mailbox.envelopeLists[listId] || [], mailbox.databaseId)
							Vue.set(
								mailbox.envelopeLists,
								listId,
								uniq(orderByDateInt(existing.concat([envelope.databaseId]))),
							)
						})
				}

				// Runs regardless of addToUnifiedMailboxes: even a
				// per-account fan-out call (which passes false to avoid
				// double-posting into the unified view before the fan-out's
				// own combine step runs) must still keep the SOURCE
				// mailbox's own flag-predicate buckets correct.
				//
				// excludeListId: this call's OWN listId was just set,
				// above, directly from the server's response for exactly
				// that query -- that's the authoritative answer for THIS
				// bucket specifically and must not be second-guessed from
				// envelope.flags (which, for a query as narrow as
				// is:pi-important, the server already filtered on; the
				// reclassification here is only for the OTHER, sibling
				// buckets a coalesced '' sync didn't separately ask about).
				this.reclassifyFlagBucketsMutation({ envelope, sourceMailbox: mailbox, includeUnified: addToUnifiedMailboxes, excludeListId: listId })
			})
		},
		// Several search buckets are really just a boolean predicate over a
		// flag the client already has on every envelope it knows about
		// (is:starred/not:starred <-> flags.flagged, is:pi-important/
		// is:pi-other <-> flags.important) -- server-materialized lists
		// that the same-listId cross-post above never reaches, so they
		// stayed stale until their OWN server round-trip. That round-trip
		// is what wave 1b's bucket coalescing removes for the common case
		// (see syncOneWatchedMailbox): once the mailbox's unfiltered ''
		// bucket is synced, every OTHER loaded flag-predicate bucket for
		// that same mailbox can be kept correct locally, from the exact
		// flag the '' sync already reported, instead of its own separate
		// sync. Same principle the priority-inbox freshness fix already
		// established for new mail (see addEnvelopesMutation's caller);
		// this additionally handles a flag FLIPPING on an existing,
		// already-classified message (a star toggled, the AI important
		// classifier changing its mind) -- addEnvelopesMutation's merge
		// path only ever inserted, never moved an envelope OUT of a
		// bucket it no longer matches.
		//
		// Only touches lists that are ALREADY loaded (nothing is loaded
		// speculatively), and only the envelope's own mailbox plus
		// whichever unified-account mailboxes share its specialRole --
		// the same scope the existing cross-post above already uses.
		reclassifyFlagBucketsMutation({ envelope, sourceMailbox, includeUnified = true, excludeListId = null }) {
			const pairs = [
				{ flag: 'flagged', matchQuery: 'is:starred', otherQuery: 'not:starred', inboxOnly: false },
				{ flag: 'important', matchQuery: priorityImportantQuery, otherQuery: priorityOtherQuery, inboxOnly: true },
			]
			const orderByDateInt = orderBy((id) => this.envelopes[id]?.dateInt ?? 0, this.preferences['sort-order'] === 'newest' ? 'desc' : 'asc')

			const targetMailboxes = [sourceMailbox]
			if (includeUnified) {
				const unifiedAccount = this.accountsUnmapped[UNIFIED_ACCOUNT_ID]
				unifiedAccount.mailboxes
					.map((mbId) => this.mailboxes[mbId])
					.filter((mb) => mb.specialRole && mb.specialRole === sourceMailbox.specialRole)
					.forEach((mb) => targetMailboxes.push(mb))
			}

			for (const mailbox of targetMailboxes) {
				for (const pair of pairs) {
					if (pair.inboxOnly && sourceMailbox.specialRole !== 'inbox') {
						continue
					}
					const matches = envelope.flags?.[pair.flag] === true
					const matchListId = normalizedEnvelopeListId(pair.matchQuery)
					const otherListId = normalizedEnvelopeListId(pair.otherQuery)
					const move = (listId, shouldContain) => {
						if (listId === excludeListId) {
							return
						}
						const list = mailbox.envelopeLists[listId]
						if (list === undefined) {
							return
						}
						const withoutSelf = list.filter((id) => id !== envelope.databaseId && this.envelopes[id] !== undefined)
						Vue.set(
							mailbox.envelopeLists,
							listId,
							shouldContain ? uniq(orderByDateInt(withoutSelf.concat([envelope.databaseId]))) : withoutSelf,
						)
					}
					move(matchListId, matches)
					move(otherListId, !matches)
				}
			}
		},
		updateEnvelopeMutation({ envelope }) {
			const existing = this.envelopes[envelope.databaseId]
			if (!existing) {
				return
			}
			this.normalizeTags(envelope)

			const flags = withRecentFlagOverrides(envelope.databaseId, envelope.flags)

			// Skip no-op updates: the server's sync response reports EVERY
			// known message as "changed" on EVERY sync (SyncService.php still
			// carries the upstream TODO for computing a real changed set), and
			// the watched-mailbox poller syncs every loaded bucket every
			// ~10-15s. Unconditionally Vue.set()ing a fresh flags/tags object
			// each time meant thousands of pointless reactive rebuilds and
			// dependent re-renders per minute, for values that hadn't changed
			// at all -- measured live as a browser tab ballooning by hundreds
			// of MB per minute until earlyoom killed it.
			if (!isEqual(existing.flags, flags)) {
				Vue.set(existing, 'flags', flags)
				// Only when flags actually differ: a flag flip (star
				// toggled, important reclassified) is exactly when bucket
				// membership can change. See reclassifyFlagBucketsMutation
				// for why this needs to run for CHANGED messages too, not
				// just new ones.
				const mailbox = this.mailboxes[envelope.mailboxId]
				if (mailbox) {
					this.reclassifyFlagBucketsMutation({ envelope: { ...envelope, flags }, sourceMailbox: mailbox })
				}
			}
			if (!isEqual(existing.tags, envelope.tags)) {
				Vue.set(existing, 'tags', envelope.tags)
			}
		},
		flagEnvelopeMutation({
			envelope,
			flag,
			value,
		}) {
			const mailbox = this.mailboxes[envelope.mailboxId]
			if (mailbox && flag === 'seen') {
				const unread = mailbox.unread ?? 0
				if (envelope.flags[flag] && !value) {
					Vue.set(mailbox, 'unread', unread + 1)
				} else if (!envelope.flags[flag] && value) {
					Vue.set(mailbox, 'unread', Math.max(unread - 1, 0))
				}
			}
			Vue.set(envelope.flags, flag, value)

			let perEnvelope = recentFlagChanges.get(envelope.databaseId)
			if (!perEnvelope) {
				perEnvelope = new Map()
				recentFlagChanges.set(envelope.databaseId, perEnvelope)
			}
			perEnvelope.set(flag, { value, expiresAt: Date.now() + RECENT_FLAG_CHANGE_GRACE_MS })
		},
		addTagMutation({ tag }) {
			Vue.set(this.tags, tag.id, tag)
			this.tagList.push(tag.id)
		},
		addInternalAddressMutation(address) {
			Vue.set(this.internalAddress, address.id, address)
		},
		removeInternalAddressMutation({ addressId }) {
			this.internalAddress = this.internalAddress.filter((address) => address.id !== addressId)
		},
		deleteTagMutation({ tagId }) {
			this.tagList = this.tagList.filter((id) => id !== tagId)
			Vue.delete(this.tags, tagId)
		},
		addEnvelopeTagMutation({
			envelope,
			tagId,
		}) {
			Vue.set(envelope, 'tags', uniq([...envelope.tags, tagId]))
		},
		updateTagMutation({
			tag,
			displayName,
			color,
		}) {
			tag.displayName = displayName
			tag.color = color
		},
		removeEnvelopeTagMutation({
			envelope,
			tagId,
		}) {
			Vue.set(envelope, 'tags', envelope.tags.filter((id) => id !== tagId))
		},
		removeEnvelopeMutation({ id, query }) {
			const envelope = this.envelopes[id]
			if (!envelope) {
				logger.warn('envelope ' + id + ' is unknown, can\'t remove it')
				return
			}
			const mailbox = this.mailboxes[envelope.mailboxId]

			// "Vanished" from a sync means two very different things
			// depending on which bucket reported it. The unfiltered ''
			// query has no flag/text restriction, so a message missing
			// from ITS "still known" set is genuinely gone from the
			// mailbox (deleted/expunged) -- global removal is correct.
			// A FILTERED bucket's own "vanished" (is:starred, not:starred,
			// a saved search, ...) means only "no longer matches THIS
			// bucket's predicate" -- e.g. a message merely losing its
			// star. The message is still very much present in the
			// mailbox and in every OTHER bucket it belongs to. Treating
			// that the same as a real deletion -- which every explicit
			// caller below (deleteMessage/moveMessage/snoozeMessage/...,
			// none of which pass a query) still correctly does, since
			// those really are "this message left the mailbox for real"
			// -- erased the message from the ENTIRE local store,
			// including the plain inbox view, over a mere flag change.
			// Confirmed on inspection while building wave 1b's bucket
			// coalescing (not observed live, not yet hit in practice).
			const listId = normalizedEnvelopeListId(query)
			if (listId !== '') {
				const list = mailbox.envelopeLists[listId]
				if (list !== undefined) {
					const idx = list.indexOf(id)
					if (idx >= 0) {
						logger.debug('envelope ' + id + ' no longer matches bucket ' + listId + ', removed from just that list', { id, listId })
						list.splice(idx, 1)
					}
				}
				this.accountsUnmapped[UNIFIED_ACCOUNT_ID].mailboxes
					.map((mailboxId) => this.mailboxes[mailboxId])
					.filter((mb) => mb.specialRole && mb.specialRole === mailbox.specialRole)
					.forEach((unifiedMailbox) => {
						const unifiedList = unifiedMailbox.envelopeLists[listId]
						if (unifiedList === undefined) {
							return
						}
						const idx = unifiedList.indexOf(id)
						if (idx >= 0) {
							unifiedList.splice(idx, 1)
						}
					})
				return
			}

			for (const iterListId in mailbox.envelopeLists) {
				if (!Object.hasOwn(mailbox.envelopeLists, iterListId)) {
					continue
				}
				const list = mailbox.envelopeLists[iterListId]
				const idx = list.indexOf(id)
				if (idx < 0) {
					continue
				}
				logger.debug('envelope ' + id + ' removed from mailbox list ' + iterListId)
				list.splice(idx, 1)
			}

			if (!envelope.seen && mailbox.unread) {
				Vue.set(mailbox, 'unread', mailbox.unread - 1)
			}

			this.accountsUnmapped[UNIFIED_ACCOUNT_ID].mailboxes
				.map((mailboxId) => this.mailboxes[mailboxId])
				.filter((mb) => mb.specialRole && mb.specialRole === mailbox.specialRole)
				.forEach((mailbox) => {
					for (const iterListId in mailbox.envelopeLists) {
						if (!Object.hasOwn(mailbox.envelopeLists, iterListId)) {
							continue
						}
						const list = mailbox.envelopeLists[iterListId]
						const idx = list.indexOf(id)
						if (idx < 0) {
							// Not a warning: this envelope simply doesn't
							// match this particular query bucket (e.g. a
							// non-starred message isn't in the "is:starred"
							// list) -- expected for most of a unified/
							// priority mailbox's several buckets on every
							// single removal. Confirmed live: this fired
							// dozens of times per removal, each carrying a
							// full object dump, inconsistent with the
							// identical situation for the envelope's own
							// mailbox lists just above, which already
							// continues silently.
							continue
						}
						logger.debug('envelope removed from unified mailbox', { mailboxId: mailbox.databaseId, id })
						list.splice(idx, 1)
					}
				})

			// Delete references from other threads
			for (const [key, env] of Object.entries(this.envelopes)) {
				if (!env.thread) {
					continue
				}

				const thread = env.thread.filter((threadId) => threadId !== id)
				Vue.set(this.envelopes[key], 'thread', thread)
			}

			Vue.delete(this.envelopes, id)
		},
		removeEnvelopesMutation({ id }) {
			Vue.set(this.mailboxes[id], 'envelopeLists', {})
		},
		removeAllEnvelopesMutation() {
			Object.keys(this.mailboxes).forEach((id) => {
				Vue.set(this.mailboxes[id], 'envelopeLists', {})
			})
		},
		removeEnvelopeFromFollowUpMailboxMutation({ id }) {
			const filteredLists = {}
			const mailbox = this.mailboxes[FOLLOW_UP_MAILBOX_ID]
			for (const listId of Object.keys(mailbox.envelopeLists)) {
				filteredLists[listId] = mailbox.envelopeLists[listId]
					.filter((idInList) => id !== idInList)
			}
			Vue.set(this.mailboxes[FOLLOW_UP_MAILBOX_ID], 'envelopeLists', filteredLists)
		},
		addMessageMutation({ message }) {
			Vue.set(this.messages, message.databaseId, message)
		},
		addMessageItinerariesMutation({
			id,
			itineraries,
		}) {
			const message = this.messages[id]
			if (!message) {
				return
			}
			Vue.set(message, 'itineraries', itineraries)
		},
		addMessageDkimMutation({
			id,
			result,
		}) {
			const message = this.messages[id]
			if (!message) {
				return
			}
			Vue.set(message, 'dkimValid', result.valid)
		},
		addEnvelopeThreadMutation({
			id,
			thread,
		}) {
			// Store the envelopes, merge into any existing object if one exists
			thread.forEach((e) => {
				this.normalizeTags(e)
				const mailbox = this.mailboxes[e.mailboxId]
				Vue.set(e, 'accountId', mailbox.accountId)
				const existing = this.envelopes[e.databaseId] || {}
				const merged = { ...existing, ...e }
				// preserve attachments
				if (existing.attachments && existing.attachments.length > 0) {
					merged.attachments = existing.attachments
				}
				Vue.set(this.envelopes, e.databaseId, merged)
			})

			// Store the references
			Vue.set(this.envelopes[id], 'thread', thread.map((e) => e.databaseId))
		},
		removeMessageMutation({ id }) {
			Vue.delete(this.messages, id)
		},
		createAliasMutation({
			account,
			alias,
		}) {
			account.aliases.push(alias)
		},
		deleteAliasMutation({
			account,
			aliasId,
		}) {
			const index = account.aliases.findIndex((temp) => aliasId === temp.id)
			if (index !== -1) {
				account.aliases.splice(index, 1)
			}
		},
		patchAliasMutation({
			account,
			aliasId,
			data,
		}) {
			const index = account.aliases.findIndex((temp) => aliasId === temp.id)
			if (index !== -1) {
				account.aliases[index] = { ...account.aliases[index], ...data }
			}
		},
		setMailboxUnreadCountMutation({
			id,
			unread,
		}) {
			Vue.set(this.mailboxes[id], 'unread', unread ?? 0)
		},
		setScheduledSendingDisabledMutation(value) {
			this.isScheduledSendingDisabled = value
		},
		setSnoozeDisabledMutation(value) {
			this.isSnoozeDisabled = value
		},
		setActiveSieveScriptMutation({
			accountId,
			scriptData,
		}) {
			Vue.set(this.sieveScript, accountId, scriptData)
		},
		setCurrentUserPrincipalMutation({ currentUserPrincipal }) {
			this.currentUserPrincipal = currentUserPrincipal
		},
		addCalendarMutation({ calendar }) {
			this.calendars = [...this.calendars, calendar]
		},
		setGoogleOauthUrlMutation(url) {
			this.googleOauthUrl = url
		},
		setMasterPasswordEnabledMutation(value) {
			this.masterPasswordEnabled = value
		},
		setMicrosoftOauthUrlMutation(url) {
			this.microsoftOauthUrl = url
		},
		setSmimeCertificatesMutation(certificates) {
			this.smimeCertificates = certificates
		},
		deleteSmimeCertificateMutation({ id }) {
			this.smimeCertificates = this.smimeCertificates.filter((cert) => cert.id !== id)
		},
		addSmimeCertificateMutation({ certificate }) {
			this.smimeCertificates = [...this.smimeCertificates, certificate]
		},
		setOneLineLayoutMutation({ list }) {
			Vue.set(this, 'list', list)
		},
		setHasFetchedInitialEnvelopesMutation(hasFetchedInitialEnvelopes) {
			this.hasFetchedInitialEnvelopes = hasFetchedInitialEnvelopes
		},
		setServerBusyMutation(serverBusy) {
			this.serverBusy = serverBusy
		},
		notificationBurstFiredMutation() {
			this.unengagedNotificationBursts++
		},
		resetNotificationEngagementMutation() {
			if (this.unengagedNotificationBursts !== 0) {
				this.unengagedNotificationBursts = 0
			}
		},
		// Arms the interaction-priority window (see
		// INTERACTION_PRIORITY_WINDOW_MS above) -- called at the start of
		// every direct user action (opening a message, switching folders,
		// starring/deleting/flagging, ...) so the background
		// watched-mailbox poller steps out of the way while it runs.
		setInteractionPriorityMutation() {
			this.interactionPriorityUntil = Date.now() + INTERACTION_PRIORITY_WINDOW_MS
		},
		isInteractionPriorityActive() {
			return Date.now() < this.interactionPriorityUntil
		},
		setFollowUpFeatureAvailableMutation(followUpFeatureAvailable) {
			this.followUpFeatureAvailable = followUpFeatureAvailable
		},
		setContextChatFeatureAvailableMutation(contextChatFeatureAvailable) {
			this.contextChatFeatureAvailable = contextChatFeatureAvailable
		},
		hasCurrentUserPrincipalAndCollectionsMutation(hasCurrentUserPrincipalAndCollections) {
			this.hasCurrentUserPrincipalAndCollections = hasCurrentUserPrincipalAndCollections
		},
		showSettingsForAccountMutation(accountId, section) {
			this.showAccountSettings = {
				accountId,
				section,
			}
		},
		setMyTextBlocks(textBlocks) {
			this.myTextBlocks = textBlocks
			this.textBlocksFetched = true
		},
		setSharedTextBlocks(textBlocks) {
			this.sharedTextBlocks = textBlocks
			this.textBlocksFetched = true
		},
		addTextBlock(textBlock) {
			this.myTextBlocks.push(textBlock)
		},
		deleteTextBlockLocally(id) {
			const index = this.myTextBlocks.findIndex((textBlock) => textBlock.id === id)
			if (index === -1) {
				return
			}
			this.myTextBlocks.splice(index, 1)
		},
		patchTextBlockLocally(textBlock) {
			const index = this.myTextBlocks.findIndex((s) => s.id === textBlock.id)
			if (index !== -1) {
				Vue.set(this.myTextBlocks, index, textBlock)
			}
		},
		setQuickActions(quickActions) {
			this.quickActions = quickActions
		},
		patchQuickActionLocally(quickAction) {
			const index = this.quickActions.findIndex((s) => s.id === quickAction.id)
			if (index !== -1) {
				Vue.set(this.quickActions, index, quickAction)
			}
		},
		patchActionStepsLocally(id, steps) {
			const index = this.quickActions.findIndex((s) => s.id === id)
			if (index !== -1) {
				const updatedQuickAction = this.quickActions[index]
				updatedQuickAction.actionSteps = steps
				Vue.set(this.quickActions, index, updatedQuickAction)
			}
		},
		deleteQuickActionLocally(id) {
			const index = this.quickActions.findIndex((s) => s.id === id)
			if (index !== -1) {
				this.quickActions.splice(index, 1)
			}
		},
		addQuickActionLocally(quickAction) {
			this.quickActions.push(quickAction)
		},
		getPreference(key, def) {
			return defaultTo(def, this.preferences[key])
		},
		getAccount(id) {
			return this.accountsUnmapped[id]
		},
		getMailbox(id) {
			return this.mailboxes[id]
		},
		getMailboxes(accountId) {
			return this.accountsUnmapped[accountId].mailboxes.map((id) => this.mailboxes[id])
		},
		* getRecursiveMailboxIterator(accountId) {
			for (const mailbox of this.getMailboxes(accountId)) {
				yield mailbox

				for (const subMailboxId of mailbox.mailboxes) {
					yield this.getMailbox(subMailboxId)
				}
			}
		},
		getSubMailboxes(id) {
			const mailbox = this.getMailbox(id)
			return mailbox.mailboxes.map((id) => this.mailboxes[id])
		},
		getParentMailbox(id) {
			for (const mailbox of this.getMailboxes(this.getMailbox(id).accountId)) {
				if (mailbox.mailboxes.includes(id)) {
					return mailbox
				}
			}
			return undefined
		},
		getUnifiedMailbox(specialRole) {
			return head(this.accountsUnmapped[UNIFIED_ACCOUNT_ID].mailboxes
				.map((id) => this.mailboxes[id])
				.filter((mailbox) => mailbox.specialRole === specialRole))
		},
		getEnvelope(id) {
			return this.envelopes[id]
		},
		getEnvelopes(mailboxId, query) {
			const list = this.getMailbox(mailboxId).envelopeLists[normalizedEnvelopeListId(query)] || []
			return list.map((msgId) => this.envelopes[msgId])
		},
		getEnvelopesByThreadRootId(accountId, threadRootId) {
			return sortBy(
				prop('dateInt'),
				Object.values(this.envelopes).filter((envelope) => envelope.accountId === accountId && envelope.threadRootId === threadRootId),
			)
		},
		getMessage(id) {
			return this.messages[id]
		},
		getEnvelopeThread(id) {
			logger.debug('get thread for envelope', { id, envelope: this.envelopes[id] })
			const thread = this.envelopes[id]?.thread ?? []
			const envelopes = thread.map((id) => this.envelopes[id])
			return sortBy(prop('dateInt'), envelopes)
		},
		getEnvelopeTags(id) {
			const tags = this.envelopes[id]?.tags ?? []
			return tags.map((tagId) => this.tags[tagId])
		},
		getTag(id) {
			return this.tags[id]
		},
		isInternalAddress(address) {
			const domain = address.split('@')[1]
			return this.internalAddress.some((internalAddress) => internalAddress.address === address || internalAddress.address === domain)
		},
		getActiveSieveScript(accountId) {
			return this.sieveScript[accountId]
		},
		getSmimeCertificate(id) {
			return this.smimeCertificates.find((cert) => cert.id === id)
		},
		getSmimeCertificateByEmail(email) {
			return this.smimeCertificates.find((cert) => cert.emailAddress === email)
		},
		findMailboxBySpecialRole(accountId, specialRole) {
			return this.getMailboxes(accountId).find((mailbox) => mailbox.specialRole === specialRole)
		},
		findMailboxByName(accountId, name) {
			return this.getMailboxes(accountId).find((mailbox) => mailbox.name === name)
		},
		getInbox(accountId) {
			return this.findMailboxBySpecialRole(accountId, 'inbox')
		},
		showSettingsForAccount(accountId) {
			return this.showAccountSettings?.accountId === accountId
		},
		showSettingsSectionForAccount(accountId) {
			if (this.showAccountSettings?.accountId !== accountId) {
				return undefined
			}
			return this.showAccountSettings.section
		},
		getMyTextBlocks() {
			return this.myTextBlocks
		},
		getSharedTextBlocks() {
			return this.sharedTextBlocks
		},
		areTextBlocksFetched() {
			return this.textBlocksFetched
		},
		getQuickActions() {
			return this.quickActions
		},
		async processHtmlBody(id) {
			try {
				const body = await handleHttpAuthErrors(async () => {
					return await fetchMessageHtmlBody(id)
				})
				return DOMPurify.sanitize(body, {
					FORBID_TAGS: ['style'],
				})
			} catch (error) {
				if (error.response?.status === 404) {
					showError(t('mail', 'Sorry, the message could not be loaded. The draft may no longer exist. Please refresh the page and try again.'), { timeout: TOAST_DEFAULT_TIMEOUT * 2 })
				}
				throw error
			}
		},
	}
}
