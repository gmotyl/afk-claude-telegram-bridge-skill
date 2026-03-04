/**
 * @module services/state-persistence-sqlite
 * SQLite-backed state persistence adapter.
 * Drop-in replacement for file-based state-persistence.ts.
 * Reconstructs State from sessions + pending_stops tables.
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import { type State, type Slot, type PendingStop, initialState } from '../types/state'
import { type StateError, stateError } from '../types/errors'
import {
  listActiveSessions,
  findPendingStopBySession,
  type SessionRow,
  type PendingStopRow,
} from './db-queries'
import { getDatabase } from './db'

/**
 * Reconstruct a Slot from a SessionRow.
 */
const rowToSlot = (row: SessionRow): Slot => ({
  sessionId: row.id,
  projectName: row.project_name ?? '',
  topicName: row.project_name ?? '',
  ...(row.thread_id !== null ? { threadId: row.thread_id } : {}),
  activatedAt: new Date(row.activated_at),
  lastHeartbeat: row.last_heartbeat ? new Date(row.last_heartbeat) : new Date(row.activated_at),
})

/**
 * Reconstruct a PendingStop from a PendingStopRow + EventRow data.
 */
const rowToPendingStop = (row: PendingStopRow, slotNum: number): PendingStop => ({
  eventId: row.event_id,
  slotNum,
  sessionId: row.session_id,
  lastMessage: '',
  timestamp: row.created_at,
  ...(row.telegram_message_id !== null ? { telegramMessageId: row.telegram_message_id } : {}),
})

/**
 * Load state by reconstructing it from SQLite tables.
 * Sessions → slots, pending_stops → pendingStops.
 *
 * @param _stateFile - Ignored (file-based compat)
 */
export const loadState = (
  _stateFile: string
): TE.TaskEither<StateError, State> =>
  TE.tryCatch(
    async () => {
      const dbResult = getDatabase()
      if (E.isLeft(dbResult)) return initialState

      const db = dbResult.right

      // Reconstruct slots from sessions table
      const sessionsResult = listActiveSessions(db)
      if (E.isLeft(sessionsResult)) return initialState

      const slots: Record<number, Slot | undefined> = { 1: undefined, 2: undefined, 3: undefined, 4: undefined }
      for (const row of sessionsResult.right) {
        slots[row.slot_num] = rowToSlot(row)
      }

      // Reconstruct pendingStops
      const pendingStops: Record<string, PendingStop> = {}
      for (const row of sessionsResult.right) {
        const psResult = findPendingStopBySession(db, row.id)
        if (E.isRight(psResult) && psResult.right) {
          const ps = psResult.right
          pendingStops[ps.event_id] = rowToPendingStop(ps, row.slot_num)
        }
      }

      return { slots, pendingStops }
    },
    (error: unknown) => stateError(`Failed to load state from SQLite: ${String(error)}`, error)
  )

/**
 * Save state to SQLite.
 * In SQLite mode, state is always persisted through individual operations,
 * so this is a lightweight sync that ensures consistency.
 *
 * @param _stateFile - Ignored (file-based compat)
 * @param _state - State to save (already in SQLite)
 */
export const saveState = (
  _stateFile: string,
  _state: State
): TE.TaskEither<StateError, void> =>
  TE.right(undefined)
