<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<div class="task-start-settings">
		<div class="task-start-settings__row">
			<label :for="pickerId">
				{{ t('mail', 'Start date') }}
			</label>
			<NcSelect
				:id="pickerId"
				v-model="choice"
				label="label"
				:input-id="pickerId"
				:disabled="saving"
				:clearable="false"
				:aria-label-combobox="t('mail', 'Default start date for a task created from a message')"
				:options="choices" />
		</div>

		<!-- Why this is a start date and not a deadline. Worth saying: the
		     obvious reading of "default date" is a due date, and a user who
		     expects one will otherwise think the setting is broken. -->
		<p class="task-start-settings__note">
			{{ t('mail', 'A start date puts the task in the Tasks app\'s "Current" list without giving it a deadline. Deadlines that were never really agreed make everything look overdue, so none is set unless you set one yourself on the task.') }}
		</p>
	</div>
</template>

<script>
import { NcSelect } from '@nextcloud/vue'
import { mapStores } from 'pinia'
import Logger from '../logger.js'
import useMainStore from '../store/mainStore.js'
import { randomId } from '../util/randomId.js'
import { parseStartOffset, START_NONE, startOffsetChoices } from '../util/taskStartDate.js'

/**
 * The default start date for a task created from a message.
 *
 * Deliberately a start date rather than a due date. See util/taskStartDate.js
 * for the reasoning; in short, the Tasks app surfaces a task through its
 * "Current" collection by way of the START date, so this gives the task
 * somewhere to appear without inventing a deadline for it.
 *
 * Per user, like the reminder defaults beside it: when you want to be shown
 * something is a working habit, not a property of a mailbox.
 */
export default {
	name: 'TaskStartDateSettings',

	components: {
		NcSelect,
	},

	data() {
		return {
			pickerId: randomId(),
			saving: false,
		}
	},

	computed: {
		...mapStores(useMainStore),

		choices() {
			return startOffsetChoices()
		},

		choice: {
			get() {
				// Parsed rather than matched: nothing on the server validates a
				// preference value, so an unrecognised one has to fall back to
				// "none" instead of leaving the picker blank.
				const stored = this.mainStore.getPreference('task-start-date', START_NONE)
				const days = parseStartOffset(stored)
				const value = days === null ? START_NONE : String(days)
				return this.choices.find((c) => c.value === value) ?? this.choices[0]
			},

			set(choice) {
				this.save(choice)
			},
		},
	},

	methods: {
		/**
		 * @param {object|null} choice the newly selected choice
		 */
		async save(choice) {
			this.saving = true
			try {
				await this.mainStore.savePreference({
					key: 'task-start-date',
					value: choice?.value ?? START_NONE,
				})
			} catch (error) {
				Logger.error('could not save the default task start date', { error })
			} finally {
				this.saving = false
			}
		},
	},
}
</script>

<style lang="scss" scoped>
.task-start-settings {
	&__row {
		display: flex;
		flex-direction: column;
		gap: calc(var(--default-grid-baseline, 4px));
		margin-block-end: calc(var(--default-grid-baseline, 4px) * 2);
	}

	&__note {
		color: var(--color-text-maxcontrast);
		font-size: 0.9em;
	}
}
</style>
