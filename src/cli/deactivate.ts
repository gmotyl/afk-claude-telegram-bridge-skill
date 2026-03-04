/**
 * @module cli/deactivate
 * Deactivate AFK mode: release slot, delete session from SQLite (CASCADE), stop daemon if last.
 */

import * as E from 'fp-ts/Either'
import * as TE from 'fp-ts/TaskEither'
import * as path from 'path'
import * as fs from 'fs/promises'
import { type BridgeError, cliError } from '../types/errors'
import { dbErrorMessage } from '../types/db'
import { loadConfig } from '../core/config'
import { loadState } from '../services/state-persistence-sqlite'
import { findSlotBySessionId } from '../core/state'
import { stopDaemon, isDaemonAlive } from '../services/daemon-launcher'
import { sendMessageToTopic, deleteForumTopic } from '../services/telegram'
import { openDatabase, getDatabase } from '../services/db'
import { deleteSession } from '../services/db-queries'

const readDaemonPidFromFile = async (configDir: string): Promise<number | null> => {
  try {
    const content = await fs.readFile(path.join(configDir, 'daemon.pid'), 'utf-8')
    const pid = parseInt(content.trim(), 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

export const deactivate = (
  configDir: string,
  sessionId: string
): TE.TaskEither<BridgeError, void> => {
  const configPath = path.join(configDir, 'config.json')
  const statePath = path.join(configDir, 'state.json')

  const configResult = loadConfig(configPath)
  if (E.isLeft(configResult)) {
    return TE.left(cliError(`Failed to load config: ${configResult.left.message}`, 'deactivate'))
  }
  const config = configResult.right

  // Open SQLite database
  const dbPath = path.join(configDir, 'bridge.db')
  const dbResult = openDatabase(dbPath)
  if (E.isLeft(dbResult)) {
    return TE.left(cliError(`Failed to open database: ${dbErrorMessage(dbResult.left)}`, 'deactivate'))
  }

  return TE.tryCatch(
    async () => {
      // 1. Load state from SQLite
      const stateResult = await loadState(statePath)()
      if (E.isLeft(stateResult)) {
        throw new Error(`Failed to load state: ${stateResult.left.message}`)
      }
      const state = stateResult.right

      // 2. Find slot by sessionId (or first active if no exact match)
      let slotNum: number
      let slotSessionId: string
      const found = findSlotBySessionId(state, sessionId)
      if (found) {
        slotNum = found[0]
        slotSessionId = found[1].sessionId
      } else {
        // Try to find first active slot as fallback
        const firstActive = Object.entries(state.slots).find(([, s]) => s !== undefined)
        if (!firstActive) {
          // No active slots — nothing to deactivate
          return
        }
        slotNum = parseInt(firstActive[0], 10)
        slotSessionId = firstActive[1]!.sessionId
      }

      // 3. Send Telegram deactivation message and delete topic
      const slot = state.slots[slotNum]
      if (slot?.threadId) {
        const token = config.telegramBotToken
        const chatId = String(config.telegramGroupId)
        await sendMessageToTopic(token, chatId, `🔴 S${slotNum} deactivated — ${slot.projectName}`, slot.threadId)()
        await deleteForumTopic(token, chatId, slot.threadId)()
      }

      // 4. Delete session from SQLite (CASCADE clears events, responses, batches, pending_stops)
      const dbRef = getDatabase()
      if (E.isRight(dbRef)) {
        deleteSession(dbRef.right, slotSessionId)
      }

      // 5. Check if any slots remain after deletion
      const remainingState = await loadState(statePath)()
      const hasActiveSlots = E.isRight(remainingState) &&
        Object.values(remainingState.right.slots).some(s => s !== undefined)

      // 6. Stop daemon if no slots remain
      if (!hasActiveSlots) {
        const daemonPid = await readDaemonPidFromFile(configDir)
        if (daemonPid !== null && isDaemonAlive(daemonPid)) {
          await stopDaemon(daemonPid)()
        }
      }
    },
    (err) => cliError(String(err), 'deactivate') as BridgeError
  )
}
