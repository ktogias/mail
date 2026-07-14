/**
 * SPDX-FileCopyrightText: 2020 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { translate as t } from '@nextcloud/l10n'
import logger from '../../../logger.js'
import { deferWithUndo } from '../../../service/UndoableAction.js'
import dragEventBus from '../util/dragEventBus.js'

export class DroppableMailbox {
	constructor(el, options) {
		this.el = el
		this.options = options
		this.mainStore = options.mainStore

		// Store bound references so removeListeners can use the same
		// function references that were passed to addEventListener/on
		this._onDragStart = this.onDragStart.bind(this)
		this._onDragEnd = this.onDragEnd.bind(this)
		this._onDragOver = this.onDragOver.bind(this)
		this._onDragLeave = this.onDragLeave.bind(this)
		this._onDrop = this.onDrop.bind(this)

		this.registerListeners(el)
		this.setInitialAttributes()
	}

	setInitialAttributes() {
		this.draggableInfo = {}
		this.setStatus('enabled')
	}

	registerListeners(el) {
		dragEventBus.on('drag-start', this._onDragStart)
		dragEventBus.on('drag-end', this._onDragEnd)

		// event listeners need to be attached to the first child element
		// (a button or an anchor tag) instead of the root el, because there
		// can be sub-mailboxes within the root element of the directive
		el.firstChild.addEventListener('dragover', this._onDragOver)
		el.firstChild.addEventListener('dragleave', this._onDragLeave)
		el.firstChild.addEventListener('drop', this._onDrop)
	}

	removeListeners(el) {
		dragEventBus.off('drag-start', this._onDragStart)
		dragEventBus.off('drag-end', this._onDragEnd)

		el.firstChild.removeEventListener('dragover', this._onDragOver)
		el.firstChild.removeEventListener('dragleave', this._onDragLeave)
		el.firstChild.removeEventListener('drop', this._onDrop)
	}

	setStatus(status) {
		this.el.setAttribute('droppable-mailbox', status)
	}

	onDragStart(draggableInfo) {
		this.draggableInfo = draggableInfo

		if (!this.canBeDropped()) {
			this.setStatus('disabled')
		}
	}

	canBeDropped() {
		return this.isSameAccount() && this.options.isValidDropTarget
	}

	isSameAccount() {
		return this.draggableInfo.accountId === this.options.accountId
	}

	/**
	 * Is the user currently dragging a valid object?
	 *
	 * @return {boolean}
	 */
	get isCurrentlyDragging() {
		return Object.keys(this.draggableInfo).length > 0
	}

	onDragEnd() {
		this.setInitialAttributes()
	}

	onDragOver(event) {
		if (!this.isCurrentlyDragging || !this.canBeDropped()) {
			return
		}

		event.preventDefault()

		// Prevent dropping into current folder
		if (this.draggableInfo.mailboxId === this.options.mailboxId) {
			return
		}

		if (this.options.isValidDropTarget) {
			this.setStatus('dragover')
		}

		event.dataTransfer.dropEffect = 'move'
	}

	onDragLeave(event) {
		if (!this.isCurrentlyDragging || !this.canBeDropped()) {
			return
		}

		event.preventDefault()
		this.setStatus('enabled')
	}

	async onDrop(event) {
		if (!this.isCurrentlyDragging || !this.canBeDropped()) {
			return
		}

		event.preventDefault()

		// Prevent dropping into current folder
		if (this.draggableInfo.mailboxId === this.options.mailboxId) {
			return
		}

		this.setInitialAttributes()
		const envelopesBeingDragged = JSON.parse(event.dataTransfer.getData('text'))
		dragEventBus.emit('envelopes-dropped', { envelopes: envelopesBeingDragged })

		try {
			const processedEnvelopes = envelopesBeingDragged.map(async (envelope) => {
				const processed = await this.processDroppedItem(envelope)
				return processed
			})
			await Promise.all(processedEnvelopes)
		} catch (error) {
			logger.error('could not process dropped messages', error)
		} finally {
			dragEventBus.emit('envelopes-moved', {
				mailboxId: this.options.mailboxId,
				movedEnvelopes: envelopesBeingDragged,
			})
		}
	}

	async processDroppedItem(envelope) {
		const item = document.querySelector(`[data-envelope-id="${envelope.databaseId}"]`)
		item.setAttribute('draggable-envelope', 'pending')

		// Not a Vue component -- this is a plain class instantiated by
		// the directive binding, so it can't use UndoableActionMixin at
		// all. deferWithUndo() (../../../service/UndoableAction.js) is
		// the same mechanism's non-Vue core: an undo toast, then the
		// real move only if it wasn't clicked, same as every other
		// delete/archive/junk/move action in this app now gets. Unlike
		// those, there's no list this directive owns to hide the row
		// from immediately -- the existing draggable-envelope="pending"
		// attribute (already set above) is this path's own "something
		// is happening" signal for the duration of the undo window.
		try {
			await deferWithUndo({
				message: t('mail', 'Message moved'),
				action: async () => {
					if (this.mainStore.getPreference('layout-message-view') === 'threaded') {
						await this.mainStore.moveThread({
							envelope,
							destMailboxId: this.options.mailboxId,
						})
					} else {
						await this.mainStore.moveMessage({
							id: envelope.databaseId,
							destMailboxId: this.options.mailboxId,
						})
					}
				},
			})
		} catch (error) {
			logger.error('could not move messages', error)
		} finally {
			item.removeAttribute('draggable-envelope')
		}
	}
}
