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
				@click="$emit('select', section.id)">
				<span class="priority-overview__label">{{ section.label }}</span>
				<span class="priority-overview__count">
					<template v-if="hasStats">
						<CounterBubble v-if="section.unread > 0">
							{{ formatted(section.unread) }}
						</CounterBubble>
						<strong v-else>0</strong>
						<span aria-hidden="true"> / {{ formatted(section.total) }}{{ complete ? '' : '+' }}</span>
					</template>
					<span v-else aria-hidden="true">…</span>
				</span>
				<span
					v-if="section.newCount > 0"
					class="priority-overview__new"
					aria-hidden="true">
					+{{ formatted(section.newCount) }}
				</span>
			</button>
		</div>

		<div class="priority-overview__actions">
			<button
				type="button"
				class="priority-overview__unread-toggle"
				:aria-pressed="unreadOnly ? 'true' : 'false'"
				@click="$emit('toggle-unread')">
				<span class="priority-overview__toggle-mark" aria-hidden="true">{{ unreadOnly ? '✓' : '' }}</span>
				{{ t('mail', 'Unread only') }}
			</button>
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

		unreadOnly: {
			type: Boolean,
			default: false,
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
			return this.stats?.sections?.[section] ?? { unread: 0, total: 0 }
		},

		formatted(value) {
			return Number(value ?? 0).toLocaleString()
		},

		sectionAriaLabel(section) {
			if (!this.hasStats) {
				return t('mail', '{section}, counts loading', { section: section.label })
			}
			const base = t('mail', '{section}: {unread} unread of {total}', {
				section: section.label,
				unread: this.formatted(section.unread),
				total: this.formatted(section.total),
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

.priority-overview__new {
	position: absolute;
	top: -5px;
	inset-inline-end: -3px;
	min-width: 18px;
	padding: 0 4px;
	border-radius: 10px;
	background: var(--color-primary-element);
	color: var(--color-primary-element-text);
	font-size: 0.7rem;
	text-align: center;
}

.priority-overview__actions {
	display: flex;
	align-items: center;
	gap: calc(var(--default-grid-baseline) * 2);
	min-height: 27px;
	padding-top: 3px;
	font-size: 0.78rem;
}

.priority-overview__unread-toggle,
.priority-overview__new-message {
	border: 0;
	background: transparent;
	color: var(--color-primary-element);
	cursor: pointer;
}

.priority-overview__unread-toggle {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--color-main-text);
}

.priority-overview__toggle-mark {
	display: inline-flex;
	width: 16px;
	height: 16px;
	align-items: center;
	justify-content: center;
	border: 1px solid var(--color-border-maxcontrast);
	border-radius: 4px;
}

.priority-overview__unread-toggle[aria-pressed='true'] .priority-overview__toggle-mark {
	border-color: var(--color-primary-element);
	background: var(--color-primary-element);
	color: var(--color-primary-element-text);
}

.priority-overview__new-message {
	margin-inline-start: auto;
	font-weight: 600;
}

.priority-overview__refreshing {
	margin-inline-start: auto;
	color: var(--color-text-maxcontrast);
}

@media (max-width: 420px) {
	.priority-overview__label {
		font-size: 0.72rem;
	}
}
</style>
