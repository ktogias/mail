<!--
  - SPDX-FileCopyrightText: 2018 Nextcloud GmbH and Nextcloud contributors
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="html-message-body">
		<MdnRequest :message="message" />
		<NeedsTranslationInfo
			v-if="needsTranslation"
			:is-html="true"
			@translate="$emit('translate')" />
		<div v-if="hasBlockedContent" id="mail-message-has-blocked-content" style="color: #000000">
			{{ t('mail', 'The images have been blocked to protect your privacy.') }}
			<Actions type="tertiary" :menu-name="t('mail', 'Show images')">
				<ActionButton @click="displayIframe">
					<template #icon>
						<IconImage :size="20" />
					</template>
					{{ t('mail', 'Show images temporarily') }}
				</ActionButton>
				<ActionButton
					v-if="sender"
					@click="onShowBlockedContent">
					<template #icon>
						<IconMail :size="20" />
					</template>
					{{ t('mail', 'Always show images from {sender}', { sender }) }}
				</ActionButton>
				<ActionButton
					v-if="domain"
					@click="onShowBlockedContentForDomain">
					<template #icon>
						<IconDomain :size="20" />
					</template>
					{{ t('mail', 'Always show images from {domain}', { domain }) }}
				</ActionButton>
			</Actions>
		</div>
		<div id="message-container" :class="{ scroll: !fullHeight }">
			<iframe
				ref="iframe"
				class="message-frame"
				:title="t('mail', 'Message frame')"
				:src="url"
				seamless
				@load="onMessageFrameLoad" />
		</div>
	</div>
</template>

<script>
import { loadState } from '@nextcloud/initial-state'
import { NcActionButton as ActionButton, NcActions as Actions } from '@nextcloud/vue'
import PrintScout from 'printscout'
import IconDomain from 'vue-material-design-icons/Domain.vue'
import IconMail from 'vue-material-design-icons/EmailOutline.vue'
import IconImage from 'vue-material-design-icons/ImageSizeSelectActual.vue'
import MdnRequest from './MdnRequest.vue'
import NeedsTranslationInfo from './NeedsTranslationInfo.vue'
import logger from '../logger.js'
import { needsTranslation } from '../service/AiIntergrationsService.js'
import { trustSender } from '../service/TrustedSenderService.js'

const scout = new PrintScout()

export default {
	name: 'MessageHTMLBody',
	components: {
		MdnRequest,
		NeedsTranslationInfo,
		Actions,
		ActionButton,
		IconImage,
		IconMail,
		IconDomain,
	},

	props: {
		url: {
			type: String,
			required: true,
		},

		fullHeight: {
			type: Boolean,
			required: false,
			default: false,
		},

		message: {
			required: true,
			type: Object,
		},
	},

	data() {
		return {
			hasBlockedContent: false,
			isSenderTrusted: this.message.isSenderTrusted,
			needsTranslation: false,
			enabledFreePrompt: loadState('mail', 'llm_freeprompt_available', false),
			printOriginalHeight: null,
		}
	},

	computed: {
		sender() {
			return this.message.from[0]?.email
		},

		domain() {
			return this.sender?.split('@').pop()
		},
	},

	beforeMount() {
		scout.on('beforeprint', this.onBeforePrint)
		scout.on('afterprint', this.onAfterPrint)
	},

	async mounted() {
		if (this.enabledFreePrompt && this.message) {
			this.needsTranslation = await needsTranslation(this.message.databaseId)
		}
	},

	beforeDestroy() {
		// NOT beforeUnmount(): in this project's Vue 2.7, the Vue-3-style
		// hook names are only aliased for the Composition API's
		// onBeforeUnmount()/onUnmounted() functions (see createLifeCycle()
		// in vue.runtime.esm.js), not recognized as Options API object
		// keys -- a component using beforeUnmount()/unmounted() here
		// would silently never have it called at all. Confirmed directly
		// against the installed Vue source, not just empirically.
		scout.off('beforeprint', this.onBeforePrint)
		scout.off('afterprint', this.onAfterPrint)
		this.resizeObserver?.disconnect()
	},

	methods: {
		getIframeDoc() {
			const iframe = this.$refs.iframe
			return iframe.contentDocument || iframe.contentWindow.document
		},

		onMessageFrameLoad() {
			const iframeDoc = this.getIframeDoc()
			this.hasBlockedContent
				= iframeDoc.querySelectorAll('[data-original-src]').length > 0
					|| iframeDoc.querySelectorAll('[data-original-style]').length > 0
					|| iframeDoc.querySelectorAll('style[data-original-content]').length > 0

			// Message HTML is same-origin (served from this app's own API,
			// not a genuinely cross-origin iframe), so there's no need for
			// iframe-resizer's whole postMessage-based child/parent
			// handshake at all -- a ResizeObserver on the iframe's own
			// body, set up directly from here, reports every layout change
			// (initial render, images finishing loading whether blocked or
			// not, web fonts, anything) automatically and continuously.
			// This replaced three separate manual nudges that were each
			// patching one specific trigger the handshake-based approach
			// missed: the initial handshake race, images unblocked by a
			// "Show images" click, and non-blocked images still loading
			// asynchronously through the image proxy when `load` fired.
			this.resizeObserver?.disconnect()
			this.resizeObserver = new ResizeObserver(() => {
				// scrollHeight, not entries[0].contentRect.height: the
				// injected html-response.css sets `html { overflow-y:
				// hidden }` (to avoid a double scrollbar alongside
				// #message-container's own), and contentRect reports the
				// body's own laid-out box, which can under-report once any
				// ancestor in the chain clips overflow -- confirmed live,
				// content was still cut off using contentRect even with
				// only the blocked-image placeholder showing (no
				// real-image loading involved at all, ruling out a timing
				// race). scrollHeight explicitly measures the full
				// content including anything clipped, same measurement
				// onBeforePrint() below already uses successfully.
				this.$refs.iframe.style.height = `${iframeDoc.body.scrollHeight}px`
			})
			this.resizeObserver.observe(iframeDoc.body)

			this.$emit('load')
			if (this.isSenderTrusted) {
				this.displayIframe()
			}
		},

		onBeforePrint() {
			const iframe = this.$refs.iframe
			this.printOriginalHeight = iframe.style.height
			iframe.style.setProperty('height', `${this.getIframeDoc().body.scrollHeight}px`, 'important')
		},

		onAfterPrint() {
			if (this.printOriginalHeight !== null) {
				this.$refs.iframe.style.height = this.printOriginalHeight
				this.printOriginalHeight = null
			}
		},

		displayIframe() {
			const iframeDoc = this.getIframeDoc()
			logger.debug('showing external images')
			iframeDoc.querySelectorAll('[data-original-src]').forEach((node) => {
				node.style.display = null
				node.setAttribute('src', node.getAttribute('data-original-src'))
			})
			iframeDoc
				.querySelectorAll('[data-original-style]')
				.forEach((node) => node.setAttribute('style', node.getAttribute('data-original-style')))
			iframeDoc
				.querySelectorAll('style[data-original-content]')
				.forEach((node) => {
					node.innerHTML = node.getAttribute('data-original-content')
				})
			this.hasBlockedContent = false
		},

		async onShowBlockedContent() {
			this.displayIframe()
			await trustSender(this.message.from[0].email, 'individual', true)
		},

		async onShowBlockedContentForDomain() {
			this.displayIframe()
			// TODO: there might be more than one @ in an email address
			await trustSender(this.domain, 'domain', true)
		},
	},
}
</script>

<style lang="scss" scoped>
// account for 12px (was 8) margin on iframe body
// should be 12px so it maches the rest of the content
.html-message-body {
	margin : 2px calc(var(--default-grid-baseline) * 3) 0 calc(var(--default-grid-baseline) * 14);
	background-color: #FFFFFF;
	border-radius: var(--border-radius-element);

	@media (max-width: 600px) {
        margin-inline: calc(var(--default-grid-baseline) * 3);
    }
}

#mail-message-has-blocked-content {
	margin-inline-start: 10px;
	color: var(--color-text-maxcontrast) !important;
	padding-top: 5px;
}

#message-container {
	flex: 1;
	display: flex;
	background-color: #FFFFFF;
	border-radius: var(--border-radius-element);

	// TODO: collapse quoted text and remove inner scrollbar
	@media only screen {
		&.scroll {
			overflow-y: auto;
		}
	}
}

:deep(.button-vue__text) {
	border: none !important;
	font-weight: normal !important;
	padding-inline: 14px 10px !important;
	text-decoration: underline !important;
}

.message-frame {
	width: 100%;
	border-radius: var(--border-radius-element);
	// Fallback for the brief window between the iframe's `load` event
	// and the ResizeObserver's first callback (fires on the next paint,
	// not synchronously): without an explicit height, the browser
	// default for an unsized <iframe> is ~150px, and content past that
	// point is simply not visible in #message-container's own scroll
	// area.
	min-height: 300px;
}

:deep(.button-vue__icon) {
	display: none !important;
}

:deep(.button-vue--vue-tertiary) {
	color: var(--color-text-maxcontrast);
}
</style>
