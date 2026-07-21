<!--
  - SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<!-- Was a conditional <router-link> wrapper. A router-link subscribes to
	     $route, so every row re-rendered on every navigation -- opening one
	     message re-rendered the whole list (O(N) per open, traced in the
	     2026-07-20 profiling). NcVNodes is a transparent fragment (no DOM
	     wrapper element, no route reactivity): the row resolves its href once
	     (resolvedHref) and takes its active state from the `active` prop (fed
	     from the store's currentOpenThreadId), and navigates in onClick(). A
	     route change now re-renders only the row whose active state changed. -->
	<NcVNodes>
		<li
			class="list-item__wrapper"
			:class="{ 'list-item__wrapper--active': active }">
			<div
				ref="list-item"
				class="list-item"
				:class="{
					'list-item--compact': compact,
					'list-item--one-line': oneLine,
					'list-item--multiline': !oneLine,
				}"
				@mouseover="handleMouseover"
				@mouseleave="handleMouseleave">
				<a
					:id="anchorId || undefined"
					:aria-label="linkAriaLabel"
					class="list-item__anchor"
					:href="resolvedHref"
					:target="target || (href === '#' ? undefined : '_blank')"
					:rel="href === '#' ? undefined : 'noopener noreferrer'"
					@focus="showActions"
					@focusout="handleBlur"
					@click="onClick"
					@contextmenu.prevent
					@keydown.esc="hideActions">
					<!-- @slot This slot is used for the NcAvatar or icon, the content of this slot must not be interactive -->
					<slot name="icon" />

					<div class="list-item-content">
						<div class="list-item-content__name">
							<!-- @slot Slot for the first line of the component. prop 'name' is used as a fallback is no slots are provided -->
							<span>
								<slot name="name">{{ name }}</slot>
							</span>
						</div>
						<div class="list-item-content__inner">
							<div class="list-item-content__inner__main">
								<div
									v-if="hasSubname"
									class="list-item-content__inner__subname"
									:class="{ 'list-item-content__inner__subname--bold': bold }">
									<!-- @slot Slot for the second line of the component -->
									<slot name="subname" />
								</div>
								<div
									v-if="$slots.tags"
									class="list-item-content__inner__tags"
									@click.prevent.stop>
									<!-- @slot This slot is used for the third line of the component -->
									<slot name="tags" />
								</div>
							</div>

							<div class="list-item-content__inner__details">
								<div class="list-item-content__inner__details__details" :class="[{ 'list-item-content__inner__details__details--hidden': showDetails }]">
									<!-- @slot This slot is used for some details in form of icon (prop `details` as a fallback) -->
									<slot name="details">{{ details }}</slot>
								</div>

								<!-- Counter and indicator -->
								<div
									v-if="counterNumber || hasIndicator"
									class="list-item-content__inner__details__extra">
									<NcCounterBubble
										v-if="counterNumber"
										:active="active"
										:class="{ 'extra--hidden': !showAdditionalElements }"
										class="list-item-content__inner__details__extra__counter"
										:type="counterType">
										{{ counterNumber }}
									</NcCounterBubble>

									<!-- Deliberately NOT gated by showAdditionalElements: this is
									     informational state (e.g. unread), unrelated to whether the
									     hover-revealed action buttons are showing. It used to share
									     that same visibility toggle, which is driven by @mouseover/
									     @focus -- both of which mobile browsers synthesize on every
									     tap. Confirmed live: selecting a message on mobile made its
									     own unread dot vanish (tap -> synthetic mouseover -> hidden),
									     reappearing only once focus moved to the next tapped row. The
									     two floating action-button areas (list-item__hoverable) are
									     absolutely positioned overlays with their own background --
									     they don't actually compete for this same layout space, so
									     nothing here needs to hide for them to show. -->
									<span v-if="hasIndicator" class="list-item-content__inner__details__extra__indicator">
										<!-- @slot This slot is used for some indicator in form of icon -->
										<slot name="indicator" />
									</span>
								</div>
							</div>
						</div>
					</div>
				</a>

				<!-- Keep this expensive named-slot subtree genuinely lazy. The
				     full menu contains many translated controls, and every t()
				     sanitizes through DOMPurify. v-show used to instantiate all of
				     it for every row even when the user never hovered that row. -->
				<div
					v-if="forceDisplayActions || displayActionsOnHoverFocus"
					class="list-item__hoverable">
					<EnvelopeSingleClickActions
						:is-read="isRead"
						:is-important="isImportant"
						@delete="$emit('delete')"
						@toggle-important="$emit('toggle-important')"
						@toggle-seen="$emit('toggle-seen')" />

					<!-- Actions -->
					<div
						class="list-item__actions"
						@focusout="handleBlur">
						<NcActions
							ref="actions"
							:primary="active"
							:aria-label="computedActionsAriaLabel"
							variant="tertiary"
							@update:open="handleActionsUpdateOpen">
							<template #icon>
								<DotsHorizontal :size="20" />
							</template>
							<!-- @slot Provide the actions for the right side quick menu -->
							<slot name="actions" />
						</NcActions>
					</div>
				</div>
			</div>
		</li>
	</NcVNodes>
</template>

<script>
import { NcActions, NcCounterBubble, NcVNodes } from '@nextcloud/vue'
import DotsHorizontal from 'vue-material-design-icons/DotsHorizontal.vue'
import EnvelopeSingleClickActions from './EnvelopeSingleClickActions.vue'
import { isCoarsePointer } from '../util/pointerType.js'

export default {
	name: 'EnvelopeSkeleton',

	components: {
		NcActions,
		NcCounterBubble,
		NcVNodes,
		EnvelopeSingleClickActions,
		DotsHorizontal,
	},

	props: {
		/**
		 * The details text displayed in the upper right part of the component
		 */
		details: {
			type: String,
			default: '',
		},

		/**
		 * Name (first line of text)
		 */
		name: {
			type: String,
			required: true,
		},

		/**
		 * Pass in `true` if you want the matching behavior to
		 * be non-inclusive: https://router.vuejs.org/api/#exact
		 */
		exact: {
			type: Boolean,
			default: false,
		},

		/**
		 * The route for the router link.
		 */
		to: {
			type: [String, Object],
			default: null,
		},

		/**
		 * The value for the external link
		 */
		href: {
			type: String,
			default: '#',
		},

		target: {
			type: String,
			default: '',
		},

		/**
		 * Id for the `<a>` element
		 */
		anchorId: {
			type: String,
			default: '',
		},

		/**
		 * Make subname bold
		 */
		bold: {
			type: Boolean,
			default: false,
		},

		/**
		 * Show the NcListItem in compact design
		 */
		compact: {
			type: Boolean,
			default: false,
		},

		/**
		 * Toggle the active state of the component
		 */
		active: {
			type: Boolean,
			default: false,
		},

		/**
		 * Aria label for the wrapper element
		 */
		linkAriaLabel: {
			type: String,
			default: '',
		},

		/**
		 * Aria label for the actions toggle
		 */
		actionsAriaLabel: {
			type: String,
			default: '',
		},

		/**
		 * If different from 0 this component will display the
		 * NcCounterBubble component
		 */
		counterNumber: {
			type: [Number, String],
			default: 0,
		},

		/**
		 * Outlined or highlighted state of the counter
		 */
		counterType: {
			type: String,
			default: '',
			validator(value) {
				return ['highlighted', 'outlined', ''].indexOf(value) !== -1
			},
		},

		/**
		 * To be used only when the elements in the actions menu are very important
		 */
		forceDisplayActions: {
			type: Boolean,
			default: false,
		},

		/**
		 * Show the list component layout
		 */
		oneLine: {
			type: Boolean,
			default: false,
		},

		isRead: {
			type: Boolean,
			default: false,
		},

		isImportant: {
			type: Boolean,
			default: false,
		},
	},

	emits: [
		'click',
		'update:menuOpen',
	],

	data() {
		return {
			hovered: false,
			hasActions: false,
			hasSubname: false,
			displayActionsOnHoverFocus: false,
			menuOpen: false,
			hasIndicator: false,
			hasDetails: false,
		}
	},

	computed: {
		showAdditionalElements() {
			return !this.displayActionsOnHoverFocus || this.forceDisplayActions
		},

		showDetails() {
			return (this.details !== '' || this.hasDetails)
				&& (!this.displayActionsOnHoverFocus || this.forceDisplayActions)
		},

		computedActionsAriaLabel() {
			return this.actionsAriaLabel || t('Actions for item with name "{name}"', { name: this.name })
		},

		// Resolve the row's href ONCE from `to`, without a <router-link>'s
		// reactive dependency on the live $route. `to` is built from the
		// store's route mirror (Envelope.vue::link()), so it stays stable
		// across thread opens and this computed does not re-run on navigation.
		resolvedHref() {
			if (!this.to) {
				return this.href
			}
			try {
				return this.$router.resolve(this.to).href
			} catch (e) {
				return this.href
			}
		},
	},

	watch: {

		menuOpen(newValue) {
			// A click outside both the menu and the root element hides the actions again
			if (!newValue && !this.hovered) {
				this.displayActionsOnHoverFocus = false
			}
		},
	},

	mounted() {
		this.checkSlots()
	},

	updated() {
		this.checkSlots()
	},

	methods: {
		/**
		 * Handle link click. Navigation is done here (this.$router.push)
		 * rather than by a <router-link> so the row does not carry a reactive
		 * dependency on $route -- see the template comment and resolvedHref().
		 *
		 * @param {MouseEvent|KeyboardEvent} event - Native click or keydown event
		 */
		onClick(event) {
			// Always forward the native event: Envelope.vue's own @click
			// handler records list context and opens draft rows on it --
			// and, on mobile (see LongPressMixin/selectMode there), may
			// call event.preventDefault() to turn this tap into a
			// selection toggle instead of a navigation.
			this.$emit('click', event)
			if (event.defaultPrevented) {
				return
			}
			// Modifier keys mean open-in-new-tab (or, on an envelope row,
			// select via the parent's own modifier handlers) -- let the
			// browser follow the real href and do not navigate in place.
			if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) {
				return
			}
			// Internal route: navigate in place. Draft rows have no `to`;
			// their click is handled entirely by the parent (opens composer).
			if (this.to) {
				event.preventDefault()
				// push() rejects with NavigationDuplicated when re-clicking
				// the already-open row -- swallow that.
				const navigation = this.$router.push(this.to)
				if (navigation && typeof navigation.catch === 'function') {
					navigation.catch(() => {})
				}
			}
		},

		showActions() {
			// On a touch device the hover/focus reveal is exactly the mobile
			// tap ambiguity: a tap synthesizes focus (and mouseover), which
			// would flash the floating actions overlay and race the tap's own
			// navigation -- the original report behind backlog #18. Touch uses
			// the deterministic model instead (tap = open, long-press = select,
			// with the full action toolbar in selection mode -- see
			// Envelope.vue), so the hover overlay must never appear there.
			if (isCoarsePointer()) {
				return
			}
			if (this.hasActions) {
				this.displayActionsOnHoverFocus = true
			}
			this.hovered = false
		},

		hideActions() {
			this.displayActionsOnHoverFocus = false
		},

		/**
		 * @param {FocusEvent} event UI event
		 */
		handleBlur(event) {
			// do not hide if open
			if (this.menuOpen) {
				return
			}
			// do not hide if focus is kept within
			if (this.$refs['list-item'].contains(event.relatedTarget)) {
				return
			}
			this.hideActions()
		},

		/**
		 * Hide the actions on mouseleave unless the menu is open
		 */
		handleMouseleave() {
			if (!this.menuOpen) {
				this.displayActionsOnHoverFocus = false
			}
			this.hovered = false
		},

		handleMouseover() {
			// Belt-and-suspenders with showActions()'s own coarse-pointer
			// guard: a tap synthesizes mouseover too, and this must not flag
			// the row as hovered (which would keep the overlay logic warm).
			if (isCoarsePointer()) {
				return
			}
			this.showActions()
			this.hovered = true
		},

		handleActionsUpdateOpen(e) {
			this.menuOpen = e
			this.$emit('update:menuOpen', e)
		},

		// Check if subname and actions slots are populated
		checkSlots() {
			if (this.hasActions !== !!this.$slots.actions) {
				this.hasActions = !!this.$slots.actions
			}
			if (this.hasSubname !== !!this.$slots.subname) {
				this.hasSubname = !!this.$slots.subname
			}
			if (this.hasIndicator !== !!this.$slots.indicator) {
				this.hasIndicator = !!this.$slots.indicator
			}
			if (this.hasDetails !== !!this.$slots.details) {
				this.hasDetails = !!this.$slots.details
			}
		},
	},
}
</script>

<style lang="scss" scoped>

.list-item__wrapper {
	display: flex;
	position: relative;
	width: 100%;
	// padding for the focus-visible styles. Width is reduced to compensate it
	padding: 2px 4px;
	// The first and lastelement needs also padding for the box shadow of the focus-visible effect
	&:first-of-type {
		padding-block-start: 4px;
	}
	&:last-of-type {
		padding-block-end: 4px
	}

	&--active,
	&.active {
		.list-item {
			background-color: var(--color-primary-element);
			&:focus-within,
			&:has(:focus-visible),
			&:has(:active) {
				background-color: var(--color-primary-element-hover);
			}
			// Hover-only, gated so it doesn't stick after a tap on touch.
			@media (hover: hover) {
				&:hover {
					background-color: var(--color-primary-element-hover);
				}
			}
		}

		.list-item-content__name,
		.list-item-content__subname,
		.list-item-content__details,
		.list-item-details__details {
			color: var(--color-primary-element-text);
		}

		.list-item-content__quick-actions :deep(svg) {
			fill: var(--color-primary-element-text) !important;
		}
	}
	.list-item-content__name,
	.list-item-content__subname,
	.list-item-content__details,
	.list-item-details__details {
		white-space: nowrap;
		margin-block: 0;
		margin-inline-start: 0;
		margin-inline-end: auto;
		overflow: hidden;
		text-overflow: ellipsis;

		&--hidden {
			visibility: hidden;
		}
	}
}

// NcListItem
.list-item {
	--list-item-padding: calc(var(--default-grid-baseline) * 2);
	// The content are two lines of text and respect the 1.5 line height
	--list-item-border-radius: var(--border-radius-element, 32px);
	--list-item-height: calc(4 * var(--default-line-height));
	height: var(--list-item-height);

	// General styles
	box-sizing: border-box;
	display: flex;
	position: relative;
	flex: 0 0 auto;
	justify-content: flex-start;
	// we need to make sure the elements are not cut off by the border
	width: 100%;
	border-radius: var(--border-radius-element, 32px);
	cursor: pointer;
	transition: background-color var(--animation-quick) ease-in-out;
	list-style: none;
	flex-wrap: nowrap !important;
	padding: var(--default-grid-baseline);

	&:has(:active),
	&:has(:focus-visible) {
		background-color: var(--color-background-hover);
	}

	// Hover-only, gated so the row-highlight doesn't stick after a tap on
	// touch (see the (hover: hover) note on the name-expansion rule below).
	@media (hover: hover) {
		&:hover {
			background-color: var(--color-background-hover);
		}
	}

	&:has(&__anchor:focus-visible) {
		outline: 2px solid var(--color-main-text);
		box-shadow: 0 0 0 4px var(--color-main-background);
	}

	&__hoverable {
		visibility: hidden;
	}

	.list-item-content {
		display: flex;
		flex-direction: column;

		&__name {
			min-width: 100px;
			flex: 1 1 10%;
			font-weight: 500;
			// we changed the time/date and actions to be alighned with the name
			max-width: 78%;
			line-height: var(--default-line-height);

			span {
				min-width: 0;
				overflow: hidden;
				flex: 1 1 auto;
				text-overflow: ellipsis;
			}
		}

		&__inner {
			display: flex;
			flex-direction: row;
			justify-content: space-between;
			max-width: 100%;

			&__main {
				flex: 0 1 auto;
				min-width: 0;
			}

			&__subname {
				flex: 1 0;
				min-width: 0;
				color: var(--color-text-maxcontrast);
				line-height: var(--default-line-height);
				&--bold {
					font-weight: 500;
				}
				.list-item--compact.list-item--multiline & {
					white-space: normal;
					overflow: visible;
					text-overflow: unset;
				}
			}

			&__tags {
				overflow-y: auto;
				display: flex;
				flex-direction: row;
				justify-content: start;
				align-items: center;
				line-height: var(--default-line-height);
			}

			&__details {
				display: flex;
				flex-direction: column;
				justify-content: start;
				align-items: end;
				white-space: nowrap;
				gap: 4px;
				// to align details on top instead of in the center. The right way to do it would be to change the template, but that breaks one-line layout
				margin-top: -22px;

				&__details {
					margin: 0 4px !important;
					color: var(--color-text-maxcontrast);
					height: var(--default-line-height);
					font-weight: normal;
				}

				&__extra {
					margin: 0 4px;
					height: calc(var(--default-line-height) * var(--default-font-size));
					display: flex;
					align-items: center;

					&__indicator {
						margin: 0 4px;
					}
				}
			}
		}
	}

	a {
		max-width: 100%;
		margin: 0;
	}

	.one-line .envelope__subtitle__subject {
		max-width: 300px;
	}

	&--compact {
		--list-item-padding: 2px;
	}

	&--one-line {
		--list-item-height: calc(var(--default-line-height) * var(--default-font-size) * 2 + var(--list-item-padding) * 4);
		--list-item-border-radius: var(--border-radius-element, calc(var(--default-clickable-area) / 2));
		padding-block: calc(var(--list-item-padding) * 2);
		--list-item-padding: 2px;
		height: unset;

		.list-item-content {
			flex-direction: row;
			align-content: center;
			align-items: center;
			min-width: 0;

			&__name {
				flex: 0 0 auto;
				min-width: 0;
				max-width: 40%;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				align-self: center;
				padding-inline-end: calc(var(--default-grid-baseline) * 2);
			}

			&__inner {
				flex: 1 1 auto;
				min-width: 0;
				overflow-y: hidden;
			}

			&__inner__main {
				display: flex;
				justify-content: start;
				min-width: 0;
			}

			&__inner__details {
				flex-direction: row;
				align-items: unset;
				justify-content: end;
				margin-top: 0;
				margin-inline-start: 0;
			}
		}

		a {
			margin: 0;
			align-items: center;
			height: unset;
		}

		.list-item__actions {
			align-self: center;
			margin-top: 0;
		}
	}

	&__anchor {
		display: flex;
		flex: 1 1 auto;
		align-items: start;
		height: var(--list-item-height);
		min-width: 0;

		// This is handled by the parent container
		&:focus-visible {
			outline: none;
		}
	}

	&-content {
		display: flex;
		flex: 1 0;
		justify-content: space-between;
		padding-inline-start: 8px;
		min-width: 0;
		&__main {
			flex: 1 0;
			width: 0;
			margin: auto 0;

			&--oneline {
				display: flex;
			}
		}
	}

}

.list-item:hover {
	.list-item__hoverable {
		visibility: visible;
		position: absolute;
		display: flex;
		background: var(--color-main-background);
		border-radius: var(--border-radius-element);
		box-shadow: 0 0 4px 0 var(--color-box-shadow);
		height: var(--default-clickable-area);
		inset-inline-end: var(--default-grid-baseline);

		:deep(svg) {
			fill: var(--color-main-text) !important; // needed to not inherit active styling
		}
	}
}

// Hover-only: expand the sender line to full width to reveal a long name.
// Gated behind (hover: hover) so it applies ONLY to a real hovering pointer
// -- on touch, :hover sticks after a tap (until another element is tapped)
// and this dropped the name's max-width, letting it overrun and cover the
// time (reported live: a stuck, expanded "Protoporia bookstores newsletter"
// title overlapping 21:29, made permanent by fast select/deselect tapping).
@media (hover: hover) {
	.list-item--multiline:hover .list-item-content__name {
		display: flex;
		justify-content: space-between;
		width: 100%;
		max-width: unset;
		max-height: calc(var(--default-font-size) * var(--default-line-height));
	}
}

// Force icon to be in line with the first two lines
:deep(.app-content-list-item-icon), :deep(.avatardiv), :deep(.avatardiv__initials-wrapper) {
	height: calc(var(--header-menu-item-height) - 4px);
	width: calc(var(--header-menu-item-height) - 4px);
}

.extra--hidden {
	visibility: hidden;
}
</style>
