<!--
  - SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<NcEmptyContent class="empty-content" :name="t('mail', 'No messages')">
		<template #icon>
			<IconMail />
		</template>
		<!-- NcEmptyContent already wraps this slot in a <p>. -->
		<template v-if="unmatchedTerms.length > 0" #description>
			{{ explanation }}
		</template>
	</NcEmptyContent>
</template>

<script>
import { translatePlural as n, translate as t } from '@nextcloud/l10n'
import NcEmptyContent from '@nextcloud/vue/components/NcEmptyContent'
import IconMail from 'vue-material-design-icons/EmailOutline.vue'
export default {
	name: 'EmptyMailboxSection',
	components: {
		IconMail,
		NcEmptyContent,
	},

	props: {
		/**
		 * Words of the current search that match nothing here.
		 *
		 * A search requires every word to appear somewhere, so one word the
		 * server has never seen empties the whole list -- and until this was
		 * shown, the three usual causes (a typo, a word that only occurs in a
		 * message body that was not searched, and a word spelled with
		 * different accents than the user typed) were indistinguishable from
		 * "there is nothing there".
		 */
		unmatchedTerms: {
			type: Array,
			required: false,
			default: () => [],
		},
	},

	computed: {
		explanation() {
			return n(
				'mail',
				'No message contains "{terms}". Every word of a search has to appear somewhere; try removing it.',
				'No message contains any of "{terms}". Every word of a search has to appear somewhere; try removing them.',
				this.unmatchedTerms.length,
				{ terms: this.unmatchedTerms.join('", "') },
			)
		},
	},

	methods: {
		t,
		n,
	},
}
</script>

<style lang="scss" scoped>
.empty-content {
	height: 100%;
	display: flex;
}
</style>
