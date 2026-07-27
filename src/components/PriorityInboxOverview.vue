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
				<span class="priority-overview__label">
					{{ section.label }}
					<!-- "Has new mail" is a different fact from "is unread", and
					     showing both as numbers side by side made the chip a
					     puzzle: reported live, a header reading 2 / 10 / 4 over
					     badges reading +10 / +4 over a footer reading "14 new
					     messages" took a moment to decode. One number per chip,
					     the actionable one; the dot says where new mail landed
					     and the pill below carries how much. -->
					<span
						v-if="section.newCount > 0"
						class="priority-overview__new-dot"
						aria-hidden="true" />
				</span>
				<span class="priority-overview__count">
					<!-- Only when there is something to act on. A section with
					     nothing unread said "0 / 0" once the totals were
					     dropped in .38 -- two zeroes carrying no information. -->
					<CounterBubble v-if="hasStats && section.unread > 0">
						{{ formatted(section.unread) }}{{ complete ? '' : '+' }}
					</CounterBubble>
					<span v-else-if="!hasStats" aria-hidden="true">…</span>
				</span>
			</button>
		</div>

		<!-- The unread filter lives in the search filter row with its
		     siblings (Has attachment, To me), not here. It used to be a
		     checkbox in this bar AND a chip there -- one filter, two widget
		     languages, two places, and setPriorityUnreadOnly() only ever
		     delegated to the chip's own setUnread(). -->
		<div v-if="totalNew > 0 || (loading && hasStats)" class="priority-overview__actions">
			<button
				v-if="totalNew > 0"
				type="button"
				class="priority-overview__new-message"
				role="status"
				aria-live="polite"
				@click="$emit('select', firstNewSection)">
				{{ n('mail', '{count} new message', '{count} new messages', totalNew, { count: formatted(totalNew) }) }}
				<span aria-hidden="true"> · </span>{{ t('mail', 'View') }}
			</button>
			<span
				v-else-if="loading && hasStats"
				class="priority-overview__refreshing"
				role="status">
				{{ t('mail', 'Updating counts …') }}
			</span>
		</div>
	</nav>
</template>

<script>
import { NcCounterBubble as CounterBubble } from '@nextcloud/vue'

export default {
	name: 'PriorityInboxOverview',

	components: {
		CounterBubble,
	},

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

		totalNew() {
			return this.visibleSections.reduce((total, section) => total + section.newCount, 0)
		},

		firstNewSection() {
			return this.visibleSections.find((section) => section.newCount > 0)?.id
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
	padding: 0 var(--default-grid-baseline) var(--default-grid-baseline);
	border-bottom: 1px solid var(--color-border);
	background: var(--color-main-background);
}

.priority-overview__sections {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: var(--default-grid-baseline);
}

.priority-overview__section {
	position: relative;
	min-width: 0;
	padding: 5px 6px;
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
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.priority-overview__label {
	font-size: 0.78rem;
	color: var(--color-text-maxcontrast);
}

/* The count row keeps its height whether or not a bubble is in it, so the
   three chips stay the same size and the row does not jump as mail is read. */
.priority-overview__count {
	min-height: 20px;
}

.priority-overview__count {
	font-size: 0.9rem;

	:deep(.counter-bubble__counter) {
		display: inline-flex;
		min-width: 20px;
		height: 20px;
		align-items: center;
		justify-content: center;
		vertical-align: middle;
	}
}

/* Inline with the label, not floating over the chip's corner: the badge
   used to sit outside the border and read as a second, competing count. */
.priority-overview__new-dot {
	display: inline-block;
	width: 6px;
	height: 6px;
	margin-inline-start: 4px;
	border-radius: 50%;
	background: var(--color-primary-element);
	vertical-align: middle;
}

.priority-overview__actions {
	display: flex;
	align-items: center;
	gap: calc(var(--default-grid-baseline) * 2);
	min-height: 27px;
	padding-top: 3px;
	font-size: 0.78rem;
}

/* One affordance, centred: a transient "new content" pill, the same pattern
   every feed and mail client uses for arrivals. It is an ACTION, so it no
   longer shares a row with a filter control that looked identical. */
.priority-overview__new-message {
	margin-inline: auto;
	padding: 2px 12px;
	border: 0;
	border-radius: var(--border-radius-pill, 14px);
	background: var(--color-primary-element);
	color: var(--color-primary-element-text);
	font-weight: 600;
	cursor: pointer;

	&:hover,
	&:focus-visible {
		background: var(--color-primary-element-hover);
	}
}

.priority-overview__refreshing {
	margin-inline: auto;
	color: var(--color-text-maxcontrast);
}

@media (max-width: 420px) {
	.priority-overview__label {
		font-size: 0.72rem;
	}
}
</style>
