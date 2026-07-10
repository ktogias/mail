<!--
  - SPDX-FileCopyrightText: 2018 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<NcAvatar
		v-if="loading || !hasAvatar"
		:display-name="safeDisplayName"
		:size="size"
		:disable-tooltip="disableTooltip" />
	<NcAvatar
		v-else
		:display-name="safeDisplayName"
		:url="avatarUrl"
		:size="size"
		:disable-tooltip="disableTooltip" />
</template>

<script>
import { generateUrl } from '@nextcloud/router'
import NcAvatar from '@nextcloud/vue/components/NcAvatar'
import logger from '../logger.js'
import { fetchAvatarUrlMemoized } from '../service/AvatarService.js'

export default {
	name: 'Avatar',
	components: {
		NcAvatar,
	},

	props: {
		displayName: {
			type: String,
			required: true,
		},

		avatar: {
			type: Object,
			default: null,
		},

		fetchAvatar: {
			type: Boolean,
			default: false,
		},

		email: {
			type: String,
			required: true,
		},

		disableTooltip: {
			type: Boolean,
			default: false,
		},

		size: {
			type: Number,
			default: 40,
		},
	},

	data() {
		return {
			loading: true,
			avatarUrl: undefined,
		}
	},

	computed: {
		hasAvatar() {
			return this.avatarUrl !== undefined
		},

		safeDisplayName() {
			// NcAvatar's initials computation crashes with "RangeError:
			// NaN is not a valid code point" when the name, filtered down
			// to letters/digits/whitespace, ends with a space: it reads
			// codePointAt(lastIndexOf(' ') + 1), one past the end. Any
			// sender display name ending in emoji or symbols after a
			// space ("John 🙂", "SALE %%") hits this -- common in
			// newsletters, and a render error in one list item breaks the
			// whole envelope list's patch. Strip trailing non-letter/
			// non-digit characters so the filtered form always ends in a
			// letter or digit.
			for (const candidate of [this.displayName, this.email]) {
				const stripped = (candidate ?? '').replace(/[^\p{L}\p{N}]+$/u, '').trim()
				if (stripped !== '') {
					return stripped
				}
			}
			return '?'
		},
	},

	async mounted() {
		if (this.avatar) {
			this.avatarUrl = this.avatar.isExternal
				? generateUrl('/apps/mail/api/avatars/image/{email}', {
						email: this.email,
					})
				: this.avatar.url
		} else if (this.fetchAvatar) {
			if (this.email !== '') {
				try {
					this.avatarUrl = await fetchAvatarUrlMemoized(this.email)
				} catch {
					logger.debug('Could not fetch avatar', { email: this.email })
				}
			}
		}
		this.loading = false
	},
}
</script>
