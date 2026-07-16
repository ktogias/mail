/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TOAST_UNDO_TIMEOUT } from '@nextcloud/dialogs'

export const UNIFIED_ACCOUNT_ID = 0
export const UNIFIED_INBOX_ID = 'unified'
export const PRIORITY_INBOX_ID = 'priority'
export const FOLLOW_UP_MAILBOX_ID = 'follow-up'
export const PAGE_SIZE = 20
// How long a mailbox list's tail can sit scrolled-past-and-forgotten before
// it's eligible for idle trimming (see IdleTailTrimMixin.js). Activity at the
// head deliberately does not reset this clock: returning there and continuing
// normal mailbox work is the exact case where the old deep tail should expire.
export const IDLE_TRIM_MS = 12 * 60 * 1000
// How many envelopes an idle-trimmed list keeps at its head. Well above a
// typical viewport (roughly 15-20 rows) so ordinary scrolling never bumps
// against the boundary; scrolling back down past this point simply re-runs
// the existing forward pagination, the same as a fresh, first-time load.
export const ENVELOPE_LIST_BASELINE_SIZE = 100
export const UNDO_DELAY = TOAST_UNDO_TIMEOUT
export const EDITOR_MODE_HTML = 'richtext'
export const EDITOR_MODE_TEXT = 'plaintext'
export const STATUS_RAW = 0
export const STATUS_IMAP_SENT_MAILBOX_FAIL = 11
export const STATUS_SMTP_ERROR = 13

export const FOLLOW_UP_TAG_LABEL = '$follow_up'
export const IMPORTANT_TAG_LABEL = '$label1'
