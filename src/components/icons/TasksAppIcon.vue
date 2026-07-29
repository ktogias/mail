<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<span class="tasks-app-icon" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true">
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 32 32"
			:width="size"
			:height="size"
			focusable="false">
			<!-- Filled tile: THIS message is the one the task came from.
			     Outlined: the CONVERSATION carries one. Same distinction the
			     list already draws between Star and StarOutline, and it has to
			     read the same way here or it teaches two different rules. -->
			<template v-if="outlined">
				<rect
					x="1.6"
					y="1.6"
					width="28.8"
					height="28.8"
					rx="4.6"
					fill="none"
					stroke="#0082c9"
					stroke-width="3.2" />
				<path
					d="m9.55 18-5.7-5.7 1.425-1.425L9.55 15.15l9.175-9.175L20.15 7.4 9.55 18Z"
					fill="#0082c9"
					transform="translate(-1.05 -1.05) scale(1.13)" />
			</template>
			<template v-else>
				<path
					d="M5 0h22a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H5a5 5 0 0 1-5-5V5a5 5 0 0 1 5-5Z"
					fill="#0082c9" />
				<path
					d="m9.55 18-5.7-5.7 1.425-1.425L9.55 15.15l9.175-9.175L20.15 7.4 9.55 18Z"
					fill="#fff"
					transform="translate(-3.141 -3.13) scale(1.59509)" />
			</template>
		</svg>
	</span>
</template>

<script>
/**
 * The Tasks app's own favicon: a rounded square in Nextcloud blue with a white
 * tick. Copied from tasks/img/favicon.svg rather than linked to it.
 *
 * Inlined, not fetched from /apps/tasks/img/favicon.svg, for two reasons. The
 * marker has to render even where the Tasks app is disabled or missing -- the
 * index rows outlive it -- and a broken image is a worse answer than a plain
 * one. And it is one more request per thread for 300 bytes.
 *
 * The blue is the literal brand value, not var(--color-primary-element). That
 * is deliberate: the point of borrowing another app's icon is that it is
 * RECOGNISABLE as that app, and re-tinting it to whatever theme this instance
 * uses would defeat exactly the recognition it is there to provide.
 */
export default {
	name: 'TasksAppIcon',

	props: {
		size: {
			type: Number,
			default: 16,
		},

		/**
		 * Outline instead of a filled tile.
		 *
		 * The list already says "this message is starred" with a filled Star
		 * and "the conversation contains a starred message" with StarOutline.
		 * The thread header is making the second kind of statement, so it has
		 * to look like the second kind.
		 */
		outlined: {
			type: Boolean,
			default: false,
		},
	},
}
</script>

<style lang="scss" scoped>
.tasks-app-icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: 0 0 auto;
	// Only the filled tile needs clipping to rounded corners; the outlined
	// variant draws its own inset border.
	border-radius: 3px;
}
</style>
