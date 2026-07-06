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
			// A plain interval, not a recursive setTimeout-after-completion:
			// the previous implementation only scheduled its next run once
			// the current one had fully resolved, which meant one genuinely
			// slow/locked mailbox (e.g. a large Gmail INBOX mid a long full
			// sync) delayed re-syncing every OTHER watched mailbox across
			// every account for as long as it stayed locked, even though
			// their own individual sync calls settle in well under a second.
			// setInterval fires on a fixed cadence regardless of whether the
			// previous tick's promise has settled yet, so a stuck mailbox
			// can no longer hold up anyone else's cadence -- per-mailbox
			// isolation is handled inside syncWatchedMailboxes() itself
			// (see isMailboxSyncRetryPending()).
			this.watchedMailboxSyncInterval = setInterval(() => {
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
			}, 10 * 1000)
		},
	},
}
</script>
