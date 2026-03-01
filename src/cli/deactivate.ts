/**
 * @module cli/deactivate
 * Deactivate AFK mode: write SessionEnd, release slot, clean IPC, stop daemon if last.
 */

import * as E from 'fp-ts/Either'
import * as TE from 'fp-ts/TaskEither'
import { pipe } from 'fp-ts/function'
import * as path from 'path'
import { type State } from '../types/state'
import { type BridgeError, cliError } from '../types/errors'
import { loadConfig } from '../core/config'
import { loadState, saveState } from '../services/state-persistence'
import { withStateLock } from '../services/file-lock'
import { findSlotBySessionId, removeSlot } from '../core/state'
import { removeIpcDir } from '../services/ipc'
import { stopDaemon, isDaemonAlive } from '../services/daemon-launcher'
import { sendMessageToTopic, deleteForumTopic } from '../services/telegram'

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

  return pipe(
    withStateLock(statePath, async () => {
      // 1. Load state
      const stateResult = await loadState(statePath)()
      if (E.isLeft(stateResult)) {
        throw new Error(`Failed to load state: ${stateResult.left.message}`)
      }
      let state = stateResult.right

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

      // 4. Remove slot from state
      state = removeSlot(state, slotNum)

      // 5. Save state
      const saveResult = await saveState(statePath, state)()
      if (E.isLeft(saveResult)) {
        throw new Error(`Failed to save state: ${saveResult.left.message}`)
      }

      // 6. Clean IPC dir (safe now since we handled Telegram directly)
      await removeIpcDir(config.ipcBaseDir, slotSessionId)()

      // 7. Stop daemon if no slots remain
      const hasActiveSlots = Object.values(state.slots).some(s => s !== undefined)
      if (!hasActiveSlots) {
        const stateObj = state as unknown as Record<string, unknown>
        const daemonPid = stateObj['daemon_pid'] as number | undefined
        if (daemonPid && isDaemonAlive(daemonPid)) {
          await stopDaemon(daemonPid)()
          // Clear daemon PID from state
          delete stateObj['daemon_pid']
          delete stateObj['daemon_heartbeat']
          await saveState(statePath, stateObj as unknown as State)()
        }
      }
    }),
    TE.mapLeft((lockErr) => {
      if (lockErr._tag === 'LockError') return lockErr as BridgeError
      return cliError(String(lockErr), 'deactivate') as BridgeError
    })
  )
}
