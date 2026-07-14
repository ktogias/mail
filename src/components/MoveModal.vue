<!--
  - SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<MailboxPicker
		:account="account"
		:selected.sync="destMailboxId"
		:label-select="moveThread ? t('mail', 'Move thread') : t('mail', 'Move message')"
		:label-select-loading="moveThread ? t('mail', 'Moving thread') : t('mail', 'Moving message')"
		@select="onMove"
		@close="onClose" />
</template>

<script>
import MailboxPicker from './MailboxPicker.vue'

export default {
	name: 'MoveModal',
	components: {
		MailboxPicker,
	},

	props: {
		account: {
			type: Object,
			required: true,
		},

		envelopes: {
			type: Array,
			required: true,
		},

		moveThread: {
			type: Boolean,
			default: false,
		},
	},

	data() {
		return {
			destMailboxId: undefined,
		}
	},

	methods: {
		onClose() {
			this.$emit('close')
		},

		// The actual store calls are the caller's job now (EnvelopeList.vue
		// or Thread.vue, depending on where this modal was opened from),
		// deferred behind an undo window like every other delete/archive/
		// junk/move action -- this modal's own job ends at picking a
		// destination. Closes immediately rather than showing its own
		// "Moving..." spinner: same reasoning as every other action here,
		// the move looks done right away, the real, irreversible IMAP
		// call happens a few seconds later unless undone.
		onMove() {
			const envelopes = this.envelopes
				.filter((envelope) => envelope.mailboxId !== this.destMailboxId)

			if (envelopes.length > 0) {
				this.$emit('request-move', {
					envelopes,
					destMailboxId: this.destMailboxId,
					moveThread: this.moveThread,
				})
			}

			this.$emit('close')
		},
	},
}
</script>
