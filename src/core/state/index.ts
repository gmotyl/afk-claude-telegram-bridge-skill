import * as E from 'fp-ts/Either'
import { State, Slot } from '../../types/state'

export type StateError =
  | { readonly _tag: 'SlotAlreadyActive'; readonly slotNum: number }
  | { readonly _tag: 'InvalidSlotNumber'; readonly slotNum: number }

/**
 * Check if a slot is still active (not timed out)
 * Pure function: returns boolean based on slot, timeout, and current time
 */
export const isSlotActive = (
  slot: Slot | undefined,
  timeoutMs: number,
  now: Date
): boolean => {
  if (!slot) return false
  const elapsed = now.getTime() - slot.lastHeartbeat.getTime()
  return elapsed < timeoutMs
}

/**
 * Add a new slot to state
 * Returns Either<StateError, State> for validation failures
 */
export const addSlot = (
  state: State,
  slotNum: number,
  slot: Slot
): E.Either<StateError, State> => {
  // Validate slot number
  if (slotNum < 1 || slotNum > 4) {
    return E.left({ _tag: 'InvalidSlotNumber', slotNum })
  }

  // Check if slot already active
  if (state.slots[slotNum] !== undefined) {
    return E.left({ _tag: 'SlotAlreadyActive', slotNum })
  }

  // Create new state (immutable)
  return E.right({
    slots: {
      ...state.slots,
      [slotNum]: slot
    }
  })
}

/**
 * Remove a slot from state
 * Always succeeds (idempotent)
 */
export const removeSlot = (state: State, slotNum: number): State => ({
  slots: {
    ...state.slots,
    [slotNum]: undefined
  }
})

/**
 * Update heartbeat timestamp for a slot
 */
export const heartbeatSlot = (
  state: State,
  slotNum: number,
  now: Date
): E.Either<StateError, State> => {
  const slot = state.slots[slotNum]
  if (!slot) {
    return E.left({ _tag: 'SlotAlreadyActive', slotNum })
  }

  return E.right({
    slots: {
      ...state.slots,
      [slotNum]: {
        ...slot,
        lastHeartbeat: now
      }
    }
  })
}

/**
 * Remove all slots that have timed out
 */
export const cleanupStaleSlots = (
  state: State,
  timeoutMs: number,
  now: Date
): State => {
  const cleaned: Record<number, Slot | undefined> = {}

  Object.entries(state.slots).forEach(([key, slot]) => {
    const slotNum = parseInt(key, 10)
    cleaned[slotNum] = isSlotActive(slot, timeoutMs, now) ? slot : undefined
  })

  return { slots: cleaned }
}
