<!--
  - SPDX-FileCopyrightText: 2018 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<router-view />
</template>

<script>
import { showError } from '@nextcloud/dialogs'
import { translate as t } from '@nextcloud/l10n'
import { mapState, mapStores } from 'pinia'
import MailboxLockedError from './errors/MailboxLockedError.js'
import { matchError } from './errors/match.js'
import initAfterAppCreation from './init.js'
import logger from './logger.js'
import useMainStore from './store/mainStore.js'

export default {
	name: 'App',

	computed: {
		...mapStores(useMainStore),
		...mapState(useMainStore, [
			'isExpiredSession',
		]),

		hasMailAccounts() {
			return !!this.mainStore.getAccounts.find((account) => !account.isUnified)
		},
	},

	watch: {
		isExpiredSession(expired) {
			if (expired) {
				showError(t('mail', 'Your session has expired. The page will be reloaded.'), {
					onRemove: () => {
						this.reload()
					},
				})
			}
		},
	},

	async mounted() {
		initAfterAppCreation()
		// Redirect to setup page if no accounts are configured
		if (!this.hasMailAccounts) {
			this.$router.replace({
				name: 'setup',
			})
		}

		this.startWatchedMailboxSync()
		await this.mainStore.fetchCurrentUserPrincipal()
		await this.mainStore.loadCollections()
		this.mainStore.hasCurrentUserPrincipalAndCollectionsMutation(true)
	},

	beforeDestroy() {
		clearTimeout(this.watchedMailboxSyncTimeout)
		window.removeEventListener('mousemove', this.onUserActivity)
		window.removeEventListener('keydown', this.onUserActivity)
		window.removeEventListener('touchstart', this.onUserActivity)
		document.removeEventListener('visibilitychange', this.onVisibilityChange)
	},

	methods: {
		reload() {
			window.location.reload()
		},

		startWatchedMailboxSync() {
			// A recursive, jittered setTimeout, not a fixed setInterval:
			// pendingLockWaits/isMailboxSyncRetryPending only coordinate
			// calls within ONE tab's own JS runtime -- they know nothing
			// about a second (or third) browser window doing the exact same
			// thing. Every open window now watches the same mailboxes (not
			// just whatever that particular window has open), so a fixed,
			// unjittered 10s period meant every window's poller landed on
			// the same wall-clock cadence -- confirmed live: mailbox 31
			// showed a clean, repeating ~90s burst-then-silence pattern in
			// nginx logs (several near-simultaneous requests, one winning
			// the lock, the rest 409ing and backing off together), instead
			// of the occasional, self-resolving collision this architecture
			// is supposed to reduce to. Redrawing the delay each tick (not
			// just once at startup) means no two windows stay in lockstep
			// for long, however many happen to be open.
			//
			// Widened from 10-15s to 20-30s: the freshness gate
			// (SyncService::SYNC_FRESHNESS_WINDOW) makes a second poller's
			// tick cheap only while it lands inside the FIRST poller's
			// still-fresh window -- with two independently-jittered pollers
			// (e.g. a desktop tab plus a phone, confirmed live: opening a
			// second device roughly doubled the real (non-gated) sync rate
			// for the same watched mailboxes, visibly loading a
			// resource-constrained host -- Postgres at 177% CPU, app
			// container at 117%, sustained swap use). Doubling the tick
			// period roughly halves the steady-state real-sync rate
			// regardless of how many devices are open, at the cost of
			// somewhat less immediate freshness for genuinely new mail.
			//
			// Still not a recursive setTimeout-after-completion: the next
			// tick is scheduled immediately, not gated on this tick's sync
			// call resolving, so one genuinely slow/locked mailbox can't
			// delay re-syncing every other watched mailbox either (see
			// isMailboxSyncRetryPending() for the per-mailbox side of that).
			//
			// Adaptive backpressure: this.mainStore.serverBusy reflects the
			// serverBusy field riding the MOST RECENT sync response, from
			// ANY caller (see SyncService::isServerBusy(),
			// setServerBusyMutation()) -- not a separate request. When the
			// mail pool reports itself busy, the NEXT tick doubles its
			// delay range instead of the normal one, on top of whatever
			// widening every other simultaneously-open window/device is
			// also independently applying right now. This only paces the
			// automatic background poller; user-initiated syncs (a manual
			// refresh, opening a folder) are never slowed by this.
			// Visibility- and attention-aware cadence (standard practice:
			// MDN names "stop polling dashboards while hidden" as THE Page
			// Visibility API use case; Chromium already force-throttles
			// chained timers of hidden tabs to ~1/min, Firefox does not --
			// measured live before this change: 1599 sync POSTs in 10
			// minutes across the household's open tabs/devices, ~1.6 FPM
			// workers busy with polling alone. Same model as React Query's
			// defaults: no background-interval refetch, revalidate on
			// focus.)
			//
			// Three attention tiers, each with its own delay range, all
			// still widened by the server's own serverBusy backpressure
			// signal (which rides every sync response):
			//  - visible + active input: today's cadence, full sync.
			//  - visible + idle (no input for IDLE_AFTER_MS -- e.g. a tab
			//    on a second monitor): slower, still full sync so the
			//    visible list stays honest.
			//  - hidden: slowest, and LIGHTWEIGHT (one bucket per watched
			//    mailbox, no priority-inbox refresh) -- exactly enough to
			//    pull new messages and fire a complete desktop
			//    notification (sender/subject/preview ride the sync
			//    response) with bounded latency.
			//
			// Engagement decay (documented adaptive-notification practice:
			// declining engagement => lower frequency, engagement =>
			// reset): every notification burst that goes unengaged while
			// hidden multiplies the hidden delay by 1.5x, capped at 4x --
			// if nobody is reacting to notifications, the next one may
			// wait a little longer. ANY engagement (tab shown, window
			// focused, input) resets the decay AND fires an immediate
			// full tick so list/badges/thread are consistent right away.
			const IDLE_AFTER_MS = 5 * 60_000
			const jitter = (base, spread) => base + Math.random() * spread

			this.lastActivity = Date.now()

			const attentionTier = () => {
				if (document.visibilityState === 'hidden') {
					return 'hidden'
				}
				return (Date.now() - this.lastActivity) > IDLE_AFTER_MS ? 'visibleIdle' : 'visibleActive'
			}

			const nextTickDelay = () => {
				const busy = this.mainStore.serverBusy
				switch (attentionTier()) {
					case 'hidden': {
						const decay = Math.min(1.5 ** this.mainStore.unengagedNotificationBursts, 4)
						return busy
							? jitter(180_000, 120_000) * decay
							: jitter(60_000, 60_000) * decay
					}
					case 'visibleIdle':
						return busy
							? jitter(90_000, 60_000)
							: jitter(60_000, 30_000)
					default: // visibleActive -- deliberately unchanged from the
					// pre-tiering cadence, so this change's measured effect
					// is attributable to the hidden/idle tiers alone.
						return busy
							? jitter(40_000, 20_000)
							: jitter(20_000, 10_000)
				}
			}

			const tick = () => {
				const lightweight = attentionTier() === 'hidden'
				this.mainStore.syncWatchedMailboxes({ lightweight })
					.then(() => {
						logger.debug(`Watched mailboxes sync'ed in background (${lightweight ? 'lightweight' : 'full'} tick)`)
					})
					.catch((error) => {
						matchError(error, {
							[MailboxLockedError.name](error) {
								logger.info('Background sync failed because a folder is locked', { error })
							},
							default(error) {
								logger.error('Background sync failed: ' + error.message, { error })
							},
						})
					})
				this.watchedMailboxSyncTimeout = setTimeout(tick, nextTickDelay())
			}
			this.watchedMailboxSyncTimeout = setTimeout(tick, nextTickDelay())

			// Engagement + activation wiring. Throttled: lastActivity only
			// needs minute-ish resolution, no need to touch a reactive-ish
			// field on every mousemove.
			let lastActivityWrite = 0
			this.onUserActivity = () => {
				const now = Date.now()
				if (now - lastActivityWrite > 30_000) {
					lastActivityWrite = now
					const wasIdle = (now - this.lastActivity) > IDLE_AFTER_MS
					this.lastActivity = now
					this.mainStore.resetNotificationEngagementMutation()
					if (wasIdle) {
						// Coming back after a long pause: reconcile now
						// rather than waiting out a slow-tier delay drawn
						// while we were away.
						this.rescheduleTickNow(tick)
					}
				} else {
					this.lastActivity = now
				}
			}
			this.onVisibilityChange = () => {
				if (document.visibilityState === 'visible') {
					this.lastActivity = Date.now()
					this.mainStore.resetNotificationEngagementMutation()
					// Full tick right away: list, badges and the open
					// thread must be consistent the moment the user looks.
					this.rescheduleTickNow(tick)
				}
			}
			window.addEventListener('mousemove', this.onUserActivity, { passive: true })
			window.addEventListener('keydown', this.onUserActivity, { passive: true })
			window.addEventListener('touchstart', this.onUserActivity, { passive: true })
			document.addEventListener('visibilitychange', this.onVisibilityChange)
		},

		rescheduleTickNow(tick) {
			clearTimeout(this.watchedMailboxSyncTimeout)
			this.watchedMailboxSyncTimeout = setTimeout(tick, 0)
		},
	},
}
</script>
