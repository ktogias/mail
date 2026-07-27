<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<nav class="priority-overview" :aria-label="t('mail', 'Priority Inbox overview')">
		<div class="priority-overview__sections">
			<button
				v-for="section in visibleSections"
				:key="section.id"
				type="button"
				class="priority-overview__section"
				:aria-label="sectionAriaLabel(section)"
				:title="sectionAriaLabel(section)"
				@click="$emit('select', section.id)">
				<span class="priority-overview__label">{{ section.label }}</span>
				<!-- ONE number, and only when there is something to act on. A
				     section with nothing unread said "0 / 0" once the totals
				     were dropped in .38; before that each chip carried an
				     unread count AND a "+N new" badge, with a footer silently
				     summing the second -- three numbers, no labels.
				     "Has new mail" is a different fact from "is unread", so it
				     is a dot: it says WHERE without adding an arithmetic
				     puzzle. -->
				<span class="priority-overview__count">
					<!-- A plain number, not a counter bubble. The chip is
					     already the container; a badge inside a badge carried
					     no extra meaning and its min-width plus padding was
					     what stopped three Greek labels fitting one row. -->
					<template v-if="hasStats">{{ section.unread > 0 ? formatted(section.unread) + (complete ? '' : '+') : '' }}</template>
					<span v-else aria-hidden="true">…</span>
				</span>
				<span
					v-if="section.newCount > 0"
					class="priority-overview__new-dot"
					aria-hidden="true" />
			</button>
		</div>
	</nav>
</template>

<script>
export default {
	name: 'PriorityInboxOverview',

	props: {
		stats: {
			type: Object,
			default: undefined,
		},

		newCounts: {
			type: Object,
			default: () => ({ favorite: 0, important: 0, other: 0 }),
		},

		showFavorites: {
			type: Boolean,
			default: true,
		},

		loading: {
			type: Boolean,
			default: false,
		},
	},

	computed: {
		hasStats() {
			return this.stats?.sections !== undefined
		},

		complete() {
			return this.stats?.complete !== false
		},

		visibleSections() {
			return [
				{
					id: 'favorite',
					label: t('mail', 'Favorites'),
					...this.sectionStats('favorite'),
					newCount: this.newCounts.favorite ?? 0,
				},
				{
					id: 'important',
					label: t('mail', 'Important'),
					...this.sectionStats('important'),
					newCount: this.newCounts.important ?? 0,
				},
				{
					id: 'other',
					label: t('mail', 'Other'),
					...this.sectionStats('other'),
					newCount: this.newCounts.other ?? 0,
				},
			].filter((section) => this.showFavorites || section.id !== 'favorite')
		},

	},

	methods: {
		sectionStats(section) {
			return this.stats?.sections?.[section] ?? { unread: 0 }
		},

		formatted(value) {
			return Number(value ?? 0).toLocaleString()
		},

		sectionAriaLabel(section) {
			if (!this.hasStats) {
				return t('mail', '{section}, counts loading', { section: section.label })
			}
			const base = n('mail', '{section}: {unread} unread', '{section}: {unread} unread', section.unread, {
				section: section.label,
				unread: this.formatted(section.unread),
			})
			return section.newCount > 0
				? base + ', ' + n('mail', '{count} new message', '{count} new messages', section.newCount, { count: this.formatted(section.newCount) })
				: base
		},
	},
}
</script>

<style lang="scss" scoped>
.priority-overview {
	padding: 0 var(--default-grid-baseline) 4px;
	border-bottom: 1px solid var(--color-border);
	background: var(--color-main-background);
}

/* One row of content-sized chips, not a three-column grid of two-line
   cards: the label and its count belong on the same line, and the block
   used to take a fifth of a phone screen before any message appeared. */
.priority-overview__sections {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}

.priority-overview__section {
	display: inline-flex;
	align-items: baseline;
	gap: 5px;
	min-width: 0;
	padding: 2px 8px;
	border: 0;
	border-radius: var(--border-radius-element, 8px);
	background: var(--color-background-hover);
	color: var(--color-main-text);
	text-align: start;
	cursor: pointer;

	&:hover,
	&:focus-visible {
		background: var(--color-background-dark);
	}
}

.priority-overview__label,
.priority-overview__count {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.priority-overview__label {
	font-size: 0.78rem;
	color: var(--color-text-maxcontrast);
}

.priority-overview__count {
	font-size: 0.82rem;
	font-weight: 600;

	&:empty {
		display: none;
	}
}

/* Inline with the label, not floating over the chip's corner: the badge
   used to sit outside the border and read as a second, competing count. */
.priority-overview__new-dot {
	display: inline-block;
	width: 5px;
	height: 5px;
	border-radius: 50%;
	background: var(--color-primary-element);
	vertical-align: middle;
}

@media (max-width: 420px) {
	.priority-overview__label {
		font-size: 0.72rem;
	}

	.priority-overview__count {
		font-size: 0.78rem;
	}
}
</style>
