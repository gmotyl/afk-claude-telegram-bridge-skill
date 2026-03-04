/**
 * @module services/daemon-health
 * Daemon health checking for the Stop hook.
 * Reads heartbeat file + PID to determine if daemon is alive, stale, or dead.
 */

import * as TE from 'fp-ts/TaskEither'
import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import { type HookError, hookError } from '../types/errors'
import { isDaemonAlive, startDaemon } from './daemon-launcher'

// ============================================================================
// Types
// ============================================================================

export type DaemonHealthy = {
  readonly _tag: 'DaemonHealthy'
  readonly pid: number
  readonly lastHeartbeatMs: number
}

export type DaemonStale = {
  readonly _tag: 'DaemonStale'
  readonly pid: number
  readonly lastHeartbeatMs: number
  readonly staleForMs: number
}

export type DaemonDead = {
  readonly _tag: 'DaemonDead'
  readonly pid: number | null
  readonly reason: string
}

export type DaemonHealthStatus = DaemonHealthy | DaemonStale | DaemonDead

// Smart constructors
export const daemonHealthy = (pid: number, lastHeartbeatMs: number): DaemonHealthy => ({
  _tag: 'DaemonHealthy',
  pid,
  lastHeartbeatMs,
})

export const daemonStale = (pid: number, lastHeartbeatMs: number, staleForMs: number): DaemonStale => ({
  _tag: 'DaemonStale',
  pid,
  lastHeartbeatMs,
  staleForMs,
})

export const daemonDead = (pid: number | null, reason: string): DaemonDead => ({
  _tag: 'DaemonDead',
  pid,
  reason,
})

// ============================================================================
// Constants
// ============================================================================

/** Heartbeat older than this is considered stale (daemon may be hung) */
const HEARTBEAT_STALE_THRESHOLD_MS = 30_000

// ============================================================================
// Health check
// ============================================================================

/**
 * Read daemon PID from daemon.pid file.
 * Returns null if not found or unreadable.
 */
const readDaemonPid = async (configDir: string): Promise<number | null> => {
  try {
    const pidPath = path.join(configDir, 'daemon.pid')
    const content = await fs.readFile(pidPath, 'utf-8')
    const pid = parseInt(content.trim(), 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

/**
 * Read daemon heartbeat timestamp from daemon.heartbeat file.
 * Returns null if not found or unreadable.
 */
const readHeartbeat = async (configDir: string): Promise<number | null> => {
  try {
    const heartbeatPath = path.join(configDir, 'daemon.heartbeat')
    const content = await fs.readFile(heartbeatPath, 'utf-8')
    const timestamp = parseInt(content.trim(), 10)
    return isNaN(timestamp) ? null : timestamp
  } catch {
    return null
  }
}

/**
 * Check daemon health by reading heartbeat file and verifying PID.
 *
 * Decision logic:
 * 1. No PID in state → Dead (never started or state corrupted)
 * 2. PID not alive (kill -0 fails) → Dead
 * 3. No heartbeat file → Dead (daemon started but never wrote heartbeat)
 * 4. Heartbeat older than threshold → Stale (daemon may be hung)
 * 5. Otherwise → Healthy
 *
 * @param configDir - Path to config directory containing daemon.pid and daemon.heartbeat
 * @param now - Current timestamp in ms (injectable for testing)
 * @returns TaskEither<HookError, DaemonHealthStatus>
 */
export const checkDaemonHealth = (
  configDir: string,
  now: number = Date.now()
): TE.TaskEither<HookError, DaemonHealthStatus> =>
  TE.tryCatch(
    async () => {
      const pid = await readDaemonPid(configDir)

      if (pid === null) {
        return daemonDead(null, 'No daemon PID found in state')
      }

      if (!isDaemonAlive(pid)) {
        return daemonDead(pid, `Process ${pid} is not running`)
      }

      const heartbeat = await readHeartbeat(configDir)

      if (heartbeat === null) {
        return daemonDead(pid, 'No heartbeat file found (daemon may have just started)')
      }

      const age = now - heartbeat

      if (age > HEARTBEAT_STALE_THRESHOLD_MS) {
        return daemonStale(pid, heartbeat, age)
      }

      return daemonHealthy(pid, heartbeat)
    },
    (error: unknown) => hookError(`Daemon health check failed: ${String(error)}`)
  )

// ============================================================================
// State helpers
// ============================================================================

/**
 * Write daemon PID to daemon.pid file.
 */
export const updateDaemonPidInState = async (configDir: string, pid: number): Promise<void> => {
  const pidPath = path.join(configDir, 'daemon.pid')
  try {
    await fs.writeFile(pidPath, String(pid), 'utf-8')
  } catch (error) {
    console.error(`[daemon-health] Failed to write daemon PID: ${String(error)}`)
  }
}

// ============================================================================
// Ensure daemon alive (check + restart if needed)
// ============================================================================

/**
 * Check daemon health and restart if dead or stale.
 * Returns true if daemon is healthy (or was successfully restarted), false if unrecoverable.
 *
 * @param configDir - Path to config directory containing daemon.pid, bridge.js, daemon.log
 * @returns Promise<boolean> - true if daemon is alive, false if restart failed
 */
export const ensureDaemonAlive = async (configDir: string): Promise<boolean> => {
  const healthResult = await checkDaemonHealth(configDir)()

  if (E.isLeft(healthResult)) {
    console.error(`[daemon-health] Health check failed: ${healthResult.left.message}`)
    return false
  }

  const health = healthResult.right

  if (health._tag === 'DaemonHealthy') {
    return true
  }

  console.error(`[daemon-health] Daemon ${health._tag}: ${health._tag === 'DaemonDead' ? health.reason : `stale for ${health.staleForMs}ms`}`)

  // Attempt restart
  const bridgePath = path.join(configDir, 'bridge.js')
  const logPath = path.join(configDir, 'daemon.log')

  const spawnResult = await startDaemon(bridgePath, configDir, logPath)()

  if (E.isLeft(spawnResult)) {
    console.error(`[daemon-health] Failed to restart daemon: ${spawnResult.left.message}`)
    return false
  }

  const newPid = spawnResult.right
  console.error(`[daemon-health] Daemon restarted with PID ${newPid}`)
  await updateDaemonPidInState(configDir, newPid)
  return true
}
