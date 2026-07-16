/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DraggableEnvelope } from './draggable-envelope.js'

// A directive instance belongs to exactly one row element. The previous
// module-global array made every componentUpdated hook schedule a timer that
// walked and updated every loaded row: N row updates became N x N work, while
// the array also kept removed rows alive until unbind filtered it. WeakMap
// gives direct ownership without itself retaining detached elements.
const instancesByElement = new WeakMap()

function onBind(el, binding) {
	const instance = new DraggableEnvelope(el, binding.value)
	instancesByElement.set(el, instance)
}

function onUpdate(el, binding) {
	instancesByElement.get(el)?.update(binding.value)
}

function onUnbind(el) {
	const instance = instancesByElement.get(el)
	if (instance === undefined) {
		return
	}
	instance.removeListeners(el)
	instancesByElement.delete(el)
}

export const DraggableEnvelopeDirective = {
	// Vue 2
	bind: onBind,
	componentUpdated: onUpdate,
	unbind: onUnbind,
	// Vue 3
	mounted: onBind,
	updated: onUpdate,
	unmounted: onUnbind,
}

export default DraggableEnvelope
