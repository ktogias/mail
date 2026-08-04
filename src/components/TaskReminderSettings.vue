<!--
  - SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<div class="task-reminder-settings">
		<div class="task-reminder-settings__row">
			<label :for="partDayPickerId">
				{{ t('mail', 'Task with a time') }}
			</label>
			<NcSelect
				:id="partDayPickerId"
				v-model="partDayChoice"
				label="label"
				:input-id="partDayPickerId"
				:disabled="saving"
				:clearable="false"
				:aria-label-combobox="t('mail', 'Default reminder for a task with a time')"
				:options="partDayChoices" />
		</div>

		<div class="task-reminder-settings__row">
			<label :for="fullDayPickerId">
				{{ t('mail', 'All-day task') }}
			</label>
			<NcSelect
				:id="fullDayPickerId"
				v-model="fullDayChoice"
				label="label"
				:input-id="fullDayPickerId"
				:disabled="saving"
				:clearable="false"
				:aria-label-combobox="t('mail', 'Default reminder for an all-day task')"
				:options="fullDayChoices" />
		</div>

		<!-- Stated plainly rather than left to be discovered by an alarm that
		     never arrives. This is a real limitation of the platform, not of
		     the setting, and a user who reads it can decide whether the
		     feature is any use to them. -->
		<p class="task-reminder-settings__note">
			{{ t('mail', 'Reminders on tasks are delivered by calendar apps that sync this account, such as Thunderbird or DAVx⁵. Nextcloud itself does not notify for task reminders; use the due date for that.') }}
		</p>
	</div>
</template>

<script>
import { NcSelect } from '@nextcloud/vue'
import { mapStores } from 'pinia'
import Logger from '../logger.js'
import useMainStore from '../store/mainStore.js'
import { randomId } from '../util/randomId.js'
import { parseReminder, REMINDER_NONE, reminderChoices } from '../util/taskReminder.js'

/**
 * The default reminder applied to a task created from a message.
 *
 * Two settings rather than one, following the Calendar app: it keeps
 * defaultReminderPartDay and defaultReminderFullDay apart because an all-day
 * item is due at midnight, so "15 minutes before" would mean 23:45 the night
 * before. The offsets that suit each case are different numbers with different
 * signs, and one control cannot express both.
 *
 * Stored per USER, not per account, even though the neighbouring default
 * calendar is per account. When you want to be reminded is a working habit,
 * not a property of a mailbox.
 */
export default {
	name: 'TaskReminderSettings',

	components: {
		NcSelect,
	},

	data() {
		return {
			partDayPickerId: randomId(),
			fullDayPickerId: randomId(),
			saving: false,
		}
	},

	computed: {
		...mapStores(useMainStore),

		partDayChoices() {
			return reminderChoices(false)
		},

		fullDayChoices() {
			return reminderChoices(true)
		},

		partDayChoice: {
			get() {
				return this.choiceFor('task-reminder-part-day', false)
			},

			set(choice) {
				this.save('task-reminder-part-day', choice)
			},
		},

		fullDayChoice: {
			get() {
				return this.choiceFor('task-reminder-full-day', true)
			},

			set(choice) {
				this.save('task-reminder-full-day', choice)
			},
		},
	},

	methods: {
		/**
		 * The currently selected choice for one of the two settings.
		 *
		 * Parsed rather than matched directly: nothing on the server validates
		 * a preference value, so a stored string that is not one of the offered
		 * offsets has to fall back to "no reminder" instead of leaving the
		 * picker blank.
		 *
		 * @param {string} key the preference key
		 * @param {boolean} allDay which option set applies
		 * @return {object} the matching choice
		 */
		choiceFor(key, allDay) {
			const stored = this.mainStore.getPreference(key, REMINDER_NONE)
			const seconds = parseReminder(stored, allDay)
			const value = seconds === null ? REMINDER_NONE : String(seconds)
			const choices = allDay ? this.fullDayChoices : this.partDayChoices
			return choices.find((choice) => choice.value === value) ?? choices[0]
		},

		/**
		 * @param {string} key the preference key
		 * @param {object|null} choice the newly selected choice
		 */
		async save(key, choice) {
			this.saving = true
			try {
				await this.mainStore.savePreference({
					key,
					value: choice?.value ?? REMINDER_NONE,
				})
			} catch (error) {
				Logger.error('could not save the default task reminder', { error })
			} finally {
				this.saving = false
			}
		},
	},
}
</script>

<style lang="scss" scoped>
.task-reminder-settings {
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
