/**
 * SPDX-FileCopyrightText: 2018 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { translatePlural as n, translate as t } from '@nextcloud/l10n'
import { generateFilePath } from '@nextcloud/router'
import uniq from 'lodash/fp/uniq.js'
import Logger from '../logger.js'

/**
 * @todo use Notification.requestPermission().then once all browsers support promise API
 * @return {Promise}
 */
function request() {
	if (!('Notification' in window)) {
		Logger.info('browser does not support desktop notifications')
		return Promise.reject(new Error('browser does not support desktop notifications'))
	} else if (Notification.permission === 'granted') {
		return Promise.resolve()
	} else if (Notification.permission === 'denied') {
		Logger.info('desktop notifications are denied')
		return Promise.reject(new Error('desktop notifications are denied'))
	}

	Logger.info('requesting permissions to show desktop notifications')
	return Notification.requestPermission()
}

async function showNotification(title, body, icon, onClick) {
	try {
		await request()
	} catch (error) {
		// User denied permission
		return
	}

	// document.hasFocus(), not document.querySelector(':focus'): an element
	// can keep :focus while its window sits in the background, which would
	// wrongly swallow notifications for a backgrounded window. The previous
	// check also only ever logged -- it never returned, so the notification
	// was shown even in the window the user was actively reading.
	if (document.hasFocus()) {
		Logger.debug('browser is active. notification request is ignored')
		return
	}

	const notification = new Notification(title, {
		body,
		icon,
	})
	notification.onclick = () => {
		window.focus()
		if (onClick) {
			onClick()
		}
		// Close the notification when clicked
		notification.close()
	}
}

function getNotificationBody(messages) {
	const labels = messages.filter((m) => m.from.length > 0).map((m) => m.from[0].label)
	let from = uniq(labels)
	if (from.length > 2) {
		from = from.slice(0, 2)
		from.push('…')
	}

	// TODO: just use `n`?!
	if (messages.length === 1) {
		return t('mail', '{from}\n{subject}', {
			from: from.join(),
			subject: messages[0].subject,
		}, undefined, {
			escape: false,
			sanitize: false,
		})
	} else {
		return n('mail', '%n new message \nfrom {from}', '%n new messages \nfrom {from}', messages.length, {
			from: from.join(),
		})
	}
}

export function showNewMessagesNotification(messages) {
	showNotification(
		t('mail', 'Nextcloud Mail'),
		getNotificationBody(messages),
		generateFilePath('mail', 'img', 'mail-notification.png'),
		() => {
			// Clicking the notification focuses the window (see
			// showNotification) AND takes the user to the mail itself: the
			// thread view for a single new message, or the receiving
			// mailbox's listing when several arrived at once. All messages
			// in one notification share a mailbox, since notifications are
			// fired per mailbox as each one's own sync resolves.
			//
			// The router is imported lazily, only on an actual click: a
			// static import here would run router.js's module-level
			// Vue.use(Router) for everything that (transitively) imports
			// this service -- in the real app that's harmless (main.js
			// loads the router anyway, same module instance), but it
			// installs a plugin-defined $route on every Vue instance,
			// which shadows the $route mocks in component tests.
			const [first] = messages
			if (first?.mailboxId === undefined) {
				return
			}
			const target = messages.length === 1
				? { name: 'message', params: { mailboxId: first.mailboxId, threadId: first.databaseId } }
				: { name: 'mailbox', params: { mailboxId: first.mailboxId } }
			import('../router.js').then(({ default: router }) => router.push(target)).catch(() => {
				// NavigationDuplicated: already looking at it -- fine.
			})
		},
	)
}
