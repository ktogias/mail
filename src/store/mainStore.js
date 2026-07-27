/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { defineStore } from 'pinia'
import {
	FOLLOW_UP_MAILBOX_ID,
	PRIORITY_INBOX_ID,
	UNIFIED_ACCOUNT_ID,
	UNIFIED_INBOX_ID,
} from './constants.js'
import mapStoreActions from './mainStore/actions.js'
import mapStoreGetters from './mainStore/getters.js'

export default defineStore('main', {
	state: () => {
		return {
			syncTimestamp: Date.now(),
			isExpiredSession: false,
			// Timestamp until which a direct user action (opening a
			// message, switching folders, starring/deleting/flagging,
			// ...) takes priority over the background watched-mailbox
			// poller. See setInteractionPriorityMutation().
			interactionPriorityUntil: 0,
			// Queued + running direct-user requests reported by the shared
			// request coordinator. Unlike the short trailing timestamp above,
			// this keeps background sync paused for the request's full lifetime.
			activeUserRequestCount: 0,
			// In-flight fetchEnvelopes() calls per mailbox+query list
			// key -- lets the UI show a loading state for an envelope
			// list that is still empty because its fetch hasn't
			// returned yet (e.g. the priority-inbox sections during a
			// search, which are otherwise hidden entirely).
			envelopeFetchCounts: {},
			// Durable server-side deep-search jobs, grouped by the list that
			// initiated them. Each value is itself keyed by job id because a
			// unified inbox can fan out one coalesced job per physical mailbox.
			// Entries are session-only, scoped by query, and reclaimed on reload.
			deepSearchJobs: {},
			// Ids currently hidden behind an undo toast (delete/
			// archive/junk/move/snooze), shared across every
			// simultaneously-rendered list/pane -- not per-component
			// state. Confirmed live: a message deleted from one
			// Priority Inbox section (say, Important) stayed fully
			// visible in every OTHER section rendering the same
			// message (Favorites, the open Thread reading pane, ...)
			// for the whole ~10s undo window, since each one used to
			// track its own separate copy of "what's pending" via
			// UndoableActionMixin's component-local data(). See
			// beginPendingRemoval()/endPendingRemoval()/
			// isPendingRemoval().
			pendingRemovals: {},
			// Exact Priority Inbox counters come from one local-DB aggregate,
			// independently of how many rows each visible section has loaded.
			// Keep the last successful value on transient failures so an
			// unstable connection does not make the overview flicker away.
			priorityInboxStats: undefined,
			priorityInboxStatsLoading: false,
			priorityInboxStatsError: false,
			// New messages received while a Priority section was outside the
			// viewport. Id-keyed objects de-duplicate repeated sync responses;
			// the section observer clears them only after they become visible.
			priorityInboxNewMessageIds: {
				favorite: {},
				important: {},
				other: {},
			},
			// Contributions hidden during the undo window. The authoritative
			// DB aggregate still contains them until the deferred move/delete
			// runs, so every fresh snapshot reapplies these small optimistic
			// deltas until endPendingRemoval() resolves the outcome.
			priorityInboxPendingRemovalStats: {},
			// The mailbox id of the currently open view ('priority',
			// 'unified' or a real database id as a route-param string),
			// mirrored from the router by MailboxThread -- the store
			// cannot import the router itself (that installs vue-router
			// globally and breaks $route mocking in component tests).
			// Used for view-aware decisions: sync the open mailbox
			// first, keep refreshing an open priority inbox.
			currentViewMailboxId: undefined,
			// The current view's :filter route segment (e.g. 'starred'),
			// mirrored the same way currentViewMailboxId is. Lets an envelope
			// row build its own target route WITHOUT reading $route, so a
			// thread open (which only changes :threadId) doesn't invalidate
			// every row's link() and re-render the whole list (see
			// Envelope.vue::link() and EnvelopeSkeleton.vue).
			currentViewFilter: undefined,
			// The active Priority Inbox search, including its structural
			// not:starred partition. App-level focus recovery has no
			// component ref, so mirror it just like currentViewMailboxId and
			// refresh the exact compound lists currently rendered.
			currentPriorityInboxSearchQuery: undefined,
			// Incremented after an authoritative refresh replaces the
			// currently-rendered Priority section heads. The view uses this
			// to reset query-local pagination exhaustion and re-arm its
			// IntersectionObserver sentinel: neither mailbox/query/sort
			// changes when a same-query refresh publishes a new first page.
			priorityInboxViewRevision: 0,
			// True while refreshPriorityInboxView() is assembling the section
			// pages. The sections cannot infer this themselves: they render
			// Mailbox components with skip-initial-load, so those components
			// never fetch and their own loadingEnvelopes stays false. Without
			// this flag a cold Priority Inbox showed "No messages" under every
			// section header for the whole load -- reported live on
			// 2026-07-27 as "5-6 seconds of nothing, why not a placeholder".
			// A header count is not enough to distinguish the two states: it
			// comes from an independent request and arrives first.
			priorityInboxViewLoading: false,
			// The envelope id of the currently open thread/message (the
			// route's own :threadId, mirrored the same way
			// currentViewMailboxId is -- see Thread.vue's own route
			// watcher). Lets store-level logic (the idle-tail-trim cache
			// GC, the open-thread proactive prefetch) know what's
			// genuinely on screen right now without needing to read the
			// router directly.
			currentOpenThreadId: undefined,
			// Component-local selections mirrored by mailbox+query list and
			// component owner. Grouped mailboxes render several EnvelopeList
			// instances for one key, so one instance must not clear another's
			// selection when it updates or unmounts.
			// The idle-tail trim only needs ids to distinguish a selected
			// head row (safe to keep while dropping the tail) from a selected
			// tail row (must pin the list). EnvelopeList still owns behavior.
			selectedEnvelopeIdsByList: {},
			// Which list (mailboxId + query) the most recent click into a
			// thread actually came from -- set by Envelope.vue's own
			// onClick(), the only place that unambiguously knows this
			// regardless of which of several simultaneously-rendered
			// lists it belongs to (Priority Inbox's Favorites/Important/
			// Other sections, a Favorites sub-list inside an otherwise-
			// regular folder, the unified inbox's merged view, or a
			// search/filter's results all share the same route, so it
			// can't be reconstructed from route params alone). Read by
			// Thread.vue::prefetchListNeighborhood() and Mailbox.vue's
			// own ReturnScrollAnchorMixin -- see mainStore/actions.js.
			lastOpenedFromList: null,
			// Mailbox ids whose "still importing older messages" banner the
			// user has dismissed this session -- see
			// dismissBackfillBannerMutation()/Mailbox.vue. Session-only, never
			// persisted; a plain object keyed by mailbox id.
			backfillBannerDismissed: {},
			preferences: {},
			accountsUnmapped: {
				[UNIFIED_ACCOUNT_ID]: {
					id: UNIFIED_ACCOUNT_ID,
					accountId: UNIFIED_ACCOUNT_ID,
					isUnified: true,
					mailboxes: [PRIORITY_INBOX_ID, UNIFIED_INBOX_ID, FOLLOW_UP_MAILBOX_ID],
					aliases: [],
					collapsed: false,
					emailAddress: '',
					name: '',
					showSubscribedOnly: false,
					signatureAboveQuote: false,
				},
			},
			accountList: [UNIFIED_ACCOUNT_ID],
			allAccountSettings: [],
			mailboxes: {
				[UNIFIED_INBOX_ID]: {
					id: UNIFIED_INBOX_ID,
					databaseId: UNIFIED_INBOX_ID,
					accountId: 0,
					attributes: ['\\subscribed'],
					isUnified: true,
					path: '',
					specialUse: ['inbox'],
					specialRole: 'inbox',
					unread: 0,
					mailboxes: [],
					envelopeLists: {},
					name: 'UNIFIED INBOX',
				},
				[PRIORITY_INBOX_ID]: {
					id: PRIORITY_INBOX_ID,
					databaseId: PRIORITY_INBOX_ID,
					accountId: 0,
					attributes: ['\\subscribed'],
					isPriorityInbox: true,
					path: '',
					specialUse: ['inbox'],
					specialRole: 'inbox',
					unread: 0,
					mailboxes: [],
					envelopeLists: {},
					name: 'PRIORITY INBOX',
				},
				[FOLLOW_UP_MAILBOX_ID]: {
					id: FOLLOW_UP_MAILBOX_ID,
					databaseId: FOLLOW_UP_MAILBOX_ID,
					accountId: 0,
					attributes: ['\\subscribed'],
					isUnified: true,
					path: '',
					specialUse: ['sent'],
					specialRole: 'sent',
					unread: 0,
					mailboxes: [],
					envelopeLists: {},
					name: 'FOLLOW UP REMINDERS',
				},
			},
			envelopes: {},
			messages: {},
			newMessage: undefined,
			showMessageComposer: false,
			composerMessageIsSaved: false,
			composerSessionId: undefined,
			nextComposerSessionId: 1,
			autocompleteEntries: [],
			tags: {},
			tagList: [],
			isScheduledSendingDisabled: false,
			isSnoozeDisabled: false,
			currentUserPrincipal: undefined,
			googleOauthUrl: null,
			masterPasswordEnabled: false,
			sieveScript: {},
			calendars: [],
			smimeCertificates: [],
			hasFetchedInitialEnvelopes: false,
			// Set from the serverBusy field riding every sync response (see
			// SyncService::isServerBusy() and MessageService::syncEnvelopes()).
			// Read only by the watched-mailbox background poller
			// (App.vue::startWatchedMailboxSync()) when scheduling its NEXT
			// tick -- never by user-initiated syncs, which should never be
			// artificially slowed down.
			serverBusy: false,
			// Connectivity is based on authenticated Mail requests, not only
			// navigator.onLine. Pending mutations count the compact,
			// content-free IndexedDB replay journal.
			networkState: 'healthy',
			pendingMutationCount: 0,
			// How many new-mail notification bursts have fired since the
			// user last engaged (tab shown, window focused, any input).
			// Drives the hidden-tab poller's engagement decay: unengaged
			// notifications progressively widen the background tick, any
			// engagement resets it. See startWatchedMailboxSync() in
			// App.vue.
			unengagedNotificationBursts: 0,
			followUpFeatureAvailable: false,
			contextChatFeatureAvailable: false,
			internalAddress: [],
			hasCurrentUserPrincipalAndCollections: false,
			showAccountSettings: null,
			isTranslationEnabled: false,
			translationInputLanguages: [],
			translationOutputLanguages: [],
			textBlocksFetched: false,
			myTextBlocks: [],
			sharedTextBlocks: [],
			quickActions: [],
		}
	},
	getters: {
		...mapStoreGetters(),
	},
	actions: {
		...mapStoreActions(),
	},
})
