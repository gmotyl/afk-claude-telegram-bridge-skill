/**
 * @module hook/permission
 * Permission request handling - hook writes to IPC, waits for daemon approval.
 *
 * Flow:
 * 1. Generate unique request ID
 * 2. Write permission request event to IPC events.jsonl
 * 3. Poll for response file (response-{requestId}.json)
 * 4. Parse response and validate
 * 5. Clean up response file
 * 6. Return PermissionResponse to Claude Code
 */

import * as TE from 'fp-ts/TaskEither'
import * as fs from 'fs/promises'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { type HookArgs } from './args'
import { permissionRequest } from '../types/events'
import { writeEvent } from '../services/ipc'
import { type HookError, hookError } from '../types/errors'

// ============================================================================
// Types
// ============================================================================

export interface PermissionResponse {
  readonly approved: boolean
  readonly reason?: string
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30000
const POLLING_INTERVAL_MS = 100

// ============================================================================
// Permission Request Handler
// ============================================================================

/**
 * Request permission from daemon to execute a tool command.
 *
 * Process:
 * 1. Generate unique request ID
 * 2. Write permission request event to IPC queue
 * 3. Poll for response file from daemon
 * 4. Parse and validate response
 * 5. Clean up response file
 * 6. Return approval status
 *
 * @param ipcDir - Path to IPC directory where events.jsonl is written
 * @param hookArgs - Hook arguments containing tool and command
 * @param timeoutMs - Maximum milliseconds to wait for response (default: 30000)
 * @returns TaskEither<HookError, PermissionResponse>
 *
 * @example
 * const result = await requestPermission('/tmp/ipc', {
 *   type: 'permission_request',
 *   tool: 'Bash',
 *   command: 'npm install'
 * }, 10000)()
 *
 * if (E.isRight(result)) {
 *   if (result.right.approved) {
 *     // Execute command
 *   }
 * }
 */
export const requestPermission = (
  ipcDir: string,
  hookArgs: HookArgs,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): TE.TaskEither<HookError, PermissionResponse> =>
  TE.tryCatch(
    async () => {
      // Validate hook args
      if (hookArgs.type !== 'permission_request' || !hookArgs.tool || !hookArgs.command) {
        throw hookError('Invalid hook arguments for permission request')
      }

      // Generate unique request ID
      const requestId = randomUUID()

      // Write permission request event to IPC queue
      const eventsFile = path.join(ipcDir, 'events.jsonl')
      const event = permissionRequest(requestId, hookArgs.tool, hookArgs.command)

      const writeResult = await writeEvent(eventsFile, event)()
      if (!('right' in writeResult)) {
        throw hookError(`Failed to write permission request to IPC: ${String((writeResult as any).left)}`)
      }

      // Poll for response file
      const response = await pollForResponse(ipcDir, requestId, timeoutMs)

      // Clean up response file
      const responseFile = path.join(ipcDir, `response-${requestId}.json`)
      await fs
        .unlink(responseFile)
        .catch(() => {
          // Ignore cleanup errors
        })

      return response
    },
    (error: unknown): HookError => {
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        const e = error as { _tag?: string; message?: string }
        if (e._tag === 'HookError') {
          return error as HookError
        }
      }
      return hookError(`Permission request failed: ${String(error)}`)
    }
  )

// ============================================================================
// Polling Helper
// ============================================================================

/**
 * Poll for response file until timeout.
 * Checks if response file exists, reads and parses it.
 *
 * @param ipcDir - Path to IPC directory
 * @param requestId - Request ID to match response file
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @returns Promise<PermissionResponse>
 * @throws HookError if timeout or parsing fails
 */
const pollForResponse = async (
  ipcDir: string,
  requestId: string,
  timeoutMs: number
): Promise<PermissionResponse> => {
  const responseFile = path.join(ipcDir, `response-${requestId}.json`)
  const startTime = Date.now()

  while (true) {
    const elapsed = Date.now() - startTime

    // Check if response file exists
    try {
      const content = await fs.readFile(responseFile, 'utf-8')
      const response = JSON.parse(content) as PermissionResponse

      // Validate response structure
      if (typeof response.approved !== 'boolean') {
        throw hookError('Invalid response: missing or non-boolean "approved" field')
      }

      return response
    } catch (error) {
      // If it's a HookError, re-throw
      if (typeof error === 'object' && error !== null && '_tag' in error) {
        const e = error as { _tag?: string }
        if (e._tag === 'HookError') {
          throw error
        }
      }

      // File doesn't exist or JSON parse error
      if (elapsed >= timeoutMs) {
        throw hookError(`Permission request timeout after ${timeoutMs}ms`)
      }

      if (error instanceof SyntaxError) {
        throw hookError(`Failed to parse permission response: ${error.message}`)
      }

      // Continue polling
      await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS))
    }
  }
}
