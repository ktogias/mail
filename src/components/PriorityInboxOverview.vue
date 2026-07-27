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
/* Centred and 4px-gapped, matching .filter-buttons in SearchMessages
   exactly: the two rows sit directly on top of each other, so a difference
   in alignment reads as one of them being misplaced. They wrap rather than
   overflow, which is the only deliberate difference -- section labels are
   translated and can be much longer than the filter labels. */
.priority-overview__sections {
	display: flex;
	justify-content: center;
	align-items: center;
	flex-wrap: wrap;
	gap: 4px;
}

/* Same rhythm as the quick-filter chips directly above -- pill radius, the
   same height and type scale -- so the header reads as one system rather
   than two arbitrary ones.
   The difference is carried by COLOUR alone, and deliberately: those chips
   are toggles that change what the list contains and light up when active,
   these are navigation with no state at all. Giving two behaviours identical
   styling would promise that clicking "Favorites" filters to favourites,
   which it does not -- it scrolls there. Neutral = passive, tinted =
   selectable is the encoding. */
.priority-overview__section {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
	min-height: 32px;
	padding: 0 12px;
	border: 0;
	border-radius: var(--border-radius-pill, 16px);
	background: var(--color-background-hover);
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

/* The label is the constant, the count is the variable. Keeping the label
   first is the pattern this widget has settled on everywhere it exists
   (GitHub's "Open 12", Gmail's tabs, Linear, Jira): the labels form a stable
   set you learn the positions of, and the eye lands on the number that
   changed. Leading with the digit would start every chip with a numeral and
   force a second read to find out whose it is -- and would break the row's
   alignment the moment a section has nothing unread.
   So the count earns attention through weight and contrast instead. */
.priority-overview__label {
	font-size: 0.87rem;
	color: var(--color-text-maxcontrast);
}

.priority-overview__count {
	font-size: 0.87rem;
	font-weight: 700;
	color: var(--color-main-text);

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
		font-size: 0.8rem;
	}

	.priority-overview__count {
		font-size: 0.8rem;
	}
}
</style>
