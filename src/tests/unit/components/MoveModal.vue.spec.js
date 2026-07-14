/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createLocalVue, shallowMount } from '@vue/test-utils'
import MoveModal from '../../../components/MoveModal.vue'
import Nextcloud from '../../../mixins/Nextcloud.js'

const localVue = createLocalVue()
localVue.mixin(Nextcloud)

describe('MoveModal', () => {
	// The actual move used to happen inside this modal itself (with its
	// own "Moving..." spinner) before emitting 'move' once it was
	// already done. Now it emits request-move immediately and closes,
	// leaving the real, deferred, undoable move to whichever component
	// opened this modal (EnvelopeList.vue or Thread.vue).
	function mountMoveModal(propsOverride = {}) {
		return shallowMount(MoveModal, {
			propsData: {
				account: { id: 4 },
				envelopes: [
					{ databaseId: 1, mailboxId: 10 },
					{ databaseId: 2, mailboxId: 11 },
				],
				moveThread: true,
				...propsOverride,
			},
			localVue,
		})
	}

	it('emits request-move with only the envelopes not already at the destination, then closes', () => {
		const view = mountMoveModal()

		view.setData({ destMailboxId: 11 })
		view.vm.onMove()

		expect(view.emitted()['request-move'][0]).toEqual([{
			envelopes: [{ databaseId: 1, mailboxId: 10 }],
			destMailboxId: 11,
			moveThread: true,
		}])
		expect(view.emitted().close).toBeTruthy()
	})

	it('does not emit request-move at all if every envelope is already at the destination', () => {
		const view = mountMoveModal({
			envelopes: [{ databaseId: 1, mailboxId: 11 }],
		})

		view.setData({ destMailboxId: 11 })
		view.vm.onMove()

		expect(view.emitted()['request-move']).toBeFalsy()
		expect(view.emitted().close).toBeTruthy()
	})

	it('closes immediately -- does not wait for the real move to happen before emitting close', () => {
		const view = mountMoveModal()

		view.setData({ destMailboxId: 11 })
		view.vm.onMove()

		// Synchronous: no await needed to see 'close' already emitted.
		expect(view.emitted().close).toBeTruthy()
	})
})
