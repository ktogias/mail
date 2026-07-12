/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

describe('viewportPrefetchObserver', () => {
	// jsdom has no real IntersectionObserver -- stub a minimal fake that
	// records what it's asked to observe and lets tests dispatch
	// intersection changes manually, one shared instance per test
	// (mirrors how the module itself only ever creates one).
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
				instances.push(this)
			}

			observe(el) {
				this.observed.add(el)
			}

			unobserve(el) {
				this.observed.delete(el)
			}

			dispatch(el, isIntersecting) {
				this.callback([{ target: el, isIntersecting }])
			}
		}
		module = await import('../../../util/viewportPrefetchObserver.js')
	})

	afterEach(() => {
		delete global.IntersectionObserver
	})

	it('creates exactly one shared observer for any number of observed elements', () => {
		const elA = {}
		const elB = {}
		module.observeViewportVisibility(elA, vi.fn())
		module.observeViewportVisibility(elB, vi.fn())

		expect(instances).toHaveLength(1)
		expect(instances[0].observed.has(elA)).toBe(true)
		expect(instances[0].observed.has(elB)).toBe(true)
	})

	it('expands the observed area below the fold via rootMargin', () => {
		module.observeViewportVisibility({}, vi.fn())

		expect(instances[0].options.rootMargin).toBe('150px 0px')
	})

	it('dispatches intersection changes to the callback registered for that element', () => {
		const el = {}
		const callback = vi.fn()
		module.observeViewportVisibility(el, callback)

		instances[0].dispatch(el, true)
		expect(callback).toHaveBeenCalledWith(true)

		instances[0].dispatch(el, false)
		expect(callback).toHaveBeenCalledWith(false)
	})

	it('stops dispatching once unobserved', () => {
		const el = {}
		const callback = vi.fn()
		module.observeViewportVisibility(el, callback)
		module.unobserveViewportVisibility(el)

		expect(instances[0].observed.has(el)).toBe(false)
	})

	it('degrades to a no-op when IntersectionObserver does not exist (old browser or test env)', async () => {
		delete global.IntersectionObserver
		vi.resetModules()
		const noObserverModule = await import('../../../util/viewportPrefetchObserver.js')

		expect(() => {
			noObserverModule.observeViewportVisibility({}, vi.fn())
			noObserverModule.unobserveViewportVisibility({})
		}).not.toThrow()
	})

	describe('runIfViewportPrefetchSlotAvailable', () => {
		it('runs the function when under the concurrency cap', async () => {
			const fn = vi.fn().mockResolvedValue()

			await module.runIfViewportPrefetchSlotAvailable(fn)

			expect(fn).toHaveBeenCalled()
		})

		it('skips the function once the concurrency cap (2) is reached', async () => {
			let resolveFirst
			let resolveSecond
			const first = vi.fn(() => new Promise((resolve) => {
				resolveFirst = resolve
			}))
			const second = vi.fn(() => new Promise((resolve) => {
				resolveSecond = resolve
			}))
			const third = vi.fn().mockResolvedValue()

			const firstCall = module.runIfViewportPrefetchSlotAvailable(first)
			const secondCall = module.runIfViewportPrefetchSlotAvailable(second)
			await module.runIfViewportPrefetchSlotAvailable(third)

			expect(third).not.toHaveBeenCalled()

			resolveFirst()
			resolveSecond()
			await firstCall
			await secondCall
		})

		it('frees its slot once the function settles, even on rejection', async () => {
			const failing = vi.fn().mockRejectedValue(new Error('boom'))
			const succeeding = vi.fn().mockResolvedValue()

			await module.runIfViewportPrefetchSlotAvailable(failing).catch(() => {})
			await module.runIfViewportPrefetchSlotAvailable(succeeding)
			await module.runIfViewportPrefetchSlotAvailable(succeeding)
			await module.runIfViewportPrefetchSlotAvailable(succeeding)

			// Slot from the failing call was freed -- otherwise the cap
			// would have been permanently reduced by one.
			expect(succeeding).toHaveBeenCalledTimes(3)
		})
	})
})
