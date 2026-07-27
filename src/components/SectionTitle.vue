<!--
  - SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<div class="section-title-wrapper">
		<div class="app-content-list-item">
			<h2>{{ name }}</h2>
			<!-- No count here. The sticky overview above shows the unread
			     count per section and STAYS on screen while this header
			     scrolls away, so repeating the number 40 pixels below it was
			     the same value twice with the shorter-lived copy winning the
			     space. Persistent chrome carries state; inline headers carry
			     structure. -->
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
</style>
