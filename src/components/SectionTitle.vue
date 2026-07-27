<!--
  - SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<div class="section-title-wrapper">
		<div class="app-content-list-item">
			<h2>{{ name }}</h2>
			<!-- Unread only. The section total was a number the user could
			     neither act on nor read at a glance ("41.078"), and reporting
			     it forced the counters query to visit every message in every
			     inbox: 373ms warm and 6,820ms cold, versus 20ms and 300ms for
			     the unread-only query, because unread is naturally tiny (13
			     threads across five inboxes here). -->
			<span v-if="unreadCount" class="section-title-count">
				{{ n('mail', '%n unread', '%n unread', unreadCount) }}{{ complete ? '' : '+' }}
			</span>
		</div>
	</div>
</template>

<script>
export default {
	name: 'SectionTitle',
	props: {
		name: {
			type: String,
			required: true,
		},

		unreadCount: {
			type: Number,
			default: undefined,
		},

		complete: {
			type: Boolean,
			default: true,
		},
	},
}
</script>

<style scoped>
.section-title-wrapper {
	display: inline-block;
}

.app-content-list-item {
	display: flex;
	align-items: baseline;
	gap: 8px;
	opacity: .8;
}

.app-content-list-item:hover {
	background-color: transparent;
	opacity: 0.8;
}

h2 {
	font-weight: normal;
	font-size: 17px;
	margin-bottom: 2px;
}

.section-title-count {
	color: var(--color-text-maxcontrast);
	font-size: 12px;
	white-space: nowrap;
}
</style>
