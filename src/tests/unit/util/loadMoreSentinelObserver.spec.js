/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

describe('loadMoreSentinelObserver', () => {
	// jsdom has no real IntersectionObserver -- stub a minimal fake that
	// records what it's asked to observe and its constructor options, and
	// lets tests dispatch intersection changes manually.
	let instances
	let module

	beforeEach(async () => {
		vi.resetModules()
		instances = []
		global.IntersectionObserver = class {
			constructor(callback, options) {
				this.callback = callback
				this.options = options
				this.observed = new Set()
				this.disconnected = false
				instances.push(this)
			}

			observe(el) {
				this.observed.add(el)
			}

			disconnect() {
				this.disconnected = true
			}

			dispatch(el, isIntersecting) {
				this.callback([{ target: el, isIntersecting }])
			}
		}
		module = await import('../../../util/loadMoreSentinelObserver.js')
	})

	afterEach(() => {
		delete global.IntersectionObserver
	})

	// getScrollEventTarget() walks up looking for overflow-y:scroll/auto;
	// jsdom's getComputedStyle never reports that for any element in
	// these unit tests, so it always falls through to `window` here --
	// exercising the "no scrollable ancestor found" branch specifically.
	// The "found a real scrollable ancestor" branch is exactly
	// getScrollEventTarget()'s own, already-tested logic; this module
	// only needs to prove it wires that result into `root` correctly.
	it('observes the sentinel element', () => {
		const sentinel = document.createElement('div')

		module.observeLoadMoreSentinel(sentinel, vi.fn())

		expect(instances).toHaveLength(1)
		expect(instances[0].observed.has(sentinel)).toBe(true)
	})

	it('falls back to root: null when no scrollable ancestor is found (jsdom default)', () => {
		module.observeLoadMoreSentinel(document.createElement('div'), vi.fn())

		expect(instances[0].options.root).toBeNull()
	})

	it('expands the bottom margin by the given distance, defaulting to 300px', () => {
		module.observeLoadMoreSentinel(document.createElement('div'), vi.fn())

		expect(instances[0].options.rootMargin).toBe('0px 0px 300px 0px')
	})

	it('honors a custom distance', () => {
		module.observeLoadMoreSentinel(document.createElement('div'), vi.fn(), 150)

		expect(instances[0].options.rootMargin).toBe('0px 0px 150px 0px')
	})

	it('calls the callback when the sentinel starts intersecting', () => {
		const sentinel = document.createElement('div')
		const callback = vi.fn()
		module.observeLoadMoreSentinel(sentinel, callback)

		instances[0].dispatch(sentinel, true)

		expect(callback).toHaveBeenCalledTimes(1)
	})

	it('does not call the callback when the sentinel stops intersecting', () => {
		const sentinel = document.createElement('div')
		const callback = vi.fn()
		module.observeLoadMoreSentinel(sentinel, callback)

		instances[0].dispatch(sentinel, false)

		expect(callback).not.toHaveBeenCalled()
	})

	it('returns the observer so the caller can disconnect it later', () => {
		const observer = module.observeLoadMoreSentinel(document.createElement('div'), vi.fn())

		observer.disconnect()

		expect(instances[0].disconnected).toBe(true)
	})

	it('degrades to a no-op (returns null) when IntersectionObserver does not exist', async () => {
		delete global.IntersectionObserver
		vi.resetModules()
		const noObserverModule = await import('../../../util/loadMoreSentinelObserver.js')

		const result = noObserverModule.observeLoadMoreSentinel(document.createElement('div'), vi.fn())

		expect(result).toBeNull()
	})
})
