<!--
  - SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<div class="section-title-wrapper">
		<div class="app-content-list-item">
			<h2>{{ name }}</h2>
			<span v-if="unreadCount !== undefined" class="section-title-count">
				{{ t('mail', '{unread} unread of {total}', {
					unread: formatted(unreadCount),
					total: formatted(totalCount),
				}) }}{{ complete ? '' : '+' }}
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

		totalCount: {
			type: Number,
			default: 0,
		},

		complete: {
			type: Boolean,
			default: true,
		},
	},

	methods: {
		formatted(value) {
			return Number(value ?? 0).toLocaleString()
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
