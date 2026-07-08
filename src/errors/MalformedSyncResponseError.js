/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export default class MalformedSyncResponseError extends Error {
	constructor(message) {
		super(message)
		this.name = MalformedSyncResponseError.getName()
		this.message = message
	}

	static getName() {
		return 'MalformedSyncResponseError'
	}
}
