<!--
  - SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="search-messages">
		<div class="search-messages__input">
			<input
				v-model="query"
				type="text"
				class="search-messages--input"
				:placeholder="t('mail', 'Search in folder')"
				:aria-label="t('mail', 'Search in folder')"
				@focus="showButtons = true"
				@blur="hideButtonsWithDelay(true)">
			<NcButton
				variant="tertiary"
				:aria-label="t('mail', 'Open search modal')"
				class="search-messages--filter"
				@click="moreSearchActions = true">
				<template #icon>
					<FilterVariantIcon :size="20" />
				</template>
			</NcButton>
			<NcButton
				v-if="filterChanged"
				:aria-label="t('mail', 'Close')"
				class="search-messages--close"
				@click="resetFilter()">
				<template #icon>
					<Close :size="24" />
				</template>
			</NcButton>

			<span
				v-if="filterChanged"
				class="filter-changed" />

			<NcDialog
				v-if="moreSearchActions"
				:name="t('mail', 'Search parameters')"
				size="normal"
				class="search-modal"
				:buttons="dialogButtons"
				@closing="closeSearchModal">
				<div class="modal-inner--content">
					<div class="modal-inner--field">
						<label class="modal-inner--label" for="subjectId">
							{{ t('mail', 'Subject') }}
						</label>
						<div class="modal-inner--container">
							<input
								id="subjectId"
								v-model="searchInSubject"
								type="text"
								class="search-input"
								:placeholder="t('mail', 'Search subject')">
						</div>
					</div>
					<div class="modal-inner--field">
						<label class="modal-inner--label" for="bodyId">
							{{ t('mail', 'Body') }}
						</label>
						<div class="modal-inner--container">
							<input
								id="bodyId"
								v-model="searchInMessageBody"
								type="text"
								class="search-input"
								:placeholder="t('mail', 'Search body')">
						</div>
					</div>
					<div class="modal-inner--field">
						<label class="modal-inner--label">
							{{ t('mail', 'Date') }}
						</label>
						<div class="modal-inner--container range">
							<div class="modal-inner-inline">
								<NcDateTimePickerNative
									v-model="startDate"
									type="date"
									:label="t('mail', 'Pick a start date')"
									confirm />
							</div>
							<div class="modal-inner-inline">
								<NcDateTimePickerNative
									v-model="endDate"
									type="date"
									:disabled="startDate === null"
									:label="t('mail', 'Pick an end date')"
									confirm />
							</div>
						</div>
					</div>
					<div class="modal-inner--field">
						<label class="modal-inner--label" for="fromId">
							{{ t('mail', 'From') }}
						</label>
						<div class="modal-inner--container">
							<NcSelect
								id="fromId"
								class="modal-inner--container__select"
								label="label"
								track-by="email"
								:options="autocompleteRecipients"
								:model-value="searchInFrom"
								:placeholder="t('mail', 'Select senders')"
								:aria-label-combobox="t('mail', 'Select senders')"
								:multiple="true"
								:taggable="true"
								:show-no-options="false"
								:preserve-search="true"
								:max="1"
								@option:selecting="addTag($event, 'from')"
								@option:deselecting="removeTag($event, 'from')"
								@search="searchRecipients($event)" />
						</div>
					</div>

					<div class="modal-inner--field">
						<label class="modal-inner--label" for="toId">
							{{ t('mail', 'To') }}
						</label>
						<div class="modal-inner--container">
							<NcSelect
								id="toId"
								class="modal-inner--container__select"
								label="label"
								track-by="email"
								:options="autocompleteRecipients"
								:model-value="searchInTo"
								:placeholder="t('mail', 'Select recipients')"
								:aria-label-combobox="t('mail', 'Select recipients')"
								:multiple="true"
								:taggable="true"
								:show-no-options="false"
								:preserve-search="true"
								@option:selecting="addTag($event, 'to')"
								@option:deselecting="removeTag($event, 'to')"
								@search="searchRecipients($event)" />
						</div>
					</div>

					<div class="modal-inner--field">
						<label class="modal-inner--label" for="ccId">
							{{ t('mail', 'Cc') }}
						</label>
						<div class="modal-inner--container">
							<NcSelect
								id="ccId"
								class="modal-inner--container__select"
								label="label"
								track-by="email"
								:options="autocompleteRecipients"
								:model-value="searchInCc"
								:placeholder="t('mail', 'Select CC recipients')"
								:aria-label-combobox="t('mail', 'Select CC recipients')"
								:multiple="true"
								:taggable="true"
								:show-no-options="false"
								:preserve-search="true"
								@option:selecting="addTag($event, 'cc')"
								@option:deselecting="removeTag($event, 'cc')"
								@search="searchRecipients($event)" />
						</div>
					</div>

					<div class="modal-inner--field">
						<label class="modal-inner--label" for="bccId">
							{{ t('mail', 'Bcc') }}
						</label>
						<div class="modal-inner--container">
							<NcSelect
								id="bccId"
								class="modal-inner--container__select"
								label="label"
								track-by="email"
								:options="autocompleteRecipients"
								:model-value="searchInBcc"
								:placeholder="t('mail', 'Select BCC recipients')"
								:aria-label-combobox="t('mail', 'Select BCC recipients')"
								:multiple="true"
								:taggable="true"
								:show-no-options="false"
								:preserve-search="true"
								@option:selecting="addTag($event, 'bcc')"
								@option:deselecting="removeTag($event, 'bcc')"
								@search="searchRecipients($event)" />
						</div>
					</div>

					<div v-if="tags.length > 0" class="modal-inner--field">
						<label for="tagsId">
							{{ t('mail', 'Tags') }}
						</label>
						<div class="modal-inner--container">
							<NcSelect
								v-if="tags.length > 0"
								id="tagsId"
								v-model="selectedTags"
								class="multiselect-search-tags "
								:options="tags"
								label="displayName"
								:model-value="selectedTags"
								:placeholder="t('mail', 'Select tags')"
								:aria-label-combobox="t('mail', 'Select tags')"
								track-by="displayName"
								:multiple="true"
								:auto-limit="false">
								<template #selected-option="option">
									<div class="tag-group__search">
										<div
											class="tag-group__bg"
											:style="
												'background-color:'
													+ (option.color !== '#fff'
														? option.color
														: '#333')" />
										<div
											class="tag-group__label"
											:style="'color:' + option.color">
											{{ option.displayName }}
										</div>
									</div>
								</template>
								<template #option="option">
									{{ option.displayName }}
								</template>
							</NcSelect>
						</div>
					</div>

					<div class="modal-inner--field">
						<label class="modal-inner--label" for="fromId">
							{{ t('mail', 'Marked as') }}
						</label>
						<div class="modal-inner--container marked-as">
							<div class="modal-inner-inline">
								<NcCheckboxRadioSwitch
									v-model="searchFlags"
									value="is_important"
									name="flags[]"
									type="checkbox">
									{{ t('mail', 'Important') }}
								</NcCheckboxRadioSwitch>
							</div>
							<div class="modal-inner-inline">
								<NcCheckboxRadioSwitch
									v-model="searchFlags"
									value="starred"
									name="flags[]"
									type="checkbox">
									{{ t('mail', 'Favorite') }}
								</NcCheckboxRadioSwitch>
							</div>
							<div class="modal-inner-inline">
								<NcCheckboxRadioSwitch
									v-model="searchFlags"
									value="attachments"
									name="flags[]"
									type="checkbox">
									{{ t('mail', 'Has attachments') }}
								</NcCheckboxRadioSwitch>
							</div>
							<div class="modal-inner-inline">
								<NcCheckboxRadioSwitch v-model="mentionsMe">
									{{ t('mail', 'Mentions me') }}
								</NcCheckboxRadioSwitch>
							</div>
						</div>
					</div>
				</div>
			</NcDialog>
		</div>
		<!-- Quick filters. Revealed by focusing the search box and hidden
		     again on blur -- EXCEPT while one of them is on, which
		     hideButtonsWithDelay() checks. That exception is the whole reason
		     this can be hidden safely: a filter silently narrowing the list
		     from behind a collapsed row would be the one genuinely bad
		     outcome, and it cannot happen.

		     .39 pinned this row open in the Priority Inbox. That was
		     collateral: its actual job was removing a duplicate "Unread only"
		     checkbox from the overview bar, and that stands either way. The
		     row itself is chrome the user has to look past on every screen to
		     reach the messages, for filters wanted occasionally. -->
		<div v-if="showButtons" class="filter-buttons">
			<NcChip
				:text="t('mail', 'Has attachment')"
				:no-close="true"
				:variant="hasAttachmentActive ? 'primary' : 'secondary'"
				:aria-label="t('mail', 'Has attachment')"
				@click.native="toggleGetAttachments" />
			<NcChip
				:text="t('mail', 'Unread')"
				:no-close="true"
				:variant="hasUnreadActive ? 'primary' : 'secondary'"
				:aria-label="t('mail', 'Unread')"
				@click.native="toggleUnread" />
			<NcChip
				:text="t('mail', 'To me')"
				:no-close="true"
				:variant="hasToMeActive ? 'primary' : 'secondary'"
				:aria-label="t('mail', 'To me')"
				@click.native="toggleCurrentUser" />
		</div>
	</div>
</template>

<script>
import IconClose from '@mdi/svg/svg/close.svg'
import IconMagnify from '@mdi/svg/svg/magnify.svg'
import { translate as t } from '@nextcloud/l10n'
import moment from '@nextcloud/moment'
import debouncePromise from 'debounce-promise'
import uniqBy from 'lodash/fp/uniqBy.js'
import { mapStores } from 'pinia'
import NcButton from '@nextcloud/vue/components/NcButton'
import NcCheckboxRadioSwitch
	from '@nextcloud/vue/components/NcCheckboxRadioSwitch'
import NcChip from '@nextcloud/vue/components/NcChip'
import NcDateTimePickerNative from '@nextcloud/vue/components/NcDateTimePickerNative'
import NcDialog from '@nextcloud/vue/components/NcDialog'
import NcSelect from '@nextcloud/vue/components/NcSelect'
import Close from 'vue-material-design-icons/Close.vue'
import FilterVariantIcon from 'vue-material-design-icons/FilterVariant.vue'
import { findRecipient } from '../service/AutocompleteService.js'
import useMainStore from '../store/mainStore.js'
import { hiddenTags } from './tags.js'

const debouncedSearch = debouncePromise(findRecipient, 500)

/**
 * How long the box has to stay still before message BODIES are searched.
 *
 * Far longer than the 700 ms the rest of the search uses, and deliberately so:
 * a header search is a local database query answering in about a second, while
 * a body search is a full IMAP round trip whose cost belongs entirely to the
 * mail server. Measured live on 2026-08-31 against isi.gr, one word 8.4 s,
 * three words 25.1 s.
 *
 * At 700 ms every pause between words started its own. One search for
 * `ifiroumelioti Ασυρματο δίκτυο` issued body searches for `ifi…`, then
 * `ifiroumelioti`, then the whole phrase -- three real round trips for one
 * question, ~40 s of which only the last was wanted. Aborting the superseded
 * requests does not help: the HTTP client gives up, the PHP worker does not,
 * so the round trip is paid whether or not anyone is still listening.
 *
 * Two seconds is comfortably longer than the pause between typing two words
 * and still short enough to feel automatic.
 */
const BODY_SEARCH_SETTLE_MS = 2000

export default {
	name: 'SearchMessages',
	components: {
		NcChip,
		NcDialog,
		NcSelect,
		NcDateTimePickerNative,
		NcButton,
		NcCheckboxRadioSwitch,
		FilterVariantIcon,
		Close,
	},

	props: {
		mailbox: {
			type: Object,
			required: true,
		},

		accountId: {
			type: Number,
			required: true,
		},
	},

	data() {
		return {
			showButtons: false,
			match: 'allof',
			query: '',
			debouncedSearchQuery: debouncePromise(this.sendQueryEvent, 700),
			debouncedBodySearch: debouncePromise(this.sendBodySearchEvent, BODY_SEARCH_SETTLE_MS),
			autocompleteRecipients: [],
			selectedTags: [],
			moreSearchActions: false,
			searchInFrom: [],
			searchInTo: [],
			searchInCc: [],
			searchInBcc: [],
			freeText: null,
			searchInSubject: null,
			searchInMessageBody: null,
			searchFlags: [],
			mentionsMe: false,
			startDate: null,
			endDate: null,
			dialogButtons: [
				{
					label: t('mail', 'Clear'),
					callback: () => this.resetFilter(),
					type: 'primary',
					icon: IconClose,
				},
				{
					label: t('mail', 'Search'),
					callback: () => this.closeSearchModal(),
					type: 'primary',
					icon: IconMagnify,
				},
			],
		}
	},

	computed: {
		...mapStores(useMainStore),
		tags() {
			return this.mainStore.getTags.filter((tag) => !(tag.displayName.toLowerCase() in hiddenTags)).sort((a, b) => {
				if (a.isDefaultTag && !b.isDefaultTag) {
					return -1
				}
				if (b.isDefaultTag && !a.isDefaultTag) {
					return 1
				}
				if (a.isDefaultTag && b.isDefaultTag) {
					if (a.displayName < b.displayName) {
						return 1
					}
					return -1
				}
				return a.displayName.localeCompare(b.displayName)
			})
		},

		hasAttachmentActive() {
			return this.searchFlags.includes('attachments')
		},

		hasUnreadActive() {
			return this.searchFlags.includes('unread')
		},

		hasToMeActive() {
			return this.searchInTo !== null && this.searchInTo[0]?.email === this.account.emailAddress
		},

		hasQuickFiltersActive() {
			return this.hasAttachmentActive || this.hasUnreadActive || this.hasToMeActive
		},

		filterChanged() {
			return Object.entries(this.filterData).filter(([key, val]) => {
				return val !== '' && val !== null && val.length > 0
			}).length > 0
		},

		/**
		 * Whether to ask the server to search message bodies too.
		 *
		 * In a single account's folder this is that account's own setting,
		 * as it always was. In the unified and priority inboxes there is no
		 * single account to ask -- `accountId` is the unified pseudo-account,
		 * whose `searchBody` is undefined -- so until now the per-account
		 * setting was silently ignored there and only the global preference
		 * counted. An account with body search explicitly enabled therefore
		 * never had its bodies searched from the inbox the user actually sits
		 * in, which is how a real search on 2026-08-28 returned nothing for a
		 * word that was in the message.
		 *
		 * Asking whenever ANY account wants it is safe because the decision is
		 * now also made per account on the server (MailSearch::searchesBodies):
		 * the accounts that opted out still pay nothing, and one filter string
		 * can keep fanning out to all of them unchanged.
		 */
		searchBody() {
			if (this.isFannedOut) {
				return this.mainStore.getPreference('search-priority-body', 'false') === 'true'
					|| this.mainStore.getAccounts.some((account) => account?.searchBody)
			}
			return !!this.mainStore.getAccount(this.accountId)?.searchBody
		},

		isFannedOut() {
			return this.mailbox.isUnified === true || this.mailbox.isPriorityInbox === true
		},

		account() {
			return this.mainStore.getAccount(this.accountId)
		},

		filterData() {
			return {
				to: this.searchInTo.length > 0 ? this.searchInTo.map((address) => address.email) : null,
				from: this.searchInFrom.length > 0 ? this.searchInFrom.map((address) => address.email) : null,
				cc: this.searchInCc.length > 0 ? this.searchInCc.map((address) => address.email) : null,
				bcc: this.searchInBcc.length > 0 ? this.searchInBcc.map((address) => address.email) : null,
				text: this.freeText !== null && this.freeText.length > 1 ? this.freeText : '',
				subject: this.searchInSubject !== null && this.searchInSubject.length > 1 ? this.searchInSubject : '',
				body: this.searchInMessageBody !== null && this.searchInMessageBody.length > 1 ? this.searchInMessageBody : '',
				tags: this.selectedTags.length > 0 ? this.selectedTags.map((item) => item.id) : '',
				flags: this.searchFlags.length > 0 ? this.searchFlags.map((item) => item) : '',
				mentions: this.mentionsMe,
				start: this.prepareStart(),
				end: this.prepareEnd(),
			}
		},

		searchQuery() {
			let _search = ''
			Object.entries(this.filterData).filter(([key, val]) => {
				if (['to', 'from', 'cc', 'bcc'].includes(key)) {
					val?.forEach((address) => {
						_search += `${key}:${encodeURI(address)} `
					})
				} else if (key === 'text' || key === 'body') {
					val.split(' ').forEach((word) => {
						if (word !== '' && val !== null) {
							_search += `${key}:${encodeURI(word)} `
						}
					})
				} else if (val !== '' && val !== null) {
					_search += `${key}:${encodeURI(val)} `
				}
				return val
			})
			_search += `match:${encodeURI(this.match)} `

			return _search.trim()
		},
	},

	/**
	 * The term must outlive this component.
	 *
	 * Opening a message and coming back re-creates it, and until .118 that
	 * reset the input to its placeholder while the list stayed filtered --
	 * with no clear button, because that only renders for a non-empty term.
	 * There was no way back to the full list short of reloading the page.
	 */
	mounted() {
		const remembered = this.mainStore.getSearchTerm(this.mailbox.databaseId)
		if (remembered && this.query === '') {
			this.query = remembered
		}
	},

	watch: {
		query() {
			// Persisted BEFORE the early returns below: clearing the box and
			// typing one or two characters are exactly the states that must
			// survive a re-mount, and both return early.
			this.mainStore.setSearchTermMutation({
				mailboxId: this.mailbox.databaseId,
				term: this.query,
			})

			if (this.query.length === 0) {
				return
			}

			// A 1-2 character free-text term is a %e%-style substring
			// match against subject AND sender AND recipient of every
			// message of every fanned-out mailbox -- measured live: a
			// mid-typing "eu" search matched practically everything,
			// and together with the final term's own fan-out saturated
			// the whole FPM pool (every request 504ed at the 20s tier,
			// the search rendered empty). Standard search-as-you-type
			// practice: don't fire below a minimum length.
			if (this.query.length < 3) {
				return
			}

			// One `text:` token per word, rather than the whole phrase into
			// subject AND from AND to. Those fields take the phrase literally,
			// so "sunrise wp4 deadline" asked for those three words
			// contiguously in a subject, or as an email address -- and
			// returned nothing, which is what a real search did on 2026-08-15.
			//
			// `text:` names no field: the server requires each word to appear
			// somewhere, not every word in the same somewhere.
			this.match = 'anyof'
			this.freeText = this.query
			// Headers first, always. They come from the local database and are
			// worth showing while the expensive half is still being decided;
			// carrying the previous keystroke's `body:` forward here would
			// also mean searching bodies for a word the user has moved on from.
			this.searchInMessageBody = null
			this.searchInSubject = null
			this.searchInFrom = []
			this.searchInTo = []
			this.debouncedSearchQuery()
			if (this.searchBody) {
				this.debouncedBodySearch()
			}
		},

		hasQuickFiltersActive(newVal) {
			if (!newVal) {
				this.hideButtonsWithDelay()
			}
		},
	},

	methods: {
		hideButtonsWithDelay(delay = false) {
			if (delay) {
				setTimeout(() => {
					if (this.hasQuickFiltersActive) {
						return
					}
					this.showButtons = false
				}, 500)
			} else {
				this.showButtons = false
			}
		},

		toggleGetAttachments() {
			if (this.hasAttachmentActive) {
				this.searchFlags = this.searchFlags.filter((flag) => flag !== 'attachments')
			} else {
				this.searchFlags.push('attachments')
			}
			this.$nextTick(() => {
				this.sendQueryEvent()
			})
		},

		toggleCurrentUser() {
			if (this.hasToMeActive) {
				this.searchInTo = []
			} else {
				this.searchInTo = [{
					email: this.account.emailAddress,
					label: this.account.emailAddress,
				}]
			}
			this.$nextTick(() => {
				this.sendQueryEvent()
			})
		},

		toggleUnread() {
			this.setUnread(!this.searchFlags.includes('unread'))
		},

		setUnread(enabled) {
			if (enabled === this.searchFlags.includes('unread')) {
				return
			}
			if (!enabled) {
				this.searchFlags = this.searchFlags.filter((flag) => flag !== 'unread')
			} else {
				this.searchFlags.push('unread')
			}
			this.$nextTick(() => {
				this.sendQueryEvent()
			})
		},

		prepareStart() {
			if (this.startDate !== null) {
				if (this.endDate !== null && this.startDate > this.endDate) {
					this.endDate = this.startDate
				}
				return moment(this.startDate).unix().toString()
			}
			return ''
		},

		prepareEnd() {
			return this.endDate !== null ? moment(this.endDate).add(1, 'days').unix().toString() : ''
		},

		closeSearchModal() {
			this.moreSearchActions = false
			this.match = 'allof'
			this.$nextTick(() => {
				this.sendQueryEvent()
			})
		},

		sendQueryEvent() {
			this.$emit('search-changed', this.searchQuery)
		},

		/**
		 * The same search again, now also asking for message bodies.
		 *
		 * Fires only once the box has been still for BODY_SEARCH_SETTLE_MS, so
		 * the IMAP round trip is paid for the question the user actually
		 * finished asking rather than for every prefix of it.
		 */
		sendBodySearchEvent() {
			// The box can have been cleared, or emptied below the minimum
			// length, while this was waiting to fire.
			if (!this.searchBody || this.query.length < 3) {
				return
			}
			this.searchInMessageBody = this.query
			this.sendQueryEvent()
		},

		searchRecipients(term) {
			if (term === undefined || term === '') {
				return
			}
			debouncedSearch(term).then((results) => {
				this.autocompleteRecipients = uniqBy('email')(this.autocompleteRecipients.concat(results))
			})
		},

		resetFilter() {
			this.match = 'allof'
			this.query = ''
			this.selectedTags = []
			this.moreSearchActions = false
			this.searchInFrom = []
			this.searchInTo = []
			this.searchInCc = []
			this.searchInBcc = []
			this.freeText = null
			this.searchInSubject = null
			this.searchInMessageBody = null
			this.searchFlags = []
			this.startDate = null
			this.endDate = null
			this.mentionsMe = false
			this.sendQueryEvent()
		},

		addTag(tag, type) {
			if (typeof tag === 'string') {
				tag = { email: tag, label: tag }
			}
			switch (type) {
				case 'to':
					this.searchInTo.push(tag)
					break
				case 'from':
					this.searchInFrom.push(tag)
					break
				case 'cc':
					this.searchInCc.push(tag)
					break
				case 'bcc':
					this.searchInBcc.push(tag)
					break
			}
		},

		removeTag(tag, type) {
			switch (type) {
				case 'to':
					this.searchInTo = this.removeAddress(tag, this.searchInTo)
					break
				case 'from':
					this.searchInFrom = this.removeAddress(tag, this.searchInFrom)
					break
				case 'cc':
					this.searchInCc = this.removeAddress(tag, this.searchInCc)
					break
				case 'bcc':
					this.searchInBcc = this.removeAddress(tag, this.searchInBcc)
					break
			}
		},

		removeAddress(tag, addresses) {
			return addresses.filter((address) => address.email !== tag.email)
		},
	},
}
</script>

<style lang="scss">
.search-messages {
	border-bottom: 1px solid var(--color-border);
	position: sticky;
	top: 0;
	z-index: 10;
	background-color: var(--color-main-background);
	&__input {
		min-height: 52px;
		margin-inline-start: calc(var(--app-navigation-padding) * 2 + var(--default-clickable-area));
		padding-inline-end: 3px; /* matches .app-content-list */
		position: relative;
		display: flex;
		align-items: center;
		//important info icon overlaps it while scrolling
		z-index: 1;

		input {
			flex-grow: 1;
		}

		.action-item--single {
			border: none;
			background: none;
			transition: 0.4s;
		}

		.action-item--single:hover {
			transition: 0.4s;
			background: var(--color-primary-element);
		}
	}
}

.search-input {
	width: 100%;
}

.checkbox-radio-switch__label {
	background: none !important;
	padding: 0 !important;
	margin: 0 !important;
}

.tag-group__search {
	box-sizing: border-box;
	position: relative;
	margin: 3px 3px;
	padding: 0 6px;
}

.tag-group__bg {
	position: absolute;
	inset-inline: 0;
	bottom: 0;
	top: 0;
	opacity: 0.4;
	border-radius: 14px;
	z-index: 1;
}

.tag-group__label {
	font-weight: bold;
	font-size: 12px;
	position: relative;
	z-index: 2;
}

.search-modal {
	.modal-inner--content {
		padding: 16px 0 36px 0;
		overflow-y: scroll;
		width: calc(100% - 2px);

		.marked-as .modal-inner-inline {
			display: inline-block;
			width: 50%;

		}
		.range {
			display: flex;
			flex-wrap: wrap;

			.modal-inner-inline {
				width: calc(50% - 5px);
				&:first-child {
					margin-inline-end: 5px;
				}
				&:last-child {
					margin-inline-start: 5px;
				}
			}
		}
	}
}
@media (max-width: 420px) {
	.modal-inner--container {
		width: 100%;
		flex-wrap: nowrap;
		flex-direction: column;
	}
}
@media (max-width: 420px) {
	.search-modal .modal-inner--content .range {
		flex-direction: row;
	}
}

.multiselect-search-tags {
	width: 100%;
}

.multiselect-search-tags .multiselect__tags .multiselect__tags-wrap {
	flex-wrap: wrap !important;
}

.modal-inner-field--right {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	padding: 0 33px;
	margin-top: 15px;
}

.modal-inner--field {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	justify-content: space-between;
	margin-bottom: 15px;
	padding: 0 12px 0 30px;

	.checkbox-radio-switch {
		margin: 0 8px 0 0;
	}

	& > label {
		font-weight: bold;
		width: 120px;
	}

	.modal-inner--container {
		width: calc(100% - 120px);
		display: flex;
		flex-wrap: wrap;

		.select {
			width: 100%;
		}
	}
}

.modal-wrapper--normal .modal-container {
	position: relative
}

.button-vue.search-messages--filter.button-vue--icon-only {
	position: absolute;
	width: auto;
	height: auto;
	z-index: 5;
	inset-inline-end: 7px; /* same spacing to the input border as top/bottom */
	inset-inline-start: auto;
	box-shadow: none !important;
	background: transparent !important;
	border: none !important;
	padding: 0 !important;
}

.button-vue.search-messages--close.button-vue--icon-only {
	position: absolute;
	width: auto;
	height: auto;
	z-index: 5;
	inset-inline-end: 35px;
	inset-inline-start: auto;
	box-shadow: none !important;
	background: transparent !important;
	border: none !important;
	padding: 0 !important;
}

.button-reset-filter {
	margin-inline-end: 10px;
}

.filter-changed {
	width: 6px;
	height: 6px;
	background: var(--color-error);
	position: absolute;
	z-index: 10;
	inset-inline-end: 12px;
	border-radius: 50%;
	top: 12px;
}

.mx-datepicker {
	width:100%;
}

.filter-buttons {
	display: flex;
	justify-content: center;
	align-items: center;
	flex-wrap: nowrap;
	gap: 4px;
	overflow: hidden;
	padding: 0 5px 5px 5px;
}
</style>
