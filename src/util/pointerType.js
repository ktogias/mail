/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Checked once at module load, not per-call -- a device's primary pointer
// type doesn't change mid-session. Guarded on matchMedia existing at all:
// jsdom (this codebase's test environment) doesn't implement it, and this
// must not throw during any existing test mount.
let coarsePointer = false
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
	coarsePointer = window.matchMedia('(pointer: coarse)').matches
}

/**
 * @return {boolean} true if the device's primary pointer is coarse
 *   (touch) rather than fine (mouse/trackpad) -- see the `pointer` media
 *   feature. Used to make the envelope row's actions button always-visible
 *   on touch instead of hover-gated, and is unrelated to viewport width
 *   (a touch laptop in a wide window is still coarse; a narrow desktop
 *   window is still fine).
 */
export function isCoarsePointer() {
	return coarsePointer
}
