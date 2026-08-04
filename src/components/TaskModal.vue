<!--
  - SPDX-FileCopyrightText: 2023 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<Modal @close="onClose">
		<div class="modal-content">
			<h2>{{ t('mail', 'Create task') }}</h2>
			<div class="taskTitle">
				<label for="taskTitle">{{ t('mail', 'Title') }}</label>
				<input id="taskTitle" v-model="taskTitle" type="text">
			</div>
			<div class="all-day">
				<DatetimePicker
					v-model="startDate"
					:format="dateFormat"
					:clearable="false"
					:minute-step="5"
					:show-second="false"
					:type="datePickerType"
					:show-timezone-select="true"
					:timezone-id="startTimezoneId" />
				<DatetimePicker
					v-model="endDate"
					:format="dateFormat"
					:clearable="false"
					:minute-step="5"
					:show-second="false"
					:type="datePickerType"
					:show-timezone-select="true"
					:timezone-id="endTimezoneId" />
			</div>
			<label for="note">{{ t('mail', 'Description') }}</label>
			<textarea id="note" v-model="note" rows="7" />
			<div class="all-day">
				<input
					id="allDay"
					v-model="isAllDay"
					type="checkbox"
					class="checkbox">
				<label for="allDay">
					{{ t('mail', 'All day') }}
				</label>
			</div>
			<div class="task-reminder">
				<label :for="reminderPickerId">{{ t('mail', 'Reminder') }}</label>
				<NcSelect
					:id="reminderPickerId"
					v-model="selectedReminderChoice"
					label="label"
					:input-id="reminderPickerId"
					:disabled="!canRemind"
					:clearable="false"
					:aria-label-combobox="t('mail', 'Select reminder')"
					:options="reminderChoices" />
				<!-- Said once, here, rather than left for the user to discover:
				     a relative trigger needs something to be relative TO, and
				     with neither date there is nothing. -->
				<p v-if="!canRemind" class="task-reminder__hint">
					{{ t('mail', 'Pick a start or due date to set a reminder.') }}
				</p>
			</div>

			<!-- FIXME: is broken due to upstream select component serializing options to JSON -->
			<NcSelect
				v-model="selectedCalendarChoice"
				label="displayname"
				input-id="url"
				:placeholder="t('mail', 'Select calendar')"
				:aria-label-combobox="t('mail', 'Select calendar')"
				:allow-empty="false"
				:options="calendarChoices">
				<template #option="{ id }">
					<CalendarPickerOption
						:color="getCalendarById(id).color"
						:displayname="getCalendarById(id).displayname" />
				</template>
				<template #selected-option="{ id }">
					<CalendarPickerOption
						:color="getCalendarById(id).color"
						:displayname="getCalendarById(id).displayname"
						:display-icon="getCalendarById(id).displayIcon" />
				</template>
				<template #no-options>
					<span>{{ t('mail', 'No calendars with task list support') }}</span>
				</template>
			</NcSelect>
			<br>
			<button class="primary" :disabled="disabled" @click="onSave">
				{{ t('mail', 'Create') }}
			</button>
		</div>
	</Modal>
</template>

<script>
import moment from '@nextcloud/moment'
import { NcDateTimePicker as DatetimePicker, NcModal as Modal, NcSelect } from '@nextcloud/vue'
import ICAL from 'ical.js'
import jstz from 'jstz'
import { mapStores } from 'pinia'
import CalendarPickerOption from './CalendarPickerOption.vue'
import logger from '../logger.js'
import { linkTaskToMessage, messageDeepLink } from '../service/MessageTaskService.js'
import useMainStore from '../store/mainStore.js'
import Task from '../task.js'
import { randomId } from '../util/randomId.js'
import {
	parseReminder,
	REMINDER_NONE,
	reminderChoices,
	reminderRelatedTo,
} from '../util/taskReminder.js'
import { parseStartOffset, START_NONE, startDateFor } from '../util/taskStartDate.js'
import { showError, showSuccess } from '../util/toast.js'

export default {
	name: 'TaskModal',
	components: {
		CalendarPickerOption,
		DatetimePicker,
		Modal,
		NcSelect,
	},

	props: {
		envelope: {
			type: Object,
			required: true,
		},
	},

	data() {
		// Try to determine the current timezone, and fall back to UTC otherwise
		const defaultTimezone = jstz.determine()
		const defaultTimezoneId = defaultTimezone ? defaultTimezone.name() : 'UTC'

		return {

			taskTitle: this.envelope.subject,
			startDate: null,
			endDate: null,
			isAllDay: true,
			startTimezoneId: defaultTimezoneId,
			endTimezoneId: defaultTimezoneId,
			saving: false,
			selectedCalendarChoice: undefined,
			// Held as the raw preference spelling ('none' or a signed integer
			// as a string) rather than a number, so it round-trips through the
			// preference unchanged and 'none' needs no special case.
			reminder: REMINDER_NONE,
			reminderPickerId: randomId(),
			// Whether the start date still holds the value we seeded, so a
			// date the user chose is never silently replaced.
			startDateIsOurs: true,
			seededStartDate: null,
			note: this.envelope.previewText,
		}
	},

	computed: {
		...mapStores(useMainStore),
		disabled() {
			return this.saving || this.calendars.length === 0
		},

		dateFormat() {
			return this.isAllDay ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm'
		},

		datePickerType() {
			return this.isAllDay ? 'date' : 'datetime'
		},

		tags() {
			return this.mainStore.getAllTags
		},

		calendars() {
			return this.mainStore.getTaskCalendarsForCurrentUser
		},

		calendarChoices() {
			return this.calendars.map((calendar) => ({
				id: calendar.id,
				color: calendar.color,
				displayname: calendar.displayname,
			}))
		},

		reminderChoices() {
			return reminderChoices(this.isAllDay)
		},

		/**
		 * A relative trigger needs an anchor, and the anchor is a date the
		 * user has actually picked. Both start blank here.
		 */
		canRemind() {
			return reminderRelatedTo({ due: this.endDate, start: this.startDate }) !== null
		},

		selectedReminderChoice: {
			get() {
				return this.reminderChoices.find((choice) => choice.value === this.reminder)
					?? this.reminderChoices[0]
			},

			set(choice) {
				this.reminder = choice?.value ?? REMINDER_NONE
			},
		},

		selectedCalendar() {
			if (!this.selectedCalendarChoice) {
				return undefined
			}

			return this.calendars.find((cal) => cal.id === this.selectedCalendarChoice.id)
		},
	},

	watch: {
		isAllDay(allDay) {
			// The two option sets share no values -- an all-day reminder is
			// built around 09:00 and a timed one around the due moment -- so a
			// selection cannot simply carry over. Re-read the preference for
			// the kind of task this now is, which is also what the user set it
			// for; silently keeping a number from the other set would put a
			// 23:45-the-night-before alarm on an all-day task.
			this.reminder = this.preferredReminder(allDay)

			// Re-derived rather than left alone: the Tasks app truncates a
			// start date to the day for an all-day task and to the hour
			// otherwise, so the same offset means a different moment either
			// side of this toggle. Only touched while the field still holds
			// what we put there -- once the user has picked a date themselves,
			// overwriting it would be rude.
			if (this.startDateIsOurs) {
				this.startDate = this.preferredStartDate(allDay)
			}
		},

		startDate(value) {
			// Any change we did not make ourselves is the user's, and from then
			// on the field is theirs.
			if (value !== this.seededStartDate) {
				this.startDateIsOurs = false
			}
		},
	},

	created() {
		this.reminder = this.preferredReminder(this.isAllDay)
		this.startDate = this.preferredStartDate(this.isAllDay)
		logger.debug('creating task from envelope', {
			envelope: this.envelope,
		})
	},

	async mounted() {
		if (this.calendars.length) {
			this.selectedCalendarChoice = this.calendarChoices[0]
		}
	},

	methods: {
		/**
		 * The user's default reminder for this kind of task.
		 *
		 * Two preferences, not one, for the same reason the Calendar app keeps
		 * defaultReminderPartDay and defaultReminderFullDay apart: the offsets
		 * that make sense for a task due at a moment and one due on a day are
		 * different numbers with different signs.
		 *
		 * @param {boolean} allDay whether the task has no time of day
		 * @return {string} 'none' or the offset, as stored
		 */
		preferredReminder(allDay) {
			const key = allDay ? 'task-reminder-full-day' : 'task-reminder-part-day'
			const stored = this.mainStore.getPreference(key, REMINDER_NONE)
			const seconds = parseReminder(stored, allDay)
			return seconds === null ? REMINDER_NONE : String(seconds)
		},

		/**
		 * The user's default start date, if they have set one.
		 *
		 * A START date and not a due one: inside Nextcloud the due date is the
		 * only thing that surfaces a task, but inventing a deadline makes
		 * everything overdue and the marker stops meaning anything. The Tasks
		 * app's "Current" collection is entered by having STARTED, so this buys
		 * the visibility without the false deadline.
		 *
		 * @param {boolean} allDay whether the task has no time of day
		 * @return {Date|null} the start date to seed the picker with
		 */
		preferredStartDate(allDay) {
			const stored = this.mainStore.getPreference('task-start-date', START_NONE)
			const date = startDateFor(parseStartOffset(stored), allDay)
			this.seededStartDate = date
			return date
		},

		/**
		 * @param {string} id The calendar id
		 * @return {object|undefined} The calendar object (if it exists)
		 */
		getCalendarById(id) {
			return this.calendars.find((cal) => cal.id === id)
		},

		onClose() {
			this.$emit('close')
		},

		async createTask(taskData) {
			const task = new Task('BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Nextcloud Mail v' + this.mainStore.getAppVersion + '\nEND:VCALENDAR', taskData.calendar)
			task.created = ICAL.Time.now()
			task.summary = taskData.summary
			task.hidesubtasks = 0
			if (taskData.priority) {
				task.priority = taskData.priority
			}
			if (taskData.complete) {
				task.complete = taskData.complete
			}
			if (taskData.note) {
				task.note = taskData.note
			}
			if (taskData.due) {
				task.due = taskData.due
			}
			if (taskData.start) {
				task.start = taskData.start
			}
			if (taskData.allDay) {
				task.allDay = taskData.allDay
			}

			// The link back to the message it came from, as the iCalendar URL
			// property. That is what RFC 5545 defines URL for, and the Tasks
			// app treats it as a first-class field -- it reads it into
			// _customUrl and writes it back on save, so the value survives
			// being edited there.
			//
			// Not RELATED-TO: Tasks uses that for the parent/subtask
			// hierarchy, and a message is not a calendar component anyway.
			// Not ATTACH: Tasks has no model getter for it, so it would be
			// invisible to the person the link is for.
			//
			// The URL resolves the Message-ID at CLICK time rather than
			// pointing at a mailbox and row id, so it still works after the
			// message is filed somewhere else. See DeepLinkController.
			if (taskData.messageLink) {
				task.vtodo.updatePropertyWithValue('url', taskData.messageLink)
			}

			// A reminder, if one is set AND there is something to anchor it to.
			//
			// RELATED=END on a VTODO means its DUE time (RFC 5545), which is
			// what "remind me before this is due" actually asks for. DTSTART is
			// the fallback; with neither date the trigger has no referent and
			// no alarm is written at all.
			//
			// DISPLAY carries a mandatory DESCRIPTION -- an alarm without one
			// is invalid, and clients that do honour task alarms are the whole
			// audience for this.
			const relatedTo = reminderRelatedTo({ due: taskData.due, start: taskData.start })
			if (taskData.reminder !== null && relatedTo !== null) {
				const alarm = new ICAL.Component('valarm')
				alarm.addPropertyWithValue('action', 'DISPLAY')
				alarm.addPropertyWithValue('description', taskData.summary)
				const trigger = new ICAL.Property('trigger')
				trigger.setParameter('related', relatedTo)
				trigger.setValue(ICAL.Duration.fromSeconds(taskData.reminder))
				alarm.addProperty(trigger)
				task.vtodo.addSubcomponent(alarm)
			}

			const vData = ICAL.stringify(task.jCal)

			// KEEP the created object. The response carries the name CalDAV
			// gave it, and that name -- not the VTODO's UID -- is what the
			// Tasks app routes on (/calendars/<cal>/tasks/<uri>). Discarding
			// it left task.uri empty and every link we stored pointed at a
			// task that does not exist: cdav-library names the object with an
			// identifier of its own, so UID e179a093-... lives at
			// 85D8FD67-....ics.
			task.dav = await task.calendar.dav.createVObject(vData)

			return task
		},

		async onSave() {
			this.saving = true

			const taskData = {
				summary: this.taskTitle,
				calendar: this.selectedCalendar,
				start: this.startDate ? moment(this.startDate).format().toString() : null,
				due: this.endDate ? moment(this.endDate).set().format().toString() : null,
				allDay: this.isAllDay,
				note: this.note,
				messageLink: messageDeepLink(this.envelope.messageId),
				// Re-parsed rather than trusted: the picker holds a string that
				// came from a preference nothing on the server validates.
				reminder: parseReminder(this.reminder, this.isAllDay),
			}
			try {
				logger.debug('create task', taskData)

				const task = await this.createTask(taskData)

				// Index it so the MESSAGE can find the task. CalDAV cannot be
				// asked which tasks point at a message, so this is the only
				// way the thread ever learns it has one.
				//
				// Deliberately not awaited into the failure path of the task
				// itself: the task exists and carries its link back either
				// way, so a failure here costs the indicator, and telling the
				// user their task failed would be a lie.
				try {
					await linkTaskToMessage(this.envelope.databaseId, {
						calendarUri: this.selectedCalendar.id,
						taskUid: task.uid,
						// What the deep link actually resolves on. The UID is kept
						// because it is what identifies the task itself.
						taskUri: task.uri,
						summary: this.taskTitle,
					})
					// Tell whatever is on screen that the answer has changed.
					this.mainStore.messageTaskRevision++
				} catch (error) {
					logger.warn('task created, but it could not be indexed against the message', { error })
				}

				showSuccess(t('mail', 'Task created'))

				this.onClose()
			} catch (error) {
				showError(t('mail', 'Could not create task'))

				logger.error('Creating event from message failed', { error })
			} finally {
				this.saving = false
			}
		},
	},
}
</script>

<style lang="scss" scoped>
.task-reminder {
	margin-block: calc(var(--default-grid-baseline, 4px) * 2);

	&__hint {
		color: var(--color-text-maxcontrast);
		font-size: 0.9em;
	}
}

:deep(.modal-wrapper .modal-container) {
	width: calc(100vw - 120px) !important;
	height: calc(100vh - 120px) !important;
	max-width: 490px !important;
	max-height: 500px !important;
}

:deep(.calendar-picker-option__color-indicator){
    margin-inline-start: 10px !important;
}

.modal-content {
	padding: 30px 30px 20px !important;
}

input , textarea {
	width: 100%;
}

:deep(input[type='text']) {
	padding: 0 !important;
}

.all-day {
	margin-inline-start: -1px;
	margin-top: 5px;
	margin-bottom: 5px;
}

.taskTitle {
	margin-bottom: 5px;
}

.primary {
	height: 44px !important;
	float: inline-end;
}

:deep(.mx-datepicker) {
	width: 213px;
}
</style>
