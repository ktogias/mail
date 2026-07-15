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
	IMPORTANT_TAG_LABEL,
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

// Same reasoning, same fix, for syncEnvelopes()'s virtual-mailbox
// (unified/priority-inbox) fan-out: Priority Inbox's three section
// components (Important/Favorites/Other) each independently call
// sync() on mount, and maybeStartPriorityInboxRefresh()'s own
// background loop can ask for the exact same (mailboxId, query) around
// the same moment too. Without dedup, two independent callers for the
// same virtual mailbox + query each kick off their own full fan-out --
// a concurrent sync of every constituent real mailbox, repeated.
// Confirmed live: three near-identical waves of the same 5 real
// mailboxes firing within under a second of a hard reload (see
// nextcloud-mail-oauth-integration.md). Keyed on mailboxId+query (not
// just mailboxId) since Important/Favorites/Other are legitimately
// different requests that must NOT collapse into each other -- only
// two callers asking for the literal same bucket should share one
// in-flight request.
const pendingUnifiedSyncs = new Map()

// Upper bound for a single message/thread fetch -- see fetchMessage()
// for the reasoning. Well above the slowest legitimate fetch observed
// (~25-60s cache-miss body via a slow provider), well below forever.
const FETCH_MESSAGE_TIMEOUT_MS = 90 * 1000

// Speculative (prefetch-triggered, i.e. called with { speculative: true }
// from HoverPrefetchMixin/ViewportPrefetchMixin) fetches get their own
// AbortController here, tracked separately from pendingMessageFetches/
// pendingThreadFetches above (which exist purely for dedup, not
// cancellation) -- so a REAL navigation (Thread.vue::resetThread()) can
// call cancelSpeculativeFetchesExcept() below to abort every OTHER
// in-flight speculative fetch the instant it happens.
//
// Confirmed live (2026-07-12, thread 926521): viewport-prefetch firing
// for ~20 messages scrolled past in Priority Inbox saturated the 3-worker
// mailwrite pool for over two minutes, queueing a real, user-clicked
// message open behind them for ~31s on top of its own ~25s execution --
// nearly a minute total for what should have been an ordinary open. A
// prefetch that hasn't resolved by the time the user commits to opening
// something else is provably wasted work from that moment on; aborting it
// frees the worker/IMAP connection immediately, and costs nothing since
// the request was never going to be used anyway.
const speculativeMessageFetchControllers = new Map()
const speculativeThreadFetchControllers = new Map()

// How many speculative fetchMessage() calls -- from ANY of the five
// trigger paths (HoverPrefetchMixin's mouseenter/touchstart,
// ViewportPrefetchMixin's scroll-settle, Thread.vue's own
// prefetchThreadNeighborhood()/prefetchListNeighborhood()) -- are allowed
// an in-flight /body request at once, app-wide. This is the one genuinely
// expensive step in the whole prefetch story: a body fetch that misses
// the 30-day cache is a live IMAP round-trip, measured up to ~30-40s
// against a slow-responding account, and the mailwrite pool serving it is
// only 3 workers wide (see nextcloud-mail-oauth-integration.md). Before
// this cap existed, only ViewportPrefetchMixin nominally limited itself
// (to 2, via viewportPrefetchObserver.js's runIfViewportPrefetchSlotAvailable)
// and even that didn't hold in practice -- its callback fired the fetches
// without returning their promises, so the cap's own "await fn()" resolved
// on the next microtask regardless of whether the requests were still in
// flight, never actually throttling anything (fixed separately in
// Envelope.vue). Hover/touch/thread-neighbor/list-neighbor had no cap at
// all. Confirmed live: a fast scroll through Priority Inbox produced 7+
// concurrent speculative body fetches, several of them slow cache misses,
// saturating every mailwrite worker well ahead of the user's actual click.
// Enforced here, at the one place all five paths converge, rather than in
// each caller -- skipped, not queued, same "a message that misses its
// speculative window still fetches normally, for real, the instant it's
// actually opened" philosophy as the (now-redundant) viewport-specific cap.
const MAX_CONCURRENT_SPECULATIVE_MESSAGE_FETCHES = 2

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
//
// 20s (the original value) comfortably covered ordinary sync latency,
// but this account's own IMAP responses have since been measured up to
// 67.8s (see nextcloud-mail-oauth-integration.md, 2026-07-13) -- well
// past that window. A star toggled (or any flag change) while a sync
// that slow is in flight got its protection expire before that sync's
// stale response even landed, silently reverting the flag and then
// flip-flopping back on the next successful sync -- confirmed live as
// the Favorites section's contents visibly fluctuating. Raised to
// comfortably clear the worst latency actually observed, same
// "generous bound above the slowest legitimate case" reasoning as
// FETCH_MESSAGE_TIMEOUT_MS above.
//
// Generalized from a flags-only map (recentFlagChanges) to also cover
// envelope.tags (setEnvelopeImportant()'s visible badge, previously
// unprotected -- any OTHER tag was unprotected too) and "this id was
// just deliberately removed from a mailbox" (removeEnvelopeMutation(),
// previously unprotected against a stale sync response resurrecting a
// just-deleted message). One shared per-envelope Map, keyed by a
// "field key" that's either a real flag name, the literal string
// 'tags', or 'removedFromMailbox' -- see withRecentFlagOverrides()'s
// own guard for why mixing these in one Map is safe (it only ever
// touches keys that are actually present in the flags object it's
// given, so a 'tags'/'removedFromMailbox' entry for the same envelope
// is simply invisible to it).
const RECENT_FLAG_CHANGE_GRACE_MS = 120 * 1000
let recentLocalChanges = new Map()

// Test-only: module-level, deliberately (must be shared across every
// store instance and survive whichever component happened to trigger
// the original change, not per Pinia-instance state) -- so, like
// resetSharedNetworkLimiterForTests() above, it otherwise persists
// across unrelated tests in the same worker process. Confirmed live in
// this test suite: an envelope id/mailbox id pair reused across two
// completely unrelated test files (mutations.spec.js and
// actions.spec.js) made a stale 'removedFromMailbox' entry from one
// silently suppress a legitimate addEnvelopesMutation() call in the
// other, with no relation between the two tests at all.
export function resetRecentLocalChangesForTests() {
	recentLocalChanges = new Map()
}

// IMPORTANT_TAG_LABEL (imported above) is the IMAP keyword backing the
// important TAG (read by Envelope.vue's isImportant() for the badge) --
// see setEnvelopeImportant() below for why toggling importance needs
// to touch this AND flag_important together, not just one of the two.

/**
 * A query string containing a literal "undefined" token is never
 * legitimate -- every token this app's search syntax actually produces
 * is either a fixed keyword or a real value the user typed, never the
 * literal word "undefined". Its presence is the signature of an
 * undefined value stringified into a compound query somewhere upstream
 * (appendToSearch()'s own comment in MailboxThread.vue documents one
 * specific, already-fixed instance of exactly this class of bug -- this
 * is a second, not yet located occurrence, or a once-created
 * envelopeLists key left over from before that fix, that nothing else
 * ever prunes). The backend's filter parser treats an unrecognized
 * token as a free-text search term, firing the heaviest query the app
 * has (threaded self-join + two recipients JOINs + a correlated ILIKE)
 * -- confirmed live as an 87s/502 and repeated 20s/504 timeouts,
 * specifically hammering every Sent-role mailbox during an active
 * search, once the priority-inbox refresh (see
 * maybeStartPriorityInboxRefresh()) started actually running on every
 * tick instead of rarely at all.
 *
 * Stripping just the bad token, rather than refusing the whole
 * fetch/sync, turns a catastrophically slow malformed query back into
 * the query that should have been sent in the first place -- for a
 * Sent-role mailbox specifically, that's normally the search terms
 * alone with no priority-inbox-style filter at all, since importance/
 * starred classification was never a meaningful concept for a Sent
 * folder to begin with.
 *
 * Applied once, at the two lowest-level entry points
 * (fetchEnvelopes()/syncEnvelopes() below) that every call path --
 * component-level sync, the watched-mailbox poller, the priority-inbox
 * refresh -- ultimately goes through, so nothing upstream needs its own
 * copy of this check to be protected.
 *
 * @param {string|undefined} query
 * @return {string|undefined}
 */
function stripMalformedUndefinedToken(query) {
	if (typeof query !== 'string') {
		return query
	}
	const tokens = query.split(' ')
	const cleaned = tokens.filter((token) => token !== 'undefined')
	if (cleaned.length === tokens.length) {
		return query
	}
	logger.error(`stripped a malformed "undefined" token from a query: "${query}"`, { query })
	return cleaned.join(' ')
}

/**
 * A flag this client changed moments ago (see flagEnvelopeMutation())
 * wins over whatever a sync/listing response says, since that response
 * may have been generated before the server-side change actually
 * landed. Anything NOT recently changed locally still comes straight
 * from the server.
 *
 * recentLocalChanges' per-envelope Map may also hold non-flag entries
 * ('tags', 'removedFromMailbox') for the same envelope -- skipped here
 * via the `flag in incomingFlags` check, since neither of those keys
 * is ever a real property of a flags object. Expiry/cleanup still runs
 * for every entry regardless of kind, so this is the one place all
 * three kinds of entry get pruned, not just flags.
 *
 * @param {string|number} envelopeId
 * @param {object} incomingFlags
 * @return {object}
 */
function withRecentFlagOverrides(envelopeId, incomingFlags) {
	const perEnvelope = recentLocalChanges.get(envelopeId)
	if (!perEnvelope) {
		return incomingFlags
	}
	const now = Date.now()
	let overridden
	for (const [key, change] of perEnvelope) {
		if (change.expiresAt <= now) {
			perEnvelope.delete(key)
			continue
		}
		if (!(key in incomingFlags)) {
			// A 'tags'/'removedFromMailbox' entry for this same
			// envelope, or any other future non-flag field key --
			// none of this function's business.
			continue
		}
		if (incomingFlags[key] !== change.value) {
			overridden = overridden || { ...incomingFlags }
			overridden[key] = change.value
		} else {
			// The server agrees already -- a real, independent
			// confirmation the change landed, not just this client's own
			// optimistic belief. reconcileNearExpiryLocalChanges()'s own
			// active check never needs to bother with this entry now.
			change.confirmed = true
		}
	}
	if (perEnvelope.size === 0) {
		recentLocalChanges.delete(envelopeId)
	}
	return overridden || incomingFlags
}

/**
 * Same reasoning as withRecentFlagOverrides(), for envelope.tags --
 * the array driving, among other things, the visible "important" badge
 * (Envelope.vue's isImportant(), see setEnvelopeImportant() below).
 * Unlike flags, tags is always treated as one whole-array field, not
 * many independently-tracked ones, so there's at most one 'tags' entry
 * per envelope to consider, holding the last locally-set array
 * snapshot rather than a single scalar.
 *
 * @param {string|number} envelopeId
 * @param {Array<string>} incomingTags
 * @return {Array<string>}
 */
function withRecentTagOverrides(envelopeId, incomingTags) {
	const perEnvelope = recentLocalChanges.get(envelopeId)
	if (!perEnvelope) {
		return incomingTags
	}
	const change = perEnvelope.get('tags')
	if (!change) {
		return incomingTags
	}
	if (change.expiresAt <= Date.now()) {
		perEnvelope.delete('tags')
		if (perEnvelope.size === 0) {
			recentLocalChanges.delete(envelopeId)
		}
		return incomingTags
	}
	if (isEqual(incomingTags, change.value)) {
		change.confirmed = true
		return incomingTags
	}
	return change.value
}

/**
 * Records a recentLocalChanges entry for an arbitrary field key --
 * shared bookkeeping helper used by flagEnvelopeMutation() (flag
 * names), addEnvelopeTagMutation()/removeEnvelopeTagMutation() ('tags'),
 * and removeEnvelopeMutation() ('removedFromMailbox').
 *
 * @param {string|number} envelopeId
 * @param {string} fieldKey
 * @param {*} value
 */
function recordRecentLocalChange(envelopeId, fieldKey, value) {
	let perEnvelope = recentLocalChanges.get(envelopeId)
	if (!perEnvelope) {
		perEnvelope = new Map()
		recentLocalChanges.set(envelopeId, perEnvelope)
	}
	// confirmed: true once a normal sync merge (withRecentFlagOverrides()/
	// withRecentTagOverrides()) independently observes the server
	// agreeing -- the common, silent-success case, costing nothing
	// beyond a comparison already being made. Only entries still false
	// by the time they're near expiry are worth reconcileNearExpiryLocalChanges()'s
	// own, more expensive active check.
	perEnvelope.set(fieldKey, { value, expiresAt: Date.now() + RECENT_FLAG_CHANGE_GRACE_MS, confirmed: false })
}

/**
 * Whether this envelope was deliberately, fully removed from this exact
 * mailbox (delete/archive-move/junk-move -- see removeEnvelopeMutation()'s
 * own 'removedFromMailbox' bookkeeping) within the last grace window --
 * consulted by addEnvelopesMutation() before letting a stale sync
 * response resurrect it there. Scoped to the specific mailbox the
 * removal happened in, not global: the same message legitimately
 * reappearing in a DIFFERENT mailbox (e.g. actually landing in Trash
 * after a move) must not be suppressed.
 *
 * @param {string|number} envelopeId
 * @param {string|number} mailboxId
 * @return {boolean}
 */
function isRecentlyRemovedFromMailbox(envelopeId, mailboxId) {
	const perEnvelope = recentLocalChanges.get(envelopeId)
	if (!perEnvelope) {
		return false
	}
	const change = perEnvelope.get('removedFromMailbox')
	if (!change) {
		return false
	}
	if (change.expiresAt <= Date.now()) {
		perEnvelope.delete('removedFromMailbox')
		if (perEnvelope.size === 0) {
			recentLocalChanges.delete(envelopeId)
		}
		return false
	}
	return change.value === mailboxId
}

/**
 * Phase 4 of the unified optimistic-update plan (see
 * /home/ktogias/.claude/plans/generic-hugging-fern.md): a thrown error
 * from an action's own network call does not necessarily mean the real
 * change never landed server-side -- a client-side timeout, or the
 * browser killing an in-flight request when the tab is backgrounded,
 * can both fire an error while the request actually completed. Every
 * grace-guarded action used to revert unconditionally on any error;
 * this confirms against a fresh, authoritative single-envelope fetch
 * first, generalizing the same reasoning deleteMessage()/
 * deleteThread() already apply in their own bespoke "403 means already
 * deleted, that's success" check.
 *
 * Deliberately calls the raw, imported fetchEnvelope() (a real network
 * request, no cache), not the this.fetchEnvelope() store ACTION (which
 * returns a cached value if one exists -- exactly what reconciliation
 * must not trust here).
 *
 * @param {object} options
 * @param {object} options.envelope the envelope the action targeted
 * @param {(authoritative: object|undefined) => boolean} options.hasLanded
 * given the authoritative fetch result (undefined if the message is
 * genuinely gone), decide whether the change this action wanted is
 * already true server-side.
 * @param {() => void} options.revert called only once reconciliation
 * confirms the change genuinely did not land.
 * @return {Promise<boolean>} true if confirmed landed (revert was NOT
 * called) or if reconciliation itself couldn't be completed (fails
 * open -- safer to trust the optimistic UI than compound an already-
 * uncertain situation with a possibly-wrong revert); false if reverted.
 */
async function reconcileOrRevert({ envelope, hasLanded, revert }) {
	let authoritative
	try {
		authoritative = await fetchEnvelope(envelope.accountId, envelope.databaseId)
	} catch (error) {
		logger.debug('could not reconcile after a failed action -- trusting the optimistic state', { error })
		return true
	}
	if (hasLanded(authoritative)) {
		return true
	}
	revert()
	return false
}

// How far ahead of an entry's own expiry the sweep below considers it
// "due soon" -- must comfortably clear the gap between two
// syncWatchedMailboxes() ticks (10-30s, see startWatchedMailboxSync()
// in App.vue) so no entry's window can close between one sweep and the
// next without ever being checked. Generous on purpose: checking a
// couple of ticks early just means a slightly earlier active
// confirmation, not a wrong one -- unlike expiring an entry's
// protection too early, which has no such safety margin at all.
const NEAR_EXPIRY_SWEEP_WINDOW_MS = 45 * 1000

/**
 * Phase 4's other half: the passive confirmation in
 * withRecentFlagOverrides()/withRecentTagOverrides() (a normal sync
 * merge happening to observe the server agreeing) covers the common
 * case for free, but says nothing about an entry nothing ever synced
 * again before its own grace window closes -- e.g. a mailbox nobody's
 * looking at right now. Rather than silently trust the optimistic
 * value forever once the window lapses (today's behavior everywhere
 * before this), this actively confirms any not-yet-confirmed entry
 * once it's close to expiring, and lets whatever the server actually
 * says flow through the normal addEnvelopesMutation()/
 * removeEnvelopeMutation() pipeline -- the same one every other
 * authoritative update already goes through, rather than trying to
 * independently reconstruct "revert to what, exactly" long after the
 * fact for an action this code otherwise has no memory of.
 *
 * Piggybacks on the existing watched-mailbox poller tick
 * (syncWatchedMailboxes()) instead of its own timer -- this is
 * low-priority, infrequent background housekeeping, not something
 * that needs (or deserves) its own polling loop alongside the one
 * that already exists.
 *
 * @param {object} store the Pinia store instance (this from within an action)
 */
export async function reconcileNearExpiryLocalChanges(store) {
	const dueSoon = Date.now() + NEAR_EXPIRY_SWEEP_WINDOW_MS
	const idsDue = []
	for (const [envelopeId, perEnvelope] of recentLocalChanges) {
		for (const change of perEnvelope.values()) {
			if (!change.confirmed && change.expiresAt <= dueSoon) {
				idsDue.push(envelopeId)
				break
			}
		}
	}

	for (const id of idsDue) {
		const envelope = store.getEnvelope(id)
		if (!envelope) {
			// Nothing local left watching this id (already removed by
			// something else, or never actually loaded into the store) --
			// nothing to reconcile against.
			continue
		}
		try {
			// eslint-disable-next-line no-await-in-loop -- deliberately
			// sequential: low-priority background housekeeping, not
			// worth its own concurrency budget.
			const authoritative = await fetchEnvelope(envelope.accountId, id)
			// This IS the reconciliation -- clear every remaining grace-
			// window entry for this envelope first, so the answer just
			// fetched actually lands instead of being immediately
			// re-overridden by withRecentFlagOverrides()/
			// withRecentTagOverrides() reading the very (still
			// unexpired) entries this active check exists to settle.
			recentLocalChanges.delete(id)
			if (authoritative === undefined) {
				store.removeEnvelopeMutation({ id })
			} else {
				store.addEnvelopesMutation({ envelopes: [authoritative] })
			}
		} catch (error) {
			logger.debug('could not actively reconcile a near-expiry local change', { id, error })
		}
	}
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

// A single, shared concurrency budget for every mapWithConcurrencyLimit()
// caller combined -- the priority-inbox section fan-out and the
// watched-mailbox poller each already had their OWN limit
// (ENVELOPE_FETCH_CONCURRENCY, WATCHED_SYNC_CONCURRENCY), which bounded
// each MECHANISM on its own but never their sum. The priority inbox's 3
// sections already multiply their own limit by running concurrently
// against each other (3 x ENVELOPE_FETCH_CONCURRENCY = 9), and the
// watched-mailbox poller's own budget runs fully independently on top of
// that. Confirmed live: a hard reload starts every one of these
// mechanisms from an empty cache at the same instant, and their COMBINED
// in-flight request count -- not any single one of the numbers above --
// is what actually overwhelmed this NAS: a wall of 504s across several
// real mailboxes' priority-inbox buckets at once (see
// nextcloud-mail-oauth-integration.md). Every mapWithConcurrencyLimit()
// worker now also acquires a permit from this ONE shared pool before
// calling `fn`, on top of (not instead of) its own call's existing
// `limit` -- so the actual combined concurrency across every
// simultaneously-active caller is bounded by SHARED_NETWORK_CONCURRENCY
// regardless of how many independent mechanisms happen to be running at
// once. Sized to this NAS's 4 cores as a starting point, not a
// theoretically-derived optimum -- worth re-measuring live if it turns
// out too tight (steady-state polling feeling sluggish) or still too
// loose (bursts still timing out).
const SHARED_NETWORK_CONCURRENCY = 4

class ConcurrencyLimiter {
	constructor(limit) {
		this.limit = limit
		this.active = 0
		this.queue = []
	}

	acquire() {
		if (this.active < this.limit) {
			this.active++
			return Promise.resolve()
		}
		return new Promise((resolve) => this.queue.push(resolve))
	}

	release() {
		this.active--
		const next = this.queue.shift()
		if (next) {
			this.active++
			next()
		}
	}
}

let sharedNetworkLimiter = new ConcurrencyLimiter(SHARED_NETWORK_CONCURRENCY)

// Test-only: the limiter is module-level (deliberately -- it must be
// shared across every store instance, not per-instance state), so it
// otherwise persists across unrelated tests in the same file. A test
// that doesn't drive every one of its mapWithConcurrencyLimit() calls to
// full completion (e.g. one that intentionally leaves work in flight to
// test an abort path) would leak held permits into whichever test runs
// next, silently shrinking its available shared budget.
export function resetSharedNetworkLimiterForTests() {
	sharedNetworkLimiter = new ConcurrencyLimiter(SHARED_NETWORK_CONCURRENCY)
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once for
 * THIS call -- and, on top of that, gated by the single shared
 * `sharedNetworkLimiter` every other concurrent caller also draws from
 * (see SHARED_NETWORK_CONCURRENCY above).
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
export async function mapWithConcurrencyLimit(items, limit, fn) {
	const results = new Array(items.length)
	let nextIndex = 0
	async function worker() {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex++
			await sharedNetworkLimiter.acquire()
			try {
				results[currentIndex] = await fn(items[currentIndex], currentIndex)
			} finally {
				sharedNetworkLimiter.release()
			}
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
		// See lastOpenedFromList in mainStore.js's state() for the full
		// reasoning. mailboxId/query together are exactly what
		// getEnvelopes() needs to reconstruct the same list later.
		setLastOpenedFromListMutation({ mailboxId, query }) {
			this.lastOpenedFromList = { mailboxId, query }
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
			query = stripMalformedUndefinedToken(query)
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
					// A loaded-but-empty list (as opposed to list === undefined
					// above, never loaded at all) has no tail to page past --
					// nothing more to load, by definition, same reasoning as
					// fetchNextFannedOutPage()'s own empty-cursor guard above.
					// This is the plain-mailbox counterpart of that same
					// situation: e.g. a search with zero matches, or (via the
					// priority-inbox fan-out's recursive per-constituent-
					// mailbox call) one real mailbox with no messages
					// matching the current query while others still do.
					// Rejecting here used to turn a completely ordinary
					// "nothing more here" into a console error on every
					// affected mailbox on every scroll tick.
					logger.debug('mailbox has no envelopes for this query, nothing more to page past', { mailboxId, query })
					return Promise.resolve([])
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
			query = stripMalformedUndefinedToken(query)

			// Dedup only ever applies to the virtual-mailbox (unified/
			// priority-inbox) fan-out entry point below, never to a real
			// mailbox's own sync -- the retry chains further down
			// (SyncIncompleteError/MalformedSyncResponseError/
			// MailboxLockedError) recursively call syncEnvelopes() on
			// THEMSELVES for a real mailboxId, and deduping those too
			// would have a retry await its own still-pending promise.
			// See pendingUnifiedSyncs above for why this needs to exist
			// at all.
			const mailboxForFanOut = this.getMailbox(mailboxId)
			const dedupKey = (mailboxForFanOut?.isUnified || mailboxForFanOut?.isPriorityInbox)
				? `${mailboxId}:${query ?? ''}`
				: null
			if (dedupKey !== null && pendingUnifiedSyncs.has(dedupKey)) {
				return pendingUnifiedSyncs.get(dedupKey)
			}

			const promise = handleHttpAuthErrors(async () => {
				logger.debug(`starting mailbox sync of ${mailboxId} (${query})`)

				const mailbox = mailboxForFanOut

				// Skip superfluous requests if using passwordless authentication. They will fail anyway.
				const passwordIsUnavailable = this.getPreference('password-is-unavailable', false)
				const isDisabled = (account) => passwordIsUnavailable && !!account.provisioningId

				if (mailbox.isUnified) {
					// Bounded like fetchEnvelopes()'s own unified/priority
					// fan-out (ENVELOPE_FETCH_CONCURRENCY, and via that the
					// shared cross-mechanism limiter -- see
					// SHARED_NETWORK_CONCURRENCY): this used to be a bare
					// Promise.all with no concurrency limit at all, a
					// completely separate, uncapped fan-out path that the
					// shared-limiter fix never reached because it only
					// wraps mapWithConcurrencyLimit() callers. Confirmed
					// live: every constituent mailbox's sync fired within
					// milliseconds of every other one.
					const targetMailboxes = this.getAccounts
						.filter((account) => !account.isUnified && !isDisabled(account))
						.flatMap((account) => this.getMailboxes(account.id).filter((mb) => mb.specialRole === mailbox.specialRole))
					return mapWithConcurrencyLimit(targetMailboxes, ENVELOPE_FETCH_CONCURRENCY, (mb) => this.syncEnvelopes({
						mailboxId: mb.databaseId,
						query,
						init,
					}))
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
					return Promise.all(queriesToFanOut.map((oneQuery) => {
						// Same bounded-fan-out reasoning as the isUnified
						// branch above.
						const targetMailboxes = this.getAccounts
							.filter((account) => !account.isUnified && !isDisabled(account))
							.flatMap((account) => this.getMailboxes(account.id).filter((mb) => mb.specialRole === mailbox.specialRole))
						return mapWithConcurrencyLimit(targetMailboxes, ENVELOPE_FETCH_CONCURRENCY, (mb) => this.syncEnvelopes({
							mailboxId: mb.databaseId,
							query: oneQuery,
							init,
						}))
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

			if (dedupKey !== null) {
				const tracked = promise.finally(() => pendingUnifiedSyncs.delete(dedupKey))
				pendingUnifiedSyncs.set(dedupKey, tracked)
				return tracked
			}
			return promise
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

			// Fire-and-forget, deliberately outside handleHttpAuthErrors()
			// below -- this is unrelated background housekeeping (see its
			// own doc comment), not part of this tick's actual sync work,
			// and must never fail or delay the real sync tick.
			reconcileNearExpiryLocalChanges(this).catch((error) => {
				logger.debug('reconcileNearExpiryLocalChanges failed for this tick', { error })
			})

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
						const mailbox = this.getMailbox(UNIFIED_INBOX_ID)

						// Refresh whichever query keys are ACTUALLY loaded for
						// the favorites/important/other sections, not just
						// the bare priorityImportantQuery/priorityOtherQuery
						// tokens. "Sort favorites separately" makes
						// MailboxThread.vue load COMPOUND keys instead (e.g.
						// "not:starred is:pi-important" for Important, or
						// plain "is:starred" -- via appendToSearch()
						// substituting it in for 'not:starred' -- for
						// Favorites) -- syncing only the bare
						// important/other keys left the actually-displayed
						// compound-keyed lists (Favorites included) with no
						// dedicated resync of their own: they could only
						// ever be corrected as an incidental side effect of
						// some unrelated mailbox's own bucket sync touching
						// the same envelope id via
						// reclassifyFlagBucketsMutation, which never happens
						// for a message the user isn't otherwise viewing.
						// Confirmed live: a message the classifier
						// downgraded stayed listed as important for 19+
						// hours after flag_important had already flipped to
						// false in the database; the exact same pattern was
						// then seen in the Favorites section for is:starred.
						// Falls back to the bare important/other keys when
						// none of the three is loaded yet (nothing to
						// refresh, or the priority inbox hasn't been opened
						// this session).
						const loadedPriorityQueries = Object.keys(mailbox.envelopeLists)
							.filter((listId) => {
								const tokens = listId.split(' ')
								return tokens.includes(priorityImportantQuery) || tokens.includes(priorityOtherQuery) || tokens.includes('is:starred')
							})
						const queriesToRefresh = loadedPriorityQueries.length > 0
							? loadedPriorityQueries
							: [priorityImportantQuery, priorityOtherQuery]

						for (const query of queriesToRefresh) {
							logger.info("sync'ing priority inbox section", { query })
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

					// is:pi-important/is:pi-other (bare, or compound with
					// not:starred from "sort favorites separately", see
					// appendToSearch()) end up loaded on THIS real mailbox's
					// own envelopeLists as a side effect of
					// maybeStartPriorityInboxRefresh()'s own fan-out
					// (fetchEnvelopes()'s isUnified branch writes to each
					// constituent real mailbox via replace:true), not
					// because this mailbox's own view ever asked for it --
					// unlike is:starred/not:starred, which a REAL folder's
					// own "Favorites" section can legitimately load too
					// (same appendToSearch() output, no way to tell the two
					// origins apart from the query string alone -- see the
					// "does NOT coalesce" test above, which deliberately
					// keeps that case syncing independently). is:pi-
					// important/is:pi-other have no such second origin:
					// this app's importance/other classification only ever
					// exists inside Priority Inbox. maybeStartPriorityInboxRefresh()
					// already owns keeping these two in sync, uniformly,
					// across every inbox-specialRole real mailbox -- having
					// this completely separate, uncoordinated loop ALSO
					// sync the exact same bucket independently every tick
					// means two callers race to read "known ids" from the
					// same envelopeLists array and each apply their own,
					// separately-timed response to it. Confirmed live: the
					// same message reported as "new" by BOTH syncs, over
					// and over, tick after tick, for a thread whose star
					// lives on an older message -- visibly redrawing the
					// Priority Inbox and re-fetching its thread data with
					// no new mail and no user interaction at all. Excluded
					// unconditionally (not just when '' is also loaded,
					// unlike the coalescing above): maybeStartPriorityInboxRefresh()
					// reaches every inbox-specialRole mailbox regardless of
					// what else happens to be loaded on this one specifically.
					const importanceOnlyTokens = new Set([priorityImportantQuery, priorityOtherQuery])
					queriesToSync = queriesToSync.filter((query) => {
						if (typeof query !== 'string') {
							return true
						}
						return !query.split(' ').some((token) => importanceOnlyTokens.has(token))
					})

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
					// Fire-and-forget: gives fast, correct confirmation for
					// any already-loaded Favorites-style bucket this toggle
					// could affect, without making the user wait on it --
					// see refreshFlagPredicateBucketsForEnvelope()'s own doc.
					this.refreshFlagPredicateBucketsForEnvelope(envelope)
				} catch (error) {
					logger.error('Could not toggle message flagged state', { error })

					const landed = await reconcileOrRevert({
						envelope,
						hasLanded: (authoritative) => authoritative?.flags?.flagged === !oldState,
						revert: () => this.flagEnvelopeMutation({ envelope, flag: 'flagged', value: oldState }),
					})
					if (landed) {
						return
					}

					throw error
				}
			})
		},
		async toggleEnvelopeImportant(envelope) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				const hasTag = this
					.getEnvelopeTags(envelope.databaseId)
					.some((tag) => tag.imapLabel === IMPORTANT_TAG_LABEL)
				await this.setEnvelopeImportant(envelope, !hasTag)
			})
		},
		/**
		 * Sets a message's importance to an explicit boolean value,
		 * updating BOTH flag_important (via setEnvelopeFlags()) and the
		 * important tag (via setEnvelopeTag()/removeEnvelopeTag(), which
		 * is what actually drives the visible badge -- see Envelope.vue's
		 * isImportant()) TOGETHER, in the one user action -- mirroring
		 * what NewMessagesClassifier already does server-side (
		 * flagMessage() + tagMessage() in the same request).
		 *
		 * Genuinely optimistic end to end, not just for the flag: earlier
		 * versions of this function set flags.important immediately but
		 * left the tag (and therefore the badge) to update only once the
		 * tag network call resolved -- one round trip -- and Priority
		 * Inbox list membership to update only via the separate,
		 * fire-and-forget refreshFlagPredicateBucketsForEnvelope() resync
		 * below, a *second* round trip. Click -> round trip -> badge ->
		 * round trip -> list membership, a visible, reported lag between
		 * three things that should all happen in the same instant.
		 *
		 * Fixed by resolving the important tag's id locally (getImportantTag,
		 * only possible once at least one important-tagged message has been
		 * loaded this session -- a genuinely cold session with no local
		 * knowledge of the tag yet falls back to the network-first
		 * behavior below, same as before) and applying both the tag
		 * mutation and reclassifyFlagBucketsMutation() -- the local,
		 * no-network bucket classifier addEnvelopesMutation()/
		 * updateEnvelopeMutation() already use -- synchronously, before
		 * any network call. refreshFlagPredicateBucketsForEnvelope() stays
		 * as a backstop for whatever the local classifier's own
		 * deliberately-conservative ratchet couldn't decide (see
		 * threadStillMatchesFlagPredicate()), not the primary mechanism
		 * anymore.
		 *
		 * Shared by both existing entry points for this action so neither
		 * can regress to touching only one of the two independently again.
		 *
		 * @param {object} envelope the envelope to mark, from the store
		 * @param {boolean} important the desired importance state
		 */
		async setEnvelopeImportant(envelope, important) {
			const hasTag = this
				.getEnvelopeTags(envelope.databaseId)
				.some((tag) => tag.imapLabel === IMPORTANT_TAG_LABEL)
			if (hasTag === important) {
				return
			}

			const oldFlagState = envelope.flags.important
			this.flagEnvelopeMutation({
				envelope,
				flag: 'important',
				value: important,
			})

			const importantTag = this.getImportantTag
			const applyTagMutation = (targetImportant) => {
				if (targetImportant) {
					this.addEnvelopeTagMutation({ envelope, tagId: importantTag.id })
				} else {
					this.removeEnvelopeTagMutation({ envelope, tagId: importantTag.id })
				}
			}
			const reclassify = () => {
				const mailbox = this.mailboxes[envelope.mailboxId]
				if (mailbox) {
					this.reclassifyFlagBucketsMutation({ envelope, sourceMailbox: mailbox })
				}
			}

			const optimisticTagMutationApplied = !!importantTag
			if (optimisticTagMutationApplied) {
				applyTagMutation(important)
				reclassify()
			}

			try {
				const [, tag] = await Promise.all([
					setEnvelopeFlags(envelope.databaseId, {
						[IMPORTANT_TAG_LABEL]: important,
					}),
					important
						? setEnvelopeTag(envelope.databaseId, IMPORTANT_TAG_LABEL)
						: removeEnvelopeTag(envelope.databaseId, IMPORTANT_TAG_LABEL),
				])
				if (!this.getTag(tag.id)) {
					this.addTagMutation({ tag })
				}
				if (!optimisticTagMutationApplied) {
					// Cold-start fallback: the tag wasn't known locally
					// yet when this call started, so apply it now that
					// the server confirmed its id.
					if (important) {
						this.addEnvelopeTagMutation({ envelope, tagId: tag.id })
					} else {
						this.removeEnvelopeTagMutation({ envelope, tagId: tag.id })
					}
					const mailbox = this.mailboxes[envelope.mailboxId]
					if (mailbox) {
						this.reclassifyFlagBucketsMutation({ envelope, sourceMailbox: mailbox })
					}
				}
				this.refreshFlagPredicateBucketsForEnvelope(envelope)
			} catch (error) {
				logger.error('Could not toggle message importance', { error })

				const landed = await reconcileOrRevert({
					envelope,
					hasLanded: (authoritative) => authoritative?.flags?.important === important,
					revert: () => {
						this.flagEnvelopeMutation({ envelope, flag: 'important', value: oldFlagState })
						if (optimisticTagMutationApplied) {
							// Undo via the same mutation, not a raw snapshot
							// restore -- re-records a fresh
							// recentLocalChanges 'tags' entry holding the
							// correct (reverted) value, same as
							// flagEnvelopeMutation()'s own revert above, so
							// a legitimate later sync isn't fought by a
							// stale entry still holding the attempted-but-
							// failed value.
							applyTagMutation(!important)
							reclassify()
						}
					},
				})
				if (landed) {
					return
				}

				throw error
			}
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
					this.setHasUnseenInThreadForThreadMutation(envelope, true)
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
						this.setHasUnseenInThreadForThreadMutation(envelope, response.hasUnseenInThread)
					}
				} catch (error) {
					logger.error('could not toggle message seen state', { error })

					const landed = await reconcileOrRevert({
						envelope,
						hasLanded: (authoritative) => authoritative?.flags?.seen === newState,
						revert: () => this.flagEnvelopeMutation({ envelope, flag: 'seen', value: oldState }),
					})
					if (landed) {
						return
					}

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

					// Reconciled on the flag alone -- the primary,
					// always-attempted change. If it landed, the junk
					// state is correct even if the separate move-to-junk-
					// mailbox step below failed on its own (a partial-
					// success state better left as is than fully reverted
					// over an auxiliary step); only revert (and, if this
					// was a removal, re-add the envelope) when the flag
					// itself genuinely never landed.
					const landed = await reconcileOrRevert({
						envelope,
						hasLanded: (authoritative) => authoritative?.flags?.$junk === !oldState,
						revert: () => {
							if (removeEnvelope) {
								this.addEnvelopesMutation({ envelopes: [envelope], bypassRemovalSuppression: true })
							}
							this.flagEnvelopeMutation({ envelope, flag: '$junk', value: oldState })
							this.flagEnvelopeMutation({ envelope, flag: '$notjunk', value: !oldState })
						},
					})
					if (landed) {
						return
					}

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
				await this.setEnvelopeImportant(envelope, addTag)
			})
		},
		async fetchThread(id, { speculative = false } = {}) {
			if (pendingThreadFetches.has(id)) {
				return pendingThreadFetches.get(id)
			}

			// speculative=true (HoverPrefetchMixin/ViewportPrefetchMixin
			// only): combine the usual hung-request timeout with a second,
			// externally-triggerable AbortController so
			// cancelSpeculativeFetchesExcept() can cut this short the
			// instant it's no longer the thread the user's actually
			// opening. Real (non-speculative) callers keep the plain
			// timeout-only signal -- never abortable out from under an
			// actual navigation.
			let signal = AbortSignal.timeout(FETCH_MESSAGE_TIMEOUT_MS)
			if (speculative) {
				const controller = new AbortController()
				speculativeThreadFetchControllers.set(id, controller)
				signal = AbortSignal.any([signal, controller.signal])
			}

			// Same reasoning as fetchMessage() below: this promise gates
			// Thread.vue's loading state and must always settle, and is
			// shared via the dedup map so a concurrent caller (hover
			// prefetch racing an actual open) reuses it instead of firing
			// a duplicate request.
			const promise = handleHttpAuthErrors(async () => {
				const thread = await fetchThread(id, { signal })
				this.addEnvelopeThreadMutation({
					id,
					thread,
				})
				return thread
			}).finally(() => {
				pendingThreadFetches.delete(id)
				speculativeThreadFetchControllers.delete(id)
			})
			pendingThreadFetches.set(id, promise)
			return promise
		},
		async fetchMessage(id, { speculative = false } = {}) {
			if (this.messages[id]) {
				return this.messages[id]
			}

			if (pendingMessageFetches.has(id)) {
				return pendingMessageFetches.get(id)
			}

			// Skip rather than queue once every speculative slot is taken --
			// see MAX_CONCURRENT_SPECULATIVE_MESSAGE_FETCHES above. Never
			// applies to a real (non-speculative) call: the user's actual
			// click always fetches, regardless of how much speculative
			// activity is in flight.
			if (speculative && speculativeMessageFetchControllers.size >= MAX_CONCURRENT_SPECULATIVE_MESSAGE_FETCHES) {
				return undefined
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
			let signal = AbortSignal.timeout(FETCH_MESSAGE_TIMEOUT_MS)
			if (speculative) {
				// See fetchThread() above for the reasoning.
				const controller = new AbortController()
				speculativeMessageFetchControllers.set(id, controller)
				signal = AbortSignal.any([signal, controller.signal])
			}

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
				speculativeMessageFetchControllers.delete(id)
			})
			pendingMessageFetches.set(id, promise)
			return promise
		},
		// Called from Thread.vue::resetThread() the instant a real open
		// happens, before anything else: every OTHER in-flight speculative
		// fetch is now provably wasted work (the user just committed to a
		// different message/thread), so abort it immediately rather than
		// let it keep occupying a mail-pool worker/IMAP connection the
		// real open needs. The id actually being opened is exempted --
		// if it already had a speculative fetch in flight (a hover/touch/
		// viewport prefetch that happened to guess right), that request
		// keeps going and the real open's own fetchMessage()/fetchThread()
		// call dedupes into it via pendingMessageFetches/
		// pendingThreadFetches, rather than being needlessly restarted.
		cancelSpeculativeFetchesExcept(id) {
			for (const [fetchId, controller] of speculativeMessageFetchControllers) {
				if (fetchId !== id) {
					controller.abort()
				}
			}
			for (const [fetchId, controller] of speculativeThreadFetchControllers) {
				if (fetchId !== id) {
					controller.abort()
				}
			}
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
					// MessagesController::destroy() returns 403 (not the
					// more usual 404) specifically and only when the
					// message row is already gone by the time the
					// (deferred, up to ~10s after the click, per the undo
					// window) delete call reaches the server -- confirmed
					// against the controller's own DoesNotExistException
					// catch, the only source of a 403 on this route. A
					// message that's already deleted is exactly the
					// outcome the user asked for: treat it as a success,
					// not an error -- resurrecting it via
					// addEnvelopesMutation() below and showing "Could not
					// delete message" would be actively wrong (it WAS
					// deleted), confirmed live as the confusing result of
					// a duplicate delete request racing an earlier one
					// for the same message.
					if (err.response?.status === 403) {
						logger.debug('message was already deleted', { id })
						return
					}
					logger.error('could not delete message', { error: err })
					const envelope = this.getEnvelope(id)
					if (envelope) {
						this.addEnvelopesMutation({ envelopes: [envelope], bypassRemovalSuppression: true })
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
			// Every singular-message equivalent (deleteMessage/moveMessage/
			// snoozeMessage) arms this synchronously, first thing -- this
			// whole Thread family didn't, so syncWatchedMailboxes()'s
			// background poller had no signal that a delete/move/snooze
			// was just requested and was free to race the optimistic
			// removeEnvelopeMutation() below with its own priority-inbox
			// refresh, re-adding the just-deleted envelope from a response
			// that reflects server state from before the delete landed.
			// Confirmed live: deleting a thread from Priority Inbox on a
			// slower (mobile) connection sometimes reappeared seconds
			// later. See nextcloud-mail-oauth-integration.md.
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				this.removeEnvelopeMutation({ id: envelope.databaseId })

				try {
					await ThreadService.deleteThread(envelope.databaseId)
					logger.debug('thread removed')
				} catch (e) {
					// Same reasoning as deleteMessage()'s own 403 guard
					// above: ThreadController::delete() returns 403 only
					// and exactly when the message is already gone by the
					// time this (undo-window-deferred) call reaches the
					// server -- a duplicate/stale delete racing an
					// earlier one that already succeeded, not a real
					// failure. Confirmed live.
					if (e.response?.status === 403) {
						logger.debug('thread was already deleted', { id: envelope.databaseId })
						return
					}
					this.addEnvelopesMutation({ envelopes: [envelope], bypassRemovalSuppression: true })
					logger.error('could not delete thread', { error: e })
					throw e
				}
			})
		},
		async moveThread({
			envelope,
			destMailboxId,
		}) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				this.removeEnvelopeMutation({ id: envelope.databaseId })

				try {
					await ThreadService.moveThread(envelope.databaseId, destMailboxId)
					logger.debug('thread moved')
				} catch (e) {
					logger.error('could not move thread', { error: e })

					const landed = await reconcileOrRevert({
						envelope,
						hasLanded: (authoritative) => authoritative?.mailboxId === destMailboxId,
						revert: () => this.addEnvelopesMutation({ envelopes: [envelope], bypassRemovalSuppression: true }),
					})
					if (landed) {
						return
					}

					throw e
				}
			})
		},
		async snoozeThread({
			envelope,
			unixTimestamp,
			destMailboxId,
		}) {
			this.setInteractionPriorityMutation()
			return handleHttpAuthErrors(async () => {
				try {
					await ThreadService.snoozeThread(envelope.databaseId, unixTimestamp, destMailboxId)
					logger.debug('thread snoozed')
				} catch (e) {
					this.addEnvelopesMutation({ envelopes: [envelope], bypassRemovalSuppression: true })
					logger.error('could not snooze thread', { error: e })
					throw e
				}
				this.removeEnvelopeMutation({ id: envelope.databaseId })
			})
		},
		async unSnoozeThread({ envelope }) {
			this.setInteractionPriorityMutation()
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
		 * @param {{ids: Array, indexByThreadKey: Map}} working the batch's
		 *        working list for one mailbox (see addEnvelopesMutation's
		 *        workingListFor()) -- ids is the list of envelope ids
		 *        itself, indexByThreadKey is the O(1) thread-root -> index
		 *        lookup kept in sync alongside it, replacing what used to
		 *        be an O(L) findIndex() scan per envelope (confirmed live
		 *        as part of the Firefox-unresponsive-script investigation:
		 *        large batches against large, thousands-of-ids mailboxes
		 *        made this scan itself a real, measurable cost, on top of
		 *        the read-sort-dedupe-write batching fix that addressed
		 *        the rest of that same slowdown).
		 * @param {object} envelope envelope with tag objects
		 * @return {Array} ids, for convenience -- same array working.ids
		 *        already points at
		 */
		appendOrReplaceEnvelopeId(working, envelope) {
			if (this.getPreference('layout-message-view') === 'singleton') {
				working.ids.push(envelope.databaseId)
				return working.ids
			}

			// threadRootId is genuinely NULL/absent for any message the
			// server never grouped into a thread at all (confirmed
			// server-side too -- see findIdsByQuery()'s own comment: "NULL
			// never equals NULL", so a thread-less message only ever
			// matches itself) -- unlike SQL, JS's === would treat two
			// DIFFERENT thread-less envelopes' undefined threadRootId as
			// equal, incorrectly collapsing one into the other. Falling
			// back to the envelope's own id keeps every thread-less
			// message its own, independent entry, matching the server's
			// own semantics instead of silently overwriting an unrelated
			// message.
			const key = envelope.threadRootId ?? `id:${envelope.databaseId}`
			const index = working.indexByThreadKey.get(key)
			if (index === undefined) {
				working.indexByThreadKey.set(key, working.ids.length)
				working.ids.push(envelope.databaseId)
			} else {
				working.ids[index] = envelope.databaseId
			}

			return working.ids
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
			// The 5 revert-on-failure call sites (deleteMessage(),
			// toggleEnvelopeJunk(), ...) call this with the exact
			// envelope removeEnvelopeMutation() just optimistically took
			// out, to put it back after the real network call failed --
			// an intentional "that removal didn't actually happen",
			// which must bypass the stale-sync suppression below, not
			// trigger it. Every other caller (background sync, a normal
			// fetch) leaves this false, which is what the suppression is
			// actually meant to guard against.
			bypassRemovalSuppression = false,
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
					Vue.set(this.envelopes, envelope.databaseId, {
						...this.envelopes[envelope.databaseId] || {},
						...envelope,
						flags: withRecentFlagOverrides(envelope.databaseId, envelope.flags),
						tags: withRecentTagOverrides(envelope.databaseId, envelope.tags),
					})
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

			// Reading a list back out of Vue, sorting it, deduplicating it,
			// and writing it back through Vue.set is not free -- every id
			// touched along the way is a reactive property read (confirmed
			// live: Firefox's own "unresponsive script" warning fired mid
			// this exact call chain, paused inside the sort's comparator).
			// The loop below used to do that full read-sort-dedupe-write
			// cycle once PER ENVELOPE in the batch, for lists that can hold
			// thousands of ids -- O(n * L log L) for no reason, since an
			// envelope only needs the list to already reflect whatever
			// came before it in the SAME batch, not to be fully sorted,
			// deduplicated, and pushed through Vue's reactivity on every
			// single step. Instead, accumulate each touched list as a
			// plain (non-reactive) working array across the whole batch,
			// and only sort + dedupe + Vue.set it once per list actually
			// touched, after the loop.
			// mailbox -> { ids, indexByThreadKey }. indexByThreadKey lets
			// appendOrReplaceEnvelopeId() below look up "does this batch's
			// working list already have an entry for this thread" in O(1)
			// instead of an O(L) findIndex scan per envelope -- built once
			// per mailbox touched in this batch, from a single pass over
			// its starting ids, then kept in sync incrementally as the
			// batch's own envelopes are appended/replaced.
			const workingLists = new Map()
			const threadKeyFor = (id) => this.envelopes[id].threadRootId ?? `id:${id}`
			const workingListFor = (targetMailbox) => {
				if (!workingLists.has(targetMailbox)) {
					const ids = dropStaleIds(targetMailbox.envelopeLists[listId] || [], targetMailbox.databaseId)
					const indexByThreadKey = new Map()
					ids.forEach((id, index) => indexByThreadKey.set(threadKeyFor(id), index))
					workingLists.set(targetMailbox, { ids, indexByThreadKey })
				}
				return workingLists.get(targetMailbox)
			}

			envelopes.forEach((envelope) => {
				const mailbox = this.mailboxes[envelope.mailboxId]

				// A stale sync response -- generated from server state
				// captured before this app's own delete/archive/junk
				// actually propagated -- must not resurrect an envelope
				// this client just deliberately removed from this exact
				// mailbox. Skipping the whole envelope here (not just its
				// list membership) means it's neither re-created in
				// this.envelopes nor re-added to any of this mailbox's
				// lists (including the unified fan-out below, nested in
				// the same iteration). See removeEnvelopeMutation()'s own
				// 'removedFromMailbox' bookkeeping.
				if (bypassRemovalSuppression) {
					// The removal itself is being undone -- clear the
					// marker outright, not just ignore it this once, so a
					// later, genuinely stale sync response doesn't keep
					// suppressing an envelope that's legitimately back.
					recentLocalChanges.get(envelope.databaseId)?.delete('removedFromMailbox')
				} else if (isRecentlyRemovedFromMailbox(envelope.databaseId, mailbox.databaseId)) {
					return
				}

				this.normalizeTags(envelope)
				const previouslyKnown = this.envelopes[envelope.databaseId]
				const nextFlags = withRecentFlagOverrides(envelope.databaseId, envelope.flags)
				const nextTags = withRecentTagOverrides(envelope.databaseId, envelope.tags)
				Vue.set(this.envelopes, envelope.databaseId, { ...previouslyKnown || {}, ...envelope, flags: nextFlags, tags: nextTags })
				Vue.set(envelope, 'accountId', mailbox.accountId)
				this.appendOrReplaceEnvelopeId(workingListFor(mailbox), envelope)
				if (addToUnifiedMailboxes) {
					const unifiedAccount = this.accountsUnmapped[UNIFIED_ACCOUNT_ID]
					unifiedAccount.mailboxes
						.map((mbId) => this.mailboxes[mbId])
						.filter((mb) => mb.specialRole && mb.specialRole === mailbox.specialRole)
						.forEach((unifiedMailbox) => {
							// Unchanged from before: a blind push, deduped
							// only by exact id via uniq() below -- not
							// routed through appendOrReplaceEnvelopeId()'s
							// thread-dedup logic, same as prior to this
							// Map-based rewrite.
							workingListFor(unifiedMailbox).ids.push(envelope.databaseId)
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
				//
				// Skipped entirely for an already-known envelope whose
				// flags are unchanged from what's already stored --
				// SyncService.php still reports every known message as
				// "changed" on every sync (no real changed-set computation
				// upstream), so without this guard every routine,
				// unrelated resync re-evaluates every loaded
				// flag-predicate bucket for every envelope on every tick,
				// even when nothing about it changed at all. Mirrors
				// updateEnvelopeMutation()'s own isEqual guard below, for
				// the identical reason. A brand-new envelope
				// (previouslyKnown undefined) always still needs
				// classifying for the first time.
				if (previouslyKnown === undefined || !isEqual(previouslyKnown.flags, nextFlags)) {
					this.reclassifyFlagBucketsMutation({ envelope, sourceMailbox: mailbox, includeUnified: addToUnifiedMailboxes, excludeListId: listId })
				}
			})

			workingLists.forEach((working, targetMailbox) => {
				Vue.set(targetMailbox.envelopeLists, listId, uniq(orderByDateInt(working.ids)))
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
		//
		// Every loaded list key is checked, not just the four bare forms
		// (is:starred/not:starred/is:pi-important/is:pi-other) -- "sort
		// favorites separately" makes MailboxThread.vue load COMPOUND keys
		// instead, e.g. "not:starred is:pi-other" (see its
		// appendToSearch()/created()): confirmed live, new mail landed in
		// the bare is:pi-other list correctly, but the priority inbox
		// (which was actually displaying the compound-keyed list) never
		// saw it until a full page reload re-fetched under that exact
		// compound key. A list is only reclassified if EVERY one of its
		// space-separated tokens is something this store can verify
		// locally from the envelope's own flags; a list mixing in a token
		// it can't evaluate locally (subject:/body:/from:/etc.) is left
		// alone, since silently guessing at an arbitrary search predicate
		// would be worse than leaving it stale until its own real query.
		reclassifyFlagBucketsMutation({ envelope, sourceMailbox, includeUnified = true, excludeListId = null }) {
			const knownTokenPredicates = {
				'is:starred': (flags) => flags?.flagged === true,
				'not:starred': (flags) => flags?.flagged !== true,
				[priorityImportantQuery]: (flags) => flags?.important === true,
				[priorityOtherQuery]: (flags) => flags?.important !== true,
			}
			const inboxOnlyTokens = new Set([priorityImportantQuery, priorityOtherQuery])
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
				for (const listId of Object.keys(mailbox.envelopeLists)) {
					if (listId === '' || listId === excludeListId) {
						continue
					}
					const tokens = listId.split(' ').filter(Boolean)
					if (!tokens.every((token) => token in knownTokenPredicates)) {
						continue
					}
					if (tokens.some((token) => inboxOnlyTokens.has(token)) && sourceMailbox.specialRole !== 'inbox') {
						continue
					}
					const list = mailbox.envelopeLists[listId]
					const withoutSelf = list.filter((id) => id !== envelope.databaseId && this.envelopes[id] !== undefined)
					const isThreaded = this.getPreference('layout-message-view', 'threaded') === 'threaded'
					const shouldContain = isThreaded
						? this.threadStillMatchesFlagPredicate({
								envelope,
								tokens,
								knownTokenPredicates,
								alreadyListed: list.includes(envelope.databaseId),
							})
						: tokens.every((token) => knownTokenPredicates[token](envelope.flags))

					Vue.set(
						mailbox.envelopeLists,
						listId,
						shouldContain ? uniq(orderByDateInt(withoutSelf.concat([envelope.databaseId]))) : withoutSelf,
					)
				}
			}
		},
		/**
		 * Whether an already-listed THREAD should stay in a flag-predicate
		 * bucket, given a fresh reading of one of its member envelopes.
		 * Threaded view only -- see reclassifyFlagBucketsMutation(), which
		 * uses the plain per-message predicate directly in flat/singleton
		 * view, where there's no thread-sibling ambiguity at all.
		 *
		 * `envelope`'s own flags can only ever PROVE the thread belongs in
		 * the bucket (if it matches, the thread does too, via itself --
		 * safe to trust in either direction, ADD or REMOVE, since nothing
		 * else is needed). They can never PROVE it doesn't: some other
		 * message sharing the same thread might still match even when this
		 * one doesn't, mirroring the server's own EXISTS-based thread match
		 * (findIdsByQuery() in MessageMapper.php) -- one row in the whole
		 * thread satisfying the predicate is enough for the whole thread to
		 * qualify. Confirmed live: a thread whose newest reply lost its
		 * star, with an older message in the same thread still starred,
		 * got evicted from Favorites on every routine resync of that
		 * reply, then reappeared only once Favorites' own dedicated,
		 * thread-aware query re-ran -- a visible flicker every tick.
		 *
		 * Two cases let this be resolved locally, with full certainty, in
		 * either direction, at no network cost:
		 *  - No thread grouping at all (`threadRootId` unset): the server
		 *    query's own EXISTS clause only matches a row against itself in
		 *    this case too (`tm.thread_root_id = m.thread_root_id` can
		 *    never be true when both sides are NULL) -- so this envelope's
		 *    own flags are already the complete, authoritative answer.
		 *  - The thread's full member list is already loaded locally
		 *    (`envelope.thread`, populated by actually opening the thread
		 *    via fetchThread()) AND every one of those ids is still known
		 *    -- then the true membership can be computed directly, for
		 *    free, from whichever member (if any) matches.
		 * Deliberately reads `envelope.thread` rather than scanning every
		 * envelope in the store for a matching threadRootId: this runs
		 * once per envelope per sync tick, so an O(store size) scan here
		 * would undercut the whole point of avoiding unnecessary load.
		 *
		 * Otherwise -- this envelope doesn't match, and the local
		 * knowledge isn't complete enough to rule out every other member
		 * -- an already-listed thread is left exactly as it is; only the
		 * bucket's own thread-aware server sync may remove it.
		 *
		 * @param root0
		 * @param root0.envelope
		 * @param root0.tokens
		 * @param root0.knownTokenPredicates
		 * @param root0.alreadyListed
		 */
		threadStillMatchesFlagPredicate({ envelope, tokens, knownTokenPredicates, alreadyListed }) {
			const matchesTokens = (flags) => tokens.every((token) => knownTokenPredicates[token](flags))

			if (!envelope.threadRootId) {
				return matchesTokens(envelope.flags)
			}
			if (matchesTokens(envelope.flags)) {
				return true
			}

			const fullThreadIds = envelope.thread
			if (Array.isArray(fullThreadIds) && fullThreadIds.length > 0
				&& fullThreadIds.every((id) => this.envelopes[id] !== undefined)) {
				return fullThreadIds.some((id) => matchesTokens(this.envelopes[id].flags))
			}

			return alreadyListed
		},
		/**
		 * After a user's OWN explicit flag/importance toggle
		 * (toggleEnvelopeFlagged()/setEnvelopeImportant(), below), the
		 * optimistic local update (flagEnvelopeMutation()) only ever
		 * touches envelope.flags itself -- it never touches
		 * mailbox.envelopeLists at all. Bucket membership only ever
		 * catches up via reclassifyFlagBucketsMutation(), which is
		 * deliberately conservative about REMOVALS in threaded view (see
		 * threadStillMatchesFlagPredicate()): correct, but it means a
		 * toggle that should genuinely evict a thread from an
		 * already-loaded bucket (e.g. unstarring a thread's only starred
		 * message) would otherwise sit wrong until that bucket's own next
		 * periodic sync, tens of seconds later.
		 *
		 * Since this only ever runs for a real, comparatively rare user
		 * click -- never for routine background polling, which is what
		 * actually needs to stay cheap -- a small, immediate, targeted
		 * resync of just the loaded buckets this one flag change could
		 * possibly affect is worth its cost: correct feedback within
		 * roughly one request round trip instead of a multi-second wait,
		 * without adding anything to the steady-state polling cadence.
		 * Shared by both toggleEnvelopeFlagged() (starring) and
		 * setEnvelopeImportant() (importance) rather than duplicated, so
		 * any future flag-predicate bucket gets this for free from
		 * whichever of the two toggles is relevant to it.
		 *
		 * @param envelope
		 */
		refreshFlagPredicateBucketsForEnvelope(envelope) {
			const sourceMailbox = this.mailboxes[envelope.mailboxId]
			if (!sourceMailbox) {
				return Promise.resolve()
			}

			const targetMailboxes = [sourceMailbox]
			const unifiedAccount = this.accountsUnmapped[UNIFIED_ACCOUNT_ID]
			if (unifiedAccount) {
				unifiedAccount.mailboxes
					.map((mbId) => this.mailboxes[mbId])
					.filter((mb) => mb.specialRole && mb.specialRole === sourceMailbox.specialRole)
					.forEach((mb) => targetMailboxes.push(mb))
			}

			const flagPredicateTokens = new Set(['is:starred', 'not:starred', priorityImportantQuery, priorityOtherQuery])
			const refreshes = []
			for (const mailbox of targetMailboxes) {
				for (const listId of Object.keys(mailbox.envelopeLists)) {
					const tokens = listId.split(' ').filter(Boolean)
					if (tokens.length > 0 && tokens.every((token) => flagPredicateTokens.has(token))) {
						refreshes.push(this.syncEnvelopes({ mailboxId: mailbox.databaseId, query: listId }))
					}
				}
			}
			return Promise.all(refreshes).catch((error) => {
				logger.error('Could not refresh flag-predicate buckets after a flag toggle', { error })
			})
		},
		updateEnvelopeMutation({ envelope }) {
			const existing = this.envelopes[envelope.databaseId]
			if (!existing) {
				return
			}
			this.normalizeTags(envelope)

			const flags = withRecentFlagOverrides(envelope.databaseId, envelope.flags)
			const tags = withRecentTagOverrides(envelope.databaseId, envelope.tags)

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
			if (!isEqual(existing.tags, tags)) {
				Vue.set(existing, 'tags', tags)
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
			recordRecentLocalChange(envelope.databaseId, flag, value)
		},
		/**
		 * hasUnseenInThread is a thread-WIDE property (see Envelope.vue's
		 * own isThreadUnread computed and Message::jsonSerialize()
		 * server-side, which is where this value actually comes from) --
		 * not a per-message one. Setting it only on the specific envelope
		 * that was just toggled leaves every OTHER locally-known envelope
		 * sharing the same thread with a stale value -- most importantly
		 * whichever one a given list actually renders as that thread's
		 * representative row, which is very often NOT the one just
		 * toggled (e.g. Thread.vue auto-expanding and marking an older,
		 * still-unread reply, while every list shows the thread's newest
		 * message). Confirmed live: opening a thread correctly marked its
		 * oldest unread reply as read on the server (and correctly moved
		 * on to the next-oldest unread reply on the following open,
		 * eventually reaching a fully-read thread), but the thread kept
		 * showing as unread in every list throughout, because the
		 * corrected hasUnseenInThread value from the server was only ever
		 * applied to whichever reply had just been toggled -- never to
		 * the newest sibling every list actually reads from.
		 */
		setHasUnseenInThreadForThreadMutation(envelope, value) {
			if (!envelope.threadRootId) {
				this.flagEnvelopeMutation({ envelope, flag: 'hasUnseenInThread', value })
				return
			}
			this.getEnvelopesByThreadRootId(envelope.accountId, envelope.threadRootId)
				.forEach((sibling) => {
					this.flagEnvelopeMutation({ envelope: sibling, flag: 'hasUnseenInThread', value })
				})
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
			const nextTags = uniq([...envelope.tags, tagId])
			Vue.set(envelope, 'tags', nextTags)
			recordRecentLocalChange(envelope.databaseId, 'tags', nextTags)
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
			const nextTags = envelope.tags.filter((id) => id !== tagId)
			Vue.set(envelope, 'tags', nextTags)
			recordRecentLocalChange(envelope.databaseId, 'tags', nextTags)
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

			// Genuinely leaving the mailbox (delete/archive-move/junk-move,
			// every caller reaching this branch) -- protect against a
			// stale, already-in-flight sync response (generated before
			// this removal itself propagated) resurrecting it back into
			// this same mailbox. See isRecentlyRemovedFromMailbox().
			recordRecentLocalChange(id, 'removedFromMailbox', mailbox.databaseId)

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
				// A thread gets refetched repeatedly -- hover/viewport
				// prefetch, and a periodic refresh of whichever thread is
				// currently open -- confirmed live as often as every
				// 15-30s. Unconditionally rebuilding every one of its
				// messages into a brand new object reference, even when
				// nothing in it actually changed, made every reactive
				// consumer of this.envelopes (e.g. the Favorites column,
				// built from envelopeLists['is:starred'].map(id =>
				// this.envelopes[id])) see a "changed" dependency and
				// re-render on every single refetch -- confirmed live as
				// a fluctuating Favorites list with byte-identical flags
				// underneath (see nextcloud-mail-oauth-integration.md).
				// Same fix as updateEnvelopeMutation(): skip the rebuild,
				// and keep the existing object identity, when the merged
				// result wouldn't actually change anything.
				if (!isEqual(existing, merged)) {
					Vue.set(this.envelopes, e.databaseId, merged)
				}
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
		// Shared, store-level undo-hide bookkeeping -- see
		// pendingRemovals' own comment in mainStore.js for why this
		// replaced UndoableActionMixin.js's old component-local
		// data(). Every simultaneously-rendered list/pane consults
		// the same ids here, so hiding one in response to a delete/
		// archive/junk/move/snooze click hides it everywhere at
		// once, not just in the list the click happened in.
		beginPendingRemoval(ids) {
			ids.forEach((id) => Vue.set(this.pendingRemovals, id, true))
		},
		endPendingRemoval(ids) {
			ids.forEach((id) => Vue.delete(this.pendingRemovals, id))
		},
		isPendingRemoval(id) {
			return !!this.pendingRemovals[id]
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
