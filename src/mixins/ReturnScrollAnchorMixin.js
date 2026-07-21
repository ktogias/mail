/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { getScrollEventTarget } from '../directives/infinite-scroll.js'
import useMainStore from '../store/mainStore.js'

/**
 * Re-anchors the mailbox list's scroll position to the specific row the user
 * opened, every time a thread closes back to this list -- mixed into
 * Mailbox.vue only.
 *
 * Confirmed live (not a hypothetical): returning from an open thread does
 * NOT reliably preserve the list's scroll position -- it lands back at the
 * top every time, most likely a side effect of @nextcloud/vue's own
 * NcAppContent/NcAppContentList reacting to the show-details/layout props
 * toggling on navigation (its source ships minified, not worth reverse
 * engineering further -- the fix below is correct regardless of the exact
 * upstream cause). So this always restores position on return; it does not
 * try to detect whether restoring is "needed" first.
 */
export default {
	data() {
		return {
			returnScrollAnchorContainer: undefined,
		}
	},

	computed: {
		// Named distinctly from the host's own `mainStore` (Mailbox.vue
		// already has one via mapStores()), matching IdleTailTrimMixin's
		// own precedent -- this mixin never depends on how, or whether,
		// the host itself wires that up.
		returnScrollAnchorStore() {
			return useMainStore()
		},
	},

	watch: {
		'$route.params.threadId': function onThreadRouteParamChange(newThreadId, oldThreadId) {
			// Only a genuine "a thread was open, now it isn't" transition --
			// not the initial mount (oldThreadId undefined) and not opening
			// a (possibly different) thread (newThreadId truthy).
			if (newThreadId || !oldThreadId) {
				return
			}
			this.$nextTick(() => {
				this.reanchorScrollToLastOpenedEnvelope()
			})
		},
	},

	mounted() {
		this.returnScrollAnchorContainer = getScrollEventTarget(this.$el)
	},

	methods: {
		reanchorScrollToLastOpenedEnvelope() {
			const openedFrom = this.returnScrollAnchorStore.lastOpenedFromList
			if (!openedFrom || openedFrom.databaseId === undefined) {
				return
			}
			// Priority Inbox stacks several Mailbox instances against one
			// shared scroller -- only the instance that actually owns the
			// recorded list should act. Same comparison shape
			// Thread.vue::prefetchListNeighborhood() already uses.
			if (openedFrom.mailboxId !== this.mailbox.databaseId || openedFrom.query !== this.searchQuery) {
				return
			}
			if (!this.returnScrollAnchorContainer) {
				return
			}
			const row = this.$el.querySelector(`[data-envelope-id="${openedFrom.databaseId}"]`)
			if (!row) {
				// Message no longer in the list (deleted, moved, paginated
				// away since) -- nothing to scroll to.
				return
			}
			row.scrollIntoView({ block: 'nearest' })
		},
	},
}
