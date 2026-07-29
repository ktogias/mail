/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readdirSync, readFileSync } from 'fs'
import { extname, join, relative } from 'path'

// Raising a toast has exactly one owner: src/util/toast.js. Everything else
// imports show*() from there, never from @nextcloud/dialogs directly.
//
// The library defaults `close` to false, so before this rule a toast could
// only be got rid of by waiting it out -- and the ones carrying an Undo were
// the worst of it, since the user has to read, decide and travel to the button
// inside the window. Two call sites out of 46 had remembered to pass
// `close: true`. That is not a rule, it is a coincidence, and the 47th call
// site would not have remembered either.
//
// This test exists so the next direct import fails here instead of shipping a
// toast nobody can dismiss.
const SRC_DIR = join(process.cwd(), 'src')
const OWNER = join('util', 'toast.js')
// Raising a toast is one thing; the undo WINDOW is another, and it has its
// own owner. Everything undoable goes through deferWithUndo().
const UNDO_OWNER = join('service', 'UndoableAction.js')
const SCANNED_EXTENSIONS = new Set(['.js', '.vue', '.ts'])

// Only the toast-raising functions. TOAST_* are plain numbers and the dialog
// builders are a different feature; importing either straight from the library
// is fine and this must not pretend otherwise.
const FORBIDDEN = /import\s*\{[^}]*\bshow(?:Error|Success|Warning|Info|Undo)\b[^}]*\}\s*from\s*'@nextcloud\/dialogs'/

/**
 * @param {string} dir directory to walk
 * @return {string[]} absolute paths of every scanned source file, recursively
 */
function findSourceFiles(dir) {
	const results = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name)
		if (entry.isDirectory()) {
			results.push(...findSourceFiles(fullPath))
		} else if (SCANNED_EXTENSIONS.has(extname(entry.name))) {
			results.push(fullPath)
		}
	}
	return results
}

describe('Raising a toast has a single owner', () => {
	// Deliberately includes src/tests: a spec that mocks '@nextcloud/dialogs'
	// no longer intercepts anything, because production code does not call it
	// any more. Such a spec passes while asserting nothing, which is the
	// failure mode this whole file exists to prevent.
	const files = findSourceFiles(SRC_DIR)

	it('scans a plausible number of source files', () => {
		// Guards the guard: a broken walk would make the assertion below pass
		// vacuously.
		expect(files.length).toBeGreaterThan(100)
	})

	it('has nothing importing the show* helpers straight from @nextcloud/dialogs', () => {
		const offenders = []
		for (const file of files) {
			const relativePath = relative(SRC_DIR, file)
			if (relativePath === OWNER) {
				continue
			}
			const source = readFileSync(file, 'utf8')
			source.split('\n').forEach((line, index) => {
				if (FORBIDDEN.test(line)) {
					offenders.push(`${relativePath}:${index + 1} imports a toast helper directly; use util/toast.js`)
				}
			})
		}

		expect(offenders).toEqual([])
	})

	it('has one implementation of the undo window, not one per feature', () => {
		// Placement and the close button are generic because they are CSS and a
		// wrapper. The undo BEHAVIOUR is not automatic: hold-on-hover, the
		// single clock, swipe-to-dismiss and the hold cap all live in
		// deferWithUndo(), and anything calling showUndo() directly gets none
		// of them.
		//
		// outboxStore's "Sending message…" was exactly that -- a second copy
		// that had already drifted, running toastify's clock against its own
		// setTimeout so the two could not be paused together. It was found by
		// asking this question rather than by anyone noticing.
		const callers = []
		for (const file of files) {
			const relativePath = relative(SRC_DIR, file)
			if (relativePath === OWNER || relativePath === UNDO_OWNER || relativePath.startsWith('tests')) {
				continue
			}
			if (/\bshowUndo\s*\(/.test(readFileSync(file, 'utf8'))) {
				callers.push(`${relativePath} calls showUndo() directly; use deferWithUndo() from service/UndoableAction.js`)
			}
		}

		expect(callers).toEqual([])
	})

	it('keeps the owner defaulting every toast to dismissible', () => {
		const source = readFileSync(join(SRC_DIR, OWNER), 'utf8')

		// The default itself, and that a caller can still override it.
		expect(source).toContain('close: true, ...options')
		for (const fn of ['showSuccess', 'showError', 'showWarning', 'showInfo', 'showUndo']) {
			expect(source).toContain(`export function ${fn}(`)
		}
	})
})
