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
import { probeMailHealth } from './service/MailHealthService.js'
import { replayQueuedMutations } from './service/MessageService.js'
import { subscribePendingMutations } from './service/MutationOutbox.js'
import {
	broadcastMailEvent,
	onMailBroadcast,
	releaseCrossTabLeadership,
	requestCoordinator,
	runCrossTabExclusive,
	runCrossTabLeader,
	WorkClass,
} from './service/RequestCoordinator.js'
import { PRIORITY_INBOX_ID } from './store/constants.js'
import useMainStore from './store/mainStore.js'

const WATCHED_MAILBOX_LEASE_MS = 45_000
const CROSS_TAB_REVALIDATION_COOLDOWN_MS = 60_000

export function shouldRetryConnectivityRecovery(error, online = navigator.onLine !== false) {
	const status = error?.response?.status
	return online && !(
		status >= 400
		&& status < 500
		&& ![408, 409, 425, 429].includes(status)
	)
}

export function connectivityRecoveryDelay(error, attempt, minimumDelay = 0, random = Math.random(), now = Date.now()) {
	const retryAfter = error?.response?.headers?.['retry-after']
	const retryAfterSeconds = Number.parseInt(retryAfter, 10)
	const retryAfterDate = Date.parse(retryAfter)
	const serverDelay = Number.isFinite(retryAfterSeconds)
		? retryAfterSeconds * 1_000
		: (Number.isFinite(retryAfterDate) ? Math.max(retryAfterDate - now, 0) : 0)
	const exponentialCap = Math.min(1_000 * (2 ** attempt), 60_000)
	// Equal jitter prevents every returning tab/device retrying on the same
	// boundary while guaranteeing some minimum recovery pace.
	const jitteredDelay = (exponentialCap / 2) + (random * exponentialCap / 2)
	return Math.max(minimumDelay, serverDelay, jitteredDelay)
}

export default {
	name: 'App',

	computed: {
		...mapStores(useMainStore),
		...mapState(useMainStore, [
			'isExpiredSession',
			'networkState',
			'pendingMutationCount',
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
		this.connectivityRecoveryAttempt = 0
		this.unsubscribeRequestCoordinator = requestCoordinator.subscribe(({ networkState, activeUserRequests }) => {
			this.mainStore.setNetworkStateMutation(networkState)
			this.mainStore.setActiveUserRequestCountMutation(activeUserRequests)
			this.renderNetworkStatus()
			if (
				networkState === 'degraded'
				&& navigator.onLine !== false
				&& this.connectivityRecoveryPromise === undefined
				&& this.connectivityRecoveryTimeout === undefined
			) {
				this.scheduleConnectivityRecovery()
			}
		})
		this.unsubscribePendingMutations = subscribePendingMutations((count) => {
			this.mainStore.setPendingMutationCountMutation(count)
			this.renderNetworkStatus()
			if (
				count > 0
				&& navigator.onLine !== false
				&& this.networkState !== 'recovering'
				&& this.connectivityRecoveryTimeout === undefined
			) {
				this.scheduleConnectivityRecovery(undefined, 1_000)
			}
		})
		this.unsubscribeMailBroadcast = onMailBroadcast(this.onMailBroadcast)
		window.addEventListener('online', this.onNetworkOnline)
		// Redirect to setup page if no accounts are configured
		if (!this.hasMailAccounts) {
			this.$router.replace({
				name: 'setup',
			})
		}

		this.startWatchedMailboxSync()
		if (this.hasMailAccounts) {
			// Prime the Priority Inbox navigation badge even when another
			// folder is the start view. This is one local-DB aggregate, not a
			// mailbox/IMAP fan-out, and shares the same snapshot with the
			// sticky overview when Priority Inbox is opened later.
			this.mainStore.refreshPriorityInboxStats(WorkClass.VISIBLE_REVALIDATION).catch(() => {})
		}
		await this.mainStore.fetchCurrentUserPrincipal()
		await this.mainStore.loadCollections()
		this.mainStore.hasCurrentUserPrincipalAndCollectionsMutation(true)
		if (navigator.onLine !== false) {
			this.recoverConnectivity()
		}
	},

	beforeDestroy() {
		clearTimeout(this.watchedMailboxSyncTimeout)
		clearTimeout(this.connectivityRecoveryTimeout)
		window.removeEventListener('mousemove', this.onUserActivity)
		window.removeEventListener('keydown', this.onUserActivity)
		window.removeEventListener('touchstart', this.onUserActivity)
		document.removeEventListener('visibilitychange', this.onVisibilityChange)
		window.removeEventListener('online', this.onNetworkOnline)
		window.removeEventListener('focus', this.onWindowFocus)
		window.removeEventListener('blur', this.onWindowBlur)
		releaseCrossTabLeadership('watched-mailboxes')
		this.unsubscribeRequestCoordinator?.()
		this.unsubscribePendingMutations?.()
		this.unsubscribeMailBroadcast?.()
		this.networkStatusElement?.remove()
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
				runCrossTabLeader('watched-mailboxes', () => {
					return this.mainStore.syncWatchedMailboxes({ lightweight })
						.then((result) => {
							broadcastMailEvent({
								type: 'watched-sync-complete',
								at: Date.now(),
							})
							return result
						})
				}, { leaseMs: WATCHED_MAILBOX_LEASE_MS })
					.then(({ leader }) => {
						if (leader) {
							logger.debug(`Watched mailboxes sync'ed by this tab's background leader (${lightweight ? 'lightweight' : 'full'} tick)`)
						}
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
			const rescheduleTickNormally = () => {
				clearTimeout(this.watchedMailboxSyncTimeout)
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
					if (
						wasIdle
						&& this.networkState === 'healthy'
						&& this.connectivityRecoveryPromise === undefined
						&& Date.now() - (this.lastLongResumeAt ?? 0) >= 10_000
					) {
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
					const returnedAfterLongAbsence = this.hiddenAt !== undefined
						&& Date.now() - this.hiddenAt >= 60_000
					if (returnedAfterLongAbsence) {
						this.lastLongResumeAt = Date.now()
					}
					this.hiddenAt = undefined
					this.lastActivity = Date.now()
					this.mainStore.resetNotificationEngagementMutation()
					if (this.networkState === 'healthy' && !returnedAfterLongAbsence) {
						// Full tick right away: list, badges and the open
						// thread must be consistent the moment the user looks.
						this.rescheduleTickNow(tick)
					} else {
						// A long-thawed tab gets one ordered active-view
						// recovery. Do not immediately follow it with a full
						// watched-mailbox fan-out; the normal jittered timer
						// will reconcile background mailboxes afterwards.
						this.recoverConnectivity().finally(rescheduleTickNormally)
					}
				} else {
					this.hiddenAt = Date.now()
					releaseCrossTabLeadership('watched-mailboxes')
				}
			}
			this.onWindowFocus = () => {
				this.lastActivity = Date.now()
				this.mainStore.resetNotificationEngagementMutation()
				const returnedAfterLongAbsence = this.hiddenAt !== undefined
					&& Date.now() - this.hiddenAt >= 60_000
				const followsLongResume = Date.now() - (this.lastLongResumeAt ?? 0) < 10_000
				if (returnedAfterLongAbsence) {
					this.lastLongResumeAt = Date.now()
				}
				if (followsLongResume) {
					// Firefox Android commonly emits focus immediately after
					// visibilitychange. The visibility handler already owns
					// this resume transaction; only preserve the normal timer.
					rescheduleTickNormally()
				} else if (this.networkState === 'healthy' && !returnedAfterLongAbsence) {
					this.rescheduleTickNow(tick)
				} else {
					// Firefox Android may deliver focus and visibilitychange
					// back-to-back after thawing a tab. Do not let focus start
					// the background sync burst in parallel with the ordered
					// health/outbox/visible-view recovery transaction.
					this.recoverConnectivity().finally(rescheduleTickNormally)
				}
			}
			this.onWindowBlur = () => {
				releaseCrossTabLeadership('watched-mailboxes')
			}
			window.addEventListener('mousemove', this.onUserActivity, { passive: true })
			window.addEventListener('keydown', this.onUserActivity, { passive: true })
			window.addEventListener('touchstart', this.onUserActivity, { passive: true })
			document.addEventListener('visibilitychange', this.onVisibilityChange)
			window.addEventListener('focus', this.onWindowFocus)
			window.addEventListener('blur', this.onWindowBlur)
		},

		rescheduleTickNow(tick) {
			clearTimeout(this.watchedMailboxSyncTimeout)
			this.watchedMailboxSyncTimeout = setTimeout(tick, 0)
		},

		onNetworkOnline() {
			// `online` is only a hint. The state becomes healthy only after
			// the authenticated, IMAP-free Mail probe succeeds.
			this.connectivityRecoveryAttempt = 0
			this.recoverConnectivity()
		},

		async recoverConnectivity() {
			if (this.connectivityRecoveryPromise !== undefined) {
				return this.connectivityRecoveryPromise
			}
			clearTimeout(this.connectivityRecoveryTimeout)
			this.connectivityRecoveryTimeout = undefined
			requestCoordinator.setNetworkState('recovering')
			this.connectivityRecoveryPromise = (async () => {
				await probeMailHealth()
				// The authenticated, IMAP-free probe is the connectivity
				// authority. Re-open foreground traffic immediately; the
				// bounded reconciliation below may still encounter mailbox
				// capacity backpressure, which is not a network outage.
				requestCoordinator.setNetworkState('healthy')
				this.connectivityRecoveryAttempt = 0

				await runCrossTabExclusive(
					'mutation-outbox',
					() => replayQueuedMutations(),
					true,
				)

				const mailboxId = this.mainStore.currentViewMailboxId
				const priorityInboxIsActive = mailboxId === PRIORITY_INBOX_ID
				if (priorityInboxIsActive) {
					await this.mainStore.refreshPriorityInboxView({
						workClass: WorkClass.VISIBLE_REVALIDATION,
						syncSources: true,
					}).catch((error) => {
						logger.debug('Exact Priority Inbox revalidation deferred after connectivity recovery', { error })
					})
				} else if (mailboxId !== undefined && this.mainStore.getMailbox(mailboxId)) {
					await this.mainStore.syncEnvelopes({
						mailboxId,
						workClass: WorkClass.VISIBLE_REVALIDATION,
						// Resume recovery runs alongside the visibility tick
						// and, on Firefox Android, a focus event moments
						// later; one shared round trip is enough for all of
						// them.
						coalesceRecent: true,
					}).catch((error) => {
						logger.debug('Active view revalidation deferred after connectivity recovery', { error })
					})
				}
				if (this.hasMailAccounts && !priorityInboxIsActive) {
					await this.mainStore.refreshPriorityInboxStats(WorkClass.VISIBLE_REVALIDATION).catch((error) => {
						logger.debug('Priority Inbox counter revalidation failed during connectivity recovery', { error })
					})
				}
				broadcastMailEvent({
					type: 'connectivity-recovered',
					at: Date.now(),
				})
			})().catch((error) => {
				requestCoordinator.reportFailure(error)
				logger.info('Mail connectivity recovery is still pending', { error })
				this.scheduleConnectivityRecovery(error)
			}).finally(() => {
				this.connectivityRecoveryPromise = undefined
			})
			return this.connectivityRecoveryPromise
		},

		scheduleConnectivityRecovery(error, minimumDelay = 0) {
			clearTimeout(this.connectivityRecoveryTimeout)
			this.connectivityRecoveryTimeout = undefined
			if (!shouldRetryConnectivityRecovery(error)) {
				return
			}

			const delay = connectivityRecoveryDelay(
				error,
				this.connectivityRecoveryAttempt,
				minimumDelay,
			)
			this.connectivityRecoveryAttempt++
			this.connectivityRecoveryTimeout = setTimeout(() => {
				this.connectivityRecoveryTimeout = undefined
				this.recoverConnectivity()
			}, delay)
		},

		onMailBroadcast(event) {
			if (
				event?.type !== 'watched-sync-complete'
				|| document.visibilityState !== 'visible'
				|| (typeof document.hasFocus === 'function' && !document.hasFocus())
				|| this.mainStore.isInteractionPriorityActive()
				|| Date.now() - (this.lastCrossTabRevalidationAt ?? 0) < CROSS_TAB_REVALIDATION_COOLDOWN_MS
			) {
				return
			}
			const mailboxId = this.mainStore.currentViewMailboxId
			if (mailboxId === undefined || !this.mainStore.getMailbox(mailboxId)) {
				return
			}
			this.lastCrossTabRevalidationAt = Date.now()
			// The other tab already paid for IMAP. This active-view diff rides
			// the server freshness gate and updates this tab's independent store.
			if (mailboxId === PRIORITY_INBOX_ID) {
				this.mainStore.refreshPriorityInboxView({
					workClass: WorkClass.VISIBLE_REVALIDATION,
					syncSources: false,
				}).catch((error) => {
					logger.debug('Cross-tab exact Priority Inbox revalidation failed', { error })
				})
				return
			}
			this.mainStore.syncEnvelopes({
				mailboxId,
				workClass: WorkClass.VISIBLE_REVALIDATION,
				coalesceRecent: true,
			}).catch((error) => {
				logger.debug('Cross-tab active view revalidation failed', { error })
			})
		},

		renderNetworkStatus() {
			const shouldShow = this.networkState !== 'healthy' || this.pendingMutationCount > 0
			if (!shouldShow) {
				this.networkStatusElement?.remove()
				this.networkStatusElement = undefined
				return
			}
			if (this.networkStatusElement === undefined) {
				this.networkStatusElement = document.createElement('div')
				this.networkStatusElement.className = 'mail-network-status'
				this.networkStatusElement.setAttribute('role', 'status')
				this.networkStatusElement.setAttribute('aria-live', 'polite')
				document.body.appendChild(this.networkStatusElement)
			}
			const stateMessage = {
				offline: t('mail', 'You are offline. Mail changes will be sent when the connection returns.'),
				degraded: t('mail', 'The connection is unstable. Mail actions will retry automatically.'),
				recovering: t('mail', 'Connection restored. Finishing pending mail changes…'),
				healthy: '',
			}[this.networkState]
			const pending = this.pendingMutationCount > 0
				? t('mail', 'Pending mail changes: {count}', { count: this.pendingMutationCount })
				: ''
			this.networkStatusElement.textContent = [stateMessage, pending].filter(Boolean).join(' ')
		},
	},
}
</script>

<style lang="scss">
.mail-network-status {
	position: fixed;
	z-index: 2000;
	inset-inline-end: calc(2 * var(--default-grid-baseline));
	bottom: calc(2 * var(--default-grid-baseline));
	max-width: calc(80 * var(--default-grid-baseline));
	padding: calc(2 * var(--default-grid-baseline));
	border: 1px solid var(--color-border);
	border-radius: var(--border-radius-large);
	background: var(--color-main-background);
	box-shadow: 0 0 calc(2 * var(--default-grid-baseline)) var(--color-box-shadow);
	color: var(--color-main-text);
}
</style>
