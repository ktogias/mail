/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

// Confirmed directly against the installed Vue 2.7 source
// (createLifeCycle()/onBeforeUnmount()/onUnmounted() in
// vue.runtime.esm.js): the Vue-3-style hook names beforeUnmount/
// unmounted are only aliased for the Composition API's onBeforeUnmount()/
// onUnmounted() *functions* -- they are not recognized Options API
// object keys at all. A component using `beforeUnmount() {}` or
// `unmounted() {}` directly (as opposed to `setup() { onBeforeUnmount(fn) }`)
// silently never has it called, ever. Found live in 13 components whose
// cleanup (event listeners, intervals, timeouts, observers) had
// therefore never run on unmount -- some accumulating for the lifetime
// of the whole session (one extra background sync interval per mailbox
// ever opened, one extra global click listener per attachment ever
// shown, ...). This test exists so a future component reintroducing the
// same mistake fails immediately instead of silently leaking.
const COMPONENTS_DIR = join(process.cwd(), 'src', 'components')

/**
 * @param {string} dir directory to walk
 * @return {string[]} absolute paths of every .vue file found, recursively
 */
function findVueFiles(dir) {
	const results = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name)
		if (entry.isDirectory()) {
			results.push(...findVueFiles(fullPath))
		} else if (entry.name.endsWith('.vue')) {
			results.push(fullPath)
		}
	}
	return results
}

describe('Vue Options API components never use the Composition-API-only lifecycle hook names', () => {
	const offendingPattern = /^\s*(async\s+)?(beforeUnmount|unmounted)\s*\(/m

	for (const path of findVueFiles(COMPONENTS_DIR)) {
		const relativePath = path.slice(process.cwd().length + 1)

		it(`${relativePath} does not define beforeUnmount()/unmounted() as an Options API hook`, () => {
			const content = readFileSync(path, 'utf-8')
			const scriptMatch = content.match(/<script[^>]*>([\s\S]*?)<\/script>/)
			if (!scriptMatch) {
				return
			}

			expect(scriptMatch[1]).not.toMatch(offendingPattern)
		})
	}
})
