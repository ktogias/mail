<!--
  - SPDX-FileCopyrightText: 2025 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<div class="calendar-settings">
		<NcCheckboxRadioSwitch
			id="imip-create"
			:model-value="imipCreate"
			:disabled="saving"
			@update:checked="onToggleImipCreate">
			{{ t('mail', 'Automatically create tentative appointments in calendar') }}
		</NcCheckboxRadioSwitch>

		<NcCheckboxRadioSwitch
			id="imip-allow-unmatched"
			:model-value="imipAllowUnmatched"
			:disabled="saving"
			@update:checked="onToggleImipAllowUnmatched">
			{{ t('mail', 'Allow accepting invitations even if no participant matches this account (forwards, mailing lists)') }}
		</NcCheckboxRadioSwitch>

		<div class="calendar-settings__default-calendar">
			<label :for="defaultCalendarPickerId">
				{{ t('mail', 'Default calendar for events and invitations') }}
			</label>
			<NcSelect
				:id="defaultCalendarPickerId"
				v-model="selectedCalendar"
				:disabled="saving"
				:aria-label-combobox="t('mail', 'Select calendar')"
				label="displayname"
				:options="calendarOptions" />
		</div>
	</div>
</template>

<script>
import { NcCheckboxRadioSwitch, NcSelect } from '@nextcloud/vue'
import { mapStores } from 'pinia'
import Logger from '../logger.js'
import useMainStore from '../store/mainStore.js'
import { randomId } from '../util/randomId.js'

export default {
	name: 'CalendarSettings',
	components: {
		NcCheckboxRadioSwitch,
		NcSelect,
	},

	props: {
		account: {
			type: Object,
			required: true,
		},
	},

	data() {
		return {
			imipCreate: this.account.imipCreate,
			imipAllowUnmatched: this.account.imipAllowUnmatched,
			// Empty string is the local mirror of "no default" (stored as null
			// server-side) and also the url of the "Use app default" option.
			defaultCalendarUrl: this.account.defaultCalendarUrl ?? '',
			defaultCalendarPickerId: randomId(),
			saving: false,
		}
	},

	computed: {
		...mapStores(useMainStore),

		/**
		 * Writeable calendars plus a leading "use app default" entry (empty url).
		 *
		 * @return {object[]}
		 */
		calendarOptions() {
			const calendars = this.mainStore.getClonedWriteableCalendars.map((calendar) => ({
				displayname: calendar.displayname,
				url: calendar.url,
			}))
			return [
				{ displayname: t('mail', 'Use app default'), url: '' },
				...calendars,
			]
		},

		/**
		 * Two-way binding for the picker: reads the option matching the locally
		 * mirrored default-calendar url (or the "use app default" entry), and on
		 * selection patches the account.
		 */
		selectedCalendar: {
			get() {
				return this.calendarOptions.find((option) => option.url === this.defaultCalendarUrl)
					?? this.calendarOptions[0]
			},

			set(option) {
				// NcSelect emits null when the selection is cleared.
				this.patch('defaultCalendarUrl', option?.url ?? '')
			},
		},
	},

	methods: {
		async onToggleImipCreate(val) {
			await this.patch('imipCreate', val)
		},

		async onToggleImipAllowUnmatched(val) {
			await this.patch('imipAllowUnmatched', val)
		},

		/**
		 * Optimistically apply a single account setting (the data property name
		 * matches the account field), rolling the local mirror back on failure.
		 *
		 * @param {string} key The account field / local data property to patch.
		 * @param {(string|boolean)} val The new value.
		 * @return {Promise<void>}
		 */
		async patch(key, val) {
			if (this.saving) {
				return
			}

			const oldVal = this[key]
			this[key] = val
			this.saving = true

			try {
				await this.mainStore.patchAccount({
					account: this.account,
					data: {
						[key]: val,
					},
				})
				Logger.info(`Account calendar setting ${key} updated`, { value: val })
			} catch (error) {
				Logger.error(`could not update account calendar setting ${key}`, { error })
				this[key] = oldVal
				throw error
			} finally {
				this.saving = false
			}
		},
	},
}
</script>

<style lang="scss" scoped>
.calendar-settings {
	display: flex;
	flex-direction: column;
	gap: 10px;

	&__default-calendar {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 6px;
	}
}
</style>
