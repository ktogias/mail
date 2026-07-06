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
			// Still not a recursive setTimeout-after-completion: the next
			// tick is scheduled immediately, not gated on this tick's sync
			// call resolving, so one genuinely slow/locked mailbox can't
			// delay re-syncing every other watched mailbox either (see
			// isMailboxSyncRetryPending() for the per-mailbox side of that).
			const tick = () => {
				this.mainStore.syncWatchedMailboxes()
					.then(() => {
						logger.debug("Watched mailboxes sync'ed in background")
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
				this.watchedMailboxSyncTimeout = setTimeout(tick, 10_000 + Math.random() * 5_000)
			}
			this.watchedMailboxSyncTimeout = setTimeout(tick, 10_000 + Math.random() * 5_000)
		},
	},
}
</script>
