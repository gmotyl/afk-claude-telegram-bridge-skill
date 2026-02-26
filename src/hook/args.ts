/**
 * @module hook/args
 * Parses command-line arguments passed to the Claude Code hook.
 * Determines hook type and extracts type-specific data.
 */

import * as Either from '../types/either'
import { HookParseError, hookParseError } from '../types/errors'

// ============================================================================
// Types
// ============================================================================

export type HookType = 'permission_request' | 'stop' | 'notification'

export interface HookArgs {
  readonly type: HookType
  readonly tool?: string
  readonly command?: string
  readonly message?: string
}

// ============================================================================
// Hook Argument Parser
// ============================================================================

/**
 * Parses command-line arguments passed to the hook.
 *
 * Valid invocations:
 * - ['permission_request', 'Bash', 'npm install']
 * - ['stop']
 * - ['notification', 'Task completed']
 *
 * @param args - Array of command-line arguments (typically process.argv.slice(2))
 * @returns Either<HookParseError, HookArgs>
 */
export const parseHookArgs = (args: string[]): Either.Either<HookParseError, HookArgs> => {
  // Check for no arguments
  if (args.length === 0) {
    return Either.err(hookParseError('No hook type provided'))
  }

  const [hookType, ...rest] = args

  // Check for empty hook type
  if (!hookType || hookType.trim() === '') {
    return Either.err(hookParseError('Hook type cannot be empty'))
  }

  // Parse based on hook type
  switch (hookType) {
    case 'permission_request':
      return parsePermissionRequest(rest)

    case 'stop':
      return Either.ok({ type: 'stop' })

    case 'notification':
      return parseNotification(rest)

    default:
      return Either.err(
        hookParseError(`Invalid hook type '${hookType}'. Expected 'permission_request', 'stop', or 'notification'`)
      )
  }
}

// ============================================================================
// Permission Request Parser
// ============================================================================

const parsePermissionRequest = (args: string[]): Either.Either<HookParseError, HookArgs> => {
  if (args.length < 2) {
    return Either.err(
      hookParseError('permission_request requires tool and command arguments')
    )
  }

  const [tool, ...commandParts] = args
  const command = commandParts.join(' ')

  // Validate tool is not empty
  if (!tool || tool.trim() === '') {
    return Either.err(hookParseError('Tool name cannot be empty'))
  }

  // Validate command is not empty
  if (!command || command.trim() === '') {
    return Either.err(hookParseError('Command cannot be empty'))
  }

  return Either.ok({
    type: 'permission_request',
    tool,
    command,
  })
}

// ============================================================================
// Notification Parser
// ============================================================================

const parseNotification = (args: string[]): Either.Either<HookParseError, HookArgs> => {
  if (args.length < 1) {
    return Either.err(
      hookParseError('notification requires a message argument')
    )
  }

  const message = args.join(' ')

  // Validate message is not empty
  if (!message || message.trim() === '') {
    return Either.err(hookParseError('Message cannot be empty'))
  }

  return Either.ok({
    type: 'notification',
    message,
  })
}

// ============================================================================
// Re-export Either utilities for use in tests
// ============================================================================

export const ok = Either.ok
export const err = Either.err
export const isOk = Either.isOk
export const isErr = Either.isErr
export const fold = Either.fold
export const mapError = Either.mapError
export const unwrapOr = Either.unwrapOr
export const pipe = Either.pipe
