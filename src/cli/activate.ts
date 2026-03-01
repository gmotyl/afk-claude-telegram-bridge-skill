/**
 * @module cli/activate
 * Activate AFK mode: claim slot, create IPC dir, write SessionStart, start daemon.
 */

import * as E from 'fp-ts/Either'
import * as TE from 'fp-ts/TaskEither'
import { pipe } from 'fp-ts/function'
import * as path from 'path'
import { type Config } from '../types/config'
import { type State, type Slot } from '../types/state'
import { type BridgeError, cliError } from '../types/errors'
import { loadConfig } from '../core/config'
import { loadState, saveState } from '../services/state-persistence'
import { withStateLock } from '../services/file-lock'
import { cleanupStaleSlots, findAvailableSlot, findSlotByTopicName, addSlot, removeSlot } from '../core/state'
import { createIpcDir, writeMetaFile, writeEvent, removeIpcDir } from '../services/ipc'
import { sessionStart } from '../types/events'
import { startDaemon, isDaemonAlive } from '../services/daemon-launcher'

export interface ActivateResult {
  readonly slotNum: number
  readonly sessionId: string
  readonly topicName: string
  readonly threadId?: number
  readonly daemonPid: number
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

  return pipe(
    withStateLock(statePath, async () => {
      // 1. Load state
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
        // Remove old slot and clean its IPC dir
        state = removeSlot(state, oldSlotNum)
        await removeIpcDir(config.ipcBaseDir, oldSlot.sessionId)()
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

      // 6. Save state
      const saveResult = await saveState(statePath, state)()
      if (E.isLeft(saveResult)) {
        throw new Error(`Failed to save state: ${saveResult.left.message}`)
      }

      // 7. Create IPC dir + meta.json
      const ipcDirResult = await createIpcDir(config.ipcBaseDir, sessionId)()
      if (E.isLeft(ipcDirResult)) {
        throw new Error('Failed to create IPC directory')
      }
      const ipcDir = ipcDirResult.right

      await writeMetaFile(ipcDir, {
        sessionId,
        project,
        topicName,
        slotNum,
        activatedAt: new Date().toISOString(),
      })()

      // 8. Write SessionStart event
      const eventsFile = path.join(ipcDir, `event-S${slotNum}.jsonl`)
      await writeEvent(eventsFile, sessionStart(slotNum, sessionId, project, topicName, reattachThreadId))()

      // 9. Start daemon if not alive
      let daemonPid: number
      const stateForDaemon = await loadState(statePath)()
      const currentState = E.isRight(stateForDaemon) ? stateForDaemon.right : state
      const daemonPidFromState = (currentState as Record<string, unknown>)['daemon_pid'] as number | undefined

      if (daemonPidFromState && isDaemonAlive(daemonPidFromState)) {
        daemonPid = daemonPidFromState
      } else {
        const spawnResult = await startDaemon(bridgePath, configDir, logPath)()
        if (E.isLeft(spawnResult)) {
          throw new Error(`Failed to start daemon: ${spawnResult.left.message}`)
        }
        daemonPid = spawnResult.right

        // Save daemon PID to state
        const stateWithPid = await loadState(statePath)()
        if (E.isRight(stateWithPid)) {
          const stateObj = stateWithPid.right as unknown as Record<string, unknown>
          stateObj['daemon_pid'] = daemonPid
          stateObj['daemon_heartbeat'] = Date.now() / 1000
          await saveState(statePath, stateObj as unknown as State)()
        }
      }

      return { slotNum, sessionId, topicName, threadId: reattachThreadId, daemonPid } as ActivateResult
    }),
    TE.mapLeft((lockErr) => {
      if (lockErr._tag === 'LockError') return lockErr as BridgeError
      return cliError(String(lockErr), 'activate') as BridgeError
    })
  )
}
