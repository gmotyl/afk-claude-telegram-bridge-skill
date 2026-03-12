/**
 * @module cli/activate
 * Activate AFK mode: claim slot, insert session into SQLite, write SessionStart, start daemon.
 */

import * as E from 'fp-ts/Either'
import * as TE from 'fp-ts/TaskEither'
import * as path from 'path'
import * as fs from 'fs/promises'
import { type Slot } from '../types/state'
import { type BridgeError, cliError } from '../types/errors'
import { dbErrorMessage } from '../types/db'
import { loadConfig } from '../core/config'
import { loadState } from '../services/state-persistence-sqlite'
import { cleanupStaleSlots, findAvailableSlot, findSlotByTopicName, addSlot, removeSlot } from '../core/state'
import { createIpcDir, writeMetaFile, writeEvent, removeIpcDir } from '../services/ipc-sqlite'
import { sessionStart } from '../types/events'
import { startDaemon, isDaemonAlive } from '../services/daemon-launcher'
import { updateDaemonPidInState } from '../services/daemon-health'
import { openDatabase, getDatabase } from '../services/db'
import { insertSession, deleteSession, updateSessionThreadId } from '../services/db-queries'
import { incrementActiveCount } from '../services/marker'

export interface ActivateResult {
  readonly slotNum: number
  readonly sessionId: string
  readonly topicName: string
  readonly threadId?: number
  readonly daemonPid: number
}

const readDaemonPidFromState = async (configDir: string): Promise<number | null> => {
  try {
    const pidPath = path.join(configDir, 'daemon.pid')
    const content = await fs.readFile(pidPath, 'utf-8')
    const pid = parseInt(content.trim(), 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

export const activate = (
  configDir: string,
  sessionId: string,
  project: string,
  topicName: string,
  verbose: boolean = false
): TE.TaskEither<BridgeError, ActivateResult> => {
  const configPath = path.join(configDir, 'config.json')
  const statePath = path.join(configDir, 'state.json')
  const bridgePath = path.join(configDir, 'bridge.js')
  const logPath = path.join(configDir, 'daemon.log')

  // Load config first (synchronous Either)
  const configResult = loadConfig(configPath)
  if (E.isLeft(configResult)) {
    return TE.left(cliError(`Failed to load config: ${configResult.left.message}`, 'activate'))
  }
  const config = configResult.right

  // Open SQLite database
  const dbPath = path.join(configDir, 'bridge.db')
  const dbResult = openDatabase(dbPath)
  if (E.isLeft(dbResult)) {
    return TE.left(cliError(`Failed to open database: ${dbErrorMessage(dbResult.left)}`, 'activate'))
  }

  return TE.tryCatch(
    async () => {
      // 1. Load state from SQLite
      const stateResult = await loadState(statePath)()
      if (E.isLeft(stateResult)) {
        throw new Error(`Failed to load state: ${stateResult.left.message}`)
      }
      let state = stateResult.right

      // 2. Cleanup stale slots
      state = cleanupStaleSlots(state, config.sessionTimeout, new Date())

      // 3. Check reattachment (same topicName → capture threadId)
      let reattachThreadId: number | undefined
      let preferredSlot: number | undefined
      const existingSlot = findSlotByTopicName(state, topicName)
      if (existingSlot) {
        const [oldSlotNum, oldSlot] = existingSlot
        reattachThreadId = oldSlot.threadId
        preferredSlot = oldSlotNum
        // Remove old slot from state and SQLite
        state = removeSlot(state, oldSlotNum)
        const dbRef = getDatabase()
        if (E.isRight(dbRef)) {
          deleteSession(dbRef.right, oldSlot.sessionId)
        }
      }

      // 4. Find available slot
      const slotNum = findAvailableSlot(state, preferredSlot)
      if (slotNum === null) {
        throw new Error('All 4 AFK slots are occupied. Deactivate one first.')
      }

      // 5. Build Slot and add to state
      const slot: Slot = {
        sessionId,
        projectName: project,
        topicName,
        ...(reattachThreadId !== undefined ? { threadId: reattachThreadId } : {}),
        ...(verbose ? { verbose: true } : {}),
        activatedAt: new Date(),
        lastHeartbeat: new Date(),
      }

      const addResult = addSlot(state, slotNum, slot)
      if (E.isLeft(addResult)) {
        throw new Error(`Failed to add slot: ${addResult.left._tag}`)
      }
      state = addResult.right

      // 6. Insert session into SQLite
      const dbRef = getDatabase()
      if (E.isRight(dbRef)) {
        const insertResult = insertSession(dbRef.right, sessionId, slotNum, project, new Date().toISOString())
        if (E.isLeft(insertResult)) {
          throw new Error(`Failed to insert session: ${String(insertResult.left)}`)
        }
        // Set threadId if reattaching
        if (reattachThreadId !== undefined) {
          updateSessionThreadId(dbRef.right, sessionId, reattachThreadId)
        }
        incrementActiveCount(configDir)
      }

      // 7. Write SessionStart event to SQLite
      const eventsFile = path.join(config.ipcBaseDir, sessionId, `event-S${slotNum}.jsonl`)
      await writeEvent(eventsFile, sessionStart(slotNum, sessionId, project, topicName, reattachThreadId))()

      // 8. Start daemon if not alive
      let daemonPid: number

      // Check for existing daemon via PID in daemon.pid
      const existingPid = await readDaemonPidFromState(configDir)
      if (existingPid !== null && isDaemonAlive(existingPid)) {
        daemonPid = existingPid
      } else {
        const spawnResult = await startDaemon(bridgePath, configDir, logPath)()
        if (E.isLeft(spawnResult)) {
          throw new Error(`Failed to start daemon: ${spawnResult.left.message}`)
        }
        daemonPid = spawnResult.right
        // Persist PID so hooks can find the daemon
        await updateDaemonPidInState(configDir, daemonPid)
      }

      return { slotNum, sessionId, topicName, threadId: reattachThreadId, daemonPid } as ActivateResult
    },
    (err) => cliError(String(err), 'activate') as BridgeError
  )
}
