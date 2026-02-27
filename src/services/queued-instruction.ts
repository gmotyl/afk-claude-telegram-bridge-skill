/**
 * @module services/queued-instruction
 * Manages a queued instruction file for buffering Telegram messages
 * that arrive while Claude is busy (no pending stop).
 */

import * as TE from 'fp-ts/TaskEither'
import * as fs from 'fs/promises'
import * as path from 'path'
import {
  type IpcError,
  ipcReadError,
  ipcWriteError
} from '../types/errors'

export interface QueuedInstruction {
  readonly text: string
  readonly timestamp: string
}

/**
 * Read the queued instruction file.
 * Returns null if no queued instruction exists.
 */
export const readQueuedInstruction = (
  ipcDir: string
): TE.TaskEither<IpcError, QueuedInstruction | null> => {
  const filePath = path.join(ipcDir, 'queued_instruction.json')
  return TE.tryCatch(
    async () => {
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        return JSON.parse(content) as QueuedInstruction
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT') {
          return null
        }
        throw error
      }
    },
    (error: unknown) => ipcReadError(filePath, error)
  )
}

/**
 * Write a queued instruction file.
 * Overwrites any existing queued instruction.
 */
export const writeQueuedInstruction = (
  ipcDir: string,
  text: string
): TE.TaskEither<IpcError, void> => {
  const filePath = path.join(ipcDir, 'queued_instruction.json')
  const instruction: QueuedInstruction = {
    text,
    timestamp: new Date().toISOString()
  }
  return TE.tryCatch(
    async () => {
      await fs.writeFile(filePath, JSON.stringify(instruction), 'utf-8')
    },
    (error: unknown) => ipcWriteError(filePath, error)
  )
}

/**
 * Delete the queued instruction file.
 * Returns success even if file does not exist.
 */
export const deleteQueuedInstruction = (
  ipcDir: string
): TE.TaskEither<IpcError, void> => {
  const filePath = path.join(ipcDir, 'queued_instruction.json')
  return TE.tryCatch(
    async () => {
      try {
        await fs.unlink(filePath)
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'ENOENT') {
          return // Idempotent — no file to delete is fine
        }
        throw error
      }
    },
    (error: unknown) => ipcWriteError(filePath, error)
  )
}
