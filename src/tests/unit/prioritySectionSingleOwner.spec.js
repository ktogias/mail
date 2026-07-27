/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readdirSync, readFileSync } from 'fs'
import { extname, join, relative } from 'path'

// "Which Priority section does this belong to", and its unread counterpart,
// have exactly one owner: src/util/priorityInbox.js. Everything else calls
// classifyPrioritySection()/threadCarriesFlag()/threadIsUnread().
//
// Before that rule existed the same reading was written out verbatim four
// times in mainStore/actions.js alone, beside four separate classifiers, and
// once more by hand in Envelope.vue -- where it had already drifted, treating
// a missing `seen` as unread and consulting the thread aggregate even in the
// flat view. Three releases in a row (.25 list membership, .26 thread
// aggregates, .28 counters) corrected that one decision at a different layer,
// each found only when a screenshot exposed the disagreement.
//
// This test exists so the next copy fails here instead.
const SRC_DIR = join(process.cwd(), 'src')
const OWNER = join('util', 'priorityInbox.js')
const SCANNED_EXTENSIONS = new Set(['.js', '.vue', '.ts'])

// Reading a thread aggregate straight off a flags object. Plumbing an
// authoritative value the server just sent (`response.hasUnseenInThread`,
// restoring a saved `oldState.hasUnseenInThread`) is not this -- that is
// transport, not a decision, and carries no `??` fallback of its own.
const FORBIDDEN = [
	{
		pattern: /has(?:Unseen|Flagged|Important)InThread\s*\?\?/,
		reason: 'derives thread-wide state inline; call threadCarriesFlag()/threadIsUnread() instead',
	},
	{
		// The other half of the same rule: which LIST KEY a section reads.
		// appendToSearch() concatenates the token onto the search query and
		// omits the `not:starred` partition that priorityInboxSectionQueries()
		// adds when favourites are sorted separately, so a component composing
		// its own key reads a list nothing publishes into. Live on
		// 2026-07-27: Important rendered "No messages" under a header reading
		// "2 unread of 130".
		pattern: /appendToSearch\(\s*(?:this\.)?(?:priorityImportantQuery|priorityOtherQuery|favoriteQuery)\s*\)/,
		reason: 'composes a Priority section list key by hand; use priorityInboxSectionQueries() instead',
	},
]

/**
 * @param {string} dir directory to walk
 * @return {string[]} absolute paths of every scanned source file, recursively
 */
function findSourceFiles(dir) {
	const results = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === 'tests') {
				continue
			}
			results.push(...findSourceFiles(fullPath))
		} else if (SCANNED_EXTENSIONS.has(extname(entry.name))) {
			results.push(fullPath)
		}
	}
	return results
}

describe('Priority section classification has a single owner', () => {
	const files = findSourceFiles(SRC_DIR)

	it('scans a plausible number of source files', () => {
		// Guards the guard: a broken walk would make every assertion below
		// pass vacuously.
		expect(files.length).toBeGreaterThan(100)
	})

	it('has no inline derivation of thread-wide flag state outside the owner', () => {
		const offenders = []
		for (const file of files) {
			const relativePath = relative(SRC_DIR, file)
			if (relativePath === OWNER) {
				continue
			}
			const source = readFileSync(file, 'utf8')
			source.split('\n').forEach((line, index) => {
				// Comments explaining the rule are not violations of it.
				const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
				FORBIDDEN.forEach(({ pattern, reason }) => {
					if (pattern.test(code)) {
						offenders.push(`${relativePath}:${index + 1} ${reason}`)
					}
				})
			})
		}

		expect(offenders).toEqual([])
	})

	it('keeps the owner exporting the three primitives everything else depends on', () => {
		const source = readFileSync(join(SRC_DIR, OWNER), 'utf8')

		expect(source).toContain('export function threadCarriesFlag(')
		expect(source).toContain('export function threadIsUnread(')
		expect(source).toContain('export function classifyPrioritySection(')
	})
})
