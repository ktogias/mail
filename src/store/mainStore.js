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
			// In-flight fetchEnvelopes() calls per mailbox+query list
			// key -- lets the UI show a loading state for an envelope
			// list that is still empty because its fetch hasn't
			// returned yet (e.g. the priority-inbox sections during a
			// search, which are otherwise hidden entirely).
			envelopeFetchCounts: {},
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
			// The mailbox id of the currently open view ('priority',
			// 'unified' or a real database id as a route-param string),
			// mirrored from the router by MailboxThread -- the store
			// cannot import the router itself (that installs vue-router
			// globally and breaks $route mocking in component tests).
			// Used for view-aware decisions: sync the open mailbox
			// first, keep refreshing an open priority inbox.
			currentViewMailboxId: undefined,
			// The envelope id of the currently open thread/message (the
			// route's own :threadId, mirrored the same way
			// currentViewMailboxId is -- see Thread.vue's own route
			// watcher). Lets store-level logic (the idle-tail-trim cache
			// GC, the open-thread proactive prefetch) know what's
			// genuinely on screen right now without needing to read the
			// router directly.
			currentOpenThreadId: undefined,
			// Which mailbox+query lists currently have a non-empty
			// multi-select active, keyed by `${mailboxId}::${listId}` --
			// reported by EnvelopeList.vue's own watcher on its
			// (still component-local) `selection` array. The idle-tail-
			// trim mutation consults this before evicting a list's tail,
			// so an in-progress bulk selection is never yanked out from
			// under the user mid-action. Deliberately a per-list boolean,
			// not a mirror of the actual selected ids: the trim is "skip
			// the whole list if anything in it is selected" (same
			// simplification the trim mutation's own comment already
			// makes for the tail specifically), not a precise per-id
			// check, so a full migration of `selection` itself into the
			// store was unnecessary.
			listsWithActiveSelection: {},
			// Which list (mailboxId + query) the most recent click into a
			// thread actually came from -- set by Envelope.vue's own
			// onClick(), the only place that unambiguously knows this
			// regardless of which of several simultaneously-rendered
			// lists it belongs to (Priority Inbox's Favorites/Important/
			// Other sections, a Favorites sub-list inside an otherwise-
			// regular folder, the unified inbox's merged view, or a
			// search/filter's results all share the same route, so it
			// can't be reconstructed from route params alone). Read by
			// Thread.vue::prefetchListNeighborhood() -- see
			// mainStore/actions.js.
			lastOpenedFromList: null,
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
