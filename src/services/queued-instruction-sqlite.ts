/**
 * @module services/queued-instruction-sqlite
 * SQLite-backed queued instruction adapter.
 * Drop-in replacement for file-based queued-instruction.ts.
 * Uses pending_stops.queued_instruction column.
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import { type IpcError, ipcReadError, ipcWriteError } from '../types/errors'
import { type DbError, dbErrorMessage } from '../types/db'
import {
  findPendingStopBySession,
  updateQueuedInstruction,
} from './db-queries'
import { listActiveSessions } from './db-queries'
import { getDatabase } from './db'

export interface QueuedInstruction {
  readonly text: string
  readonly timestamp: string
}

/**
 * Resolve session ID from IPC directory path.
 * Path format: {ipcBaseDir}/{sessionId}
 */
const sessionIdFromDir = (ipcDir: string): string => {
  const parts = ipcDir.split('/')
  return parts[parts.length - 1] ?? ''
}

/**
 * Read the queued instruction for a session.
 * Returns null if no queued instruction exists.
 */
export const readQueuedInstruction = (
  ipcDir: string
): TE.TaskEither<IpcError, QueuedInstruction | null> =>
  TE.fromEither(
    (() => {
      const sessionId = sessionIdFromDir(ipcDir)
      const dbResult = getDatabase()
      if (E.isLeft(dbResult))
        return E.left(ipcReadError(ipcDir, new Error(dbErrorMessage(dbResult.left))))

      const psResult = findPendingStopBySession(dbResult.right, sessionId)
      if (E.isLeft(psResult))
        return E.left(ipcReadError(ipcDir, new Error(dbErrorMessage(psResult.left))))

      if (!psResult.right || !psResult.right.queued_instruction) return E.right(null)

      return E.right({
        text: psResult.right.queued_instruction,
        timestamp: psResult.right.created_at,
      } as QueuedInstruction)
    })()
  )

/**
 * Write a queued instruction for a session.
 * Finds the pending stop for the session and sets its queued_instruction.
 */
export const writeQueuedInstruction = (
  ipcDir: string,
  text: string
): TE.TaskEither<IpcError, void> =>
  TE.fromEither(
    (() => {
      const sessionId = sessionIdFromDir(ipcDir)
      const dbResult = getDatabase()
      if (E.isLeft(dbResult))
        return E.left(ipcWriteError(ipcDir, new Error(dbErrorMessage(dbResult.left))))

      const psResult = findPendingStopBySession(dbResult.right, sessionId)
      if (E.isLeft(psResult))
        return E.left(ipcWriteError(ipcDir, new Error(dbErrorMessage(psResult.left))))

      if (!psResult.right)
        return E.left(ipcWriteError(ipcDir, new Error('No pending stop for session')))

      const updateResult = updateQueuedInstruction(dbResult.right, psResult.right.event_id, text)
      if (E.isLeft(updateResult))
        return E.left(ipcWriteError(ipcDir, new Error(dbErrorMessage(updateResult.left))))

      return E.right(undefined)
    })()
  )

/**
 * Delete the queued instruction for a session.
 * Clears the queued_instruction column on the pending stop.
 */
export const deleteQueuedInstruction = (
  ipcDir: string
): TE.TaskEither<IpcError, void> =>
  TE.fromEither(
    (() => {
      const sessionId = sessionIdFromDir(ipcDir)
      const dbResult = getDatabase()
      if (E.isLeft(dbResult))
        return E.left(ipcWriteError(ipcDir, new Error(dbErrorMessage(dbResult.left))))

      const psResult = findPendingStopBySession(dbResult.right, sessionId)
      if (E.isLeft(psResult))
        return E.left(ipcWriteError(ipcDir, new Error(dbErrorMessage(psResult.left))))

      // No pending stop = nothing to clear, that's fine
      if (!psResult.right) return E.right(undefined)

      // Clear by setting to empty string (SQLite doesn't have a clean "null update" via our helper)
      const updateResult = updateQueuedInstruction(dbResult.right, psResult.right.event_id, '')
      if (E.isLeft(updateResult))
        return E.left(ipcWriteError(ipcDir, new Error(dbErrorMessage(updateResult.left))))

      return E.right(undefined)
    })()
  )
