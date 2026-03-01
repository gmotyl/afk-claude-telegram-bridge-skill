/**
 * @module services/daemon-launcher
 * Daemon lifecycle management: start, stop, and check if alive.
 */

import * as TE from 'fp-ts/TaskEither'
import { spawn } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import { type DaemonSpawnError, type DaemonStopError, daemonSpawnError, daemonStopError } from '../types/errors'

/** Max time to wait for daemon heartbeat after spawn (ms) */
const SPAWN_VERIFY_TIMEOUT_MS = 5000
/** Polling interval for heartbeat verification (ms) */
const SPAWN_VERIFY_POLL_MS = 200

/**
 * Start the bridge daemon as a detached background process.
 * Returns the PID of the spawned process.
 *
 * @param bridgePath - Path to bridge.js
 * @param configPath - Path to config directory (passed via TELEGRAM_BRIDGE_CONFIG env)
 * @param logPath - Path to write daemon stdout/stderr
 * @returns TaskEither<DaemonSpawnError, number> - PID of the daemon
 */
export const startDaemon = (
  bridgePath: string,
  configPath: string,
  logPath: string
): TE.TaskEither<DaemonSpawnError, number> =>
  TE.tryCatch(
    async () => {
      const spawnTime = Date.now()
      const logFd = await fs.open(logPath, 'a')
      const child = spawn('node', [bridgePath], {
        detached: true,
        stdio: ['ignore', logFd.fd, logFd.fd],
        env: { ...process.env, TELEGRAM_BRIDGE_CONFIG: configPath },
      })

      if (!child.pid) {
        await logFd.close()
        throw new Error('Failed to get PID from spawned process')
      }

      child.unref()
      await logFd.close()

      // Verify daemon initialized by polling for a fresh heartbeat
      const heartbeatPath = path.join(configPath, 'daemon.heartbeat')
      const deadline = Date.now() + SPAWN_VERIFY_TIMEOUT_MS

      while (Date.now() < deadline) {
        try {
          const content = await fs.readFile(heartbeatPath, 'utf-8')
          const heartbeatTs = parseInt(content.trim(), 10)
          if (!isNaN(heartbeatTs) && heartbeatTs >= spawnTime) {
            return child.pid
          }
        } catch {
          // File doesn't exist yet — keep polling
        }
        await new Promise(resolve => setTimeout(resolve, SPAWN_VERIFY_POLL_MS))
      }

      // Timeout — daemon may have started but didn't write heartbeat in time
      // Still return PID so caller can track it, but log warning
      console.error(`[daemon-launcher] Warning: daemon PID ${child.pid} spawned but heartbeat not verified within ${SPAWN_VERIFY_TIMEOUT_MS}ms`)
      return child.pid
    },
    (cause) => daemonSpawnError(String(cause))
  )

/**
 * Stop a daemon by PID using SIGTERM.
 *
 * @param pid - Process ID to terminate
 * @returns TaskEither<DaemonStopError, void>
 */
export const stopDaemon = (pid: number): TE.TaskEither<DaemonStopError, void> =>
  TE.tryCatch(
    async () => {
      process.kill(pid, 'SIGTERM')
    },
    (cause) => daemonStopError(`Failed to stop daemon PID ${pid}: ${String(cause)}`)
  )

/**
 * Check if a process is alive by sending signal 0.
 *
 * @param pid - Process ID to check
 * @returns true if alive, false otherwise
 */
export const isDaemonAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
