/**
 * SPDX-FileCopyrightText: 2021 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import { convertAxiosError } from '../errors/convert.js'
import { WorkClass } from './RequestCoordinator.js'

export async function deleteThread(id) {
	const url = generateUrl('/apps/mail/api/thread/{id}', {
		id,
	})

	try {
		return await axios.delete(url, {
			mailWorkClass: WorkClass.QUICK_MUTATION,
		})
	} catch (e) {
		throw convertAxiosError(e)
	}
}

export async function deleteThreads(ids) {
	const url = generateUrl('/apps/mail/api/threads')

	try {
		return await axios.delete(url, {
			data: { ids },
			mailWorkClass: WorkClass.QUICK_MUTATION,
		})
	} catch (e) {
		throw convertAxiosError(e)
	}
}

export async function moveThread(id, destMailboxId) {
	const url = generateUrl('/apps/mail/api/thread/{id}', {
		id,
	})

	try {
		return await axios.post(url, { destMailboxId }, {
			mailWorkClass: WorkClass.QUICK_MUTATION,
		})
	} catch (e) {
		throw convertAxiosError(e)
	}
}

export async function snoozeThread(id, unixTimestamp, destMailboxId) {
	const url = generateUrl('/apps/mail/api/thread/{id}/snooze', {
		id,
	})

	try {
		return await axios.post(url, { unixTimestamp, destMailboxId }, {
			mailWorkClass: WorkClass.QUICK_MUTATION,
		})
	} catch (e) {
		throw convertAxiosError(e)
	}
}

export async function unSnoozeThread(id) {
	const url = generateUrl('/apps/mail/api/thread/{id}/unsnooze', {
		id,
	})

	try {
		return await axios.post(url, {}, {
			mailWorkClass: WorkClass.QUICK_MUTATION,
		})
	} catch (e) {
		throw convertAxiosError(e)
	}
}
