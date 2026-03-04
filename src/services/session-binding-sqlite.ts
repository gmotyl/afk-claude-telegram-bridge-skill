/**
 * @module services/session-binding-sqlite
 * SQLite-backed session binding adapter.
 * Drop-in replacement for file-based session-binding.ts.
 * Uses sessions table claude_session_id column for binding.
 */

import * as E from 'fp-ts/Either'
import {
  findSessionByClaudeId,
  listActiveSessions,
  updateSessionBinding,
} from './db-queries'
import { getDatabase } from './db'

export interface BoundSession {
  readonly sessionId: string
  readonly slotNum: number
}

/**
 * Find a session already bound to a Claude Code session_id.
 *
 * @param _ipcBaseDir - Ignored (file-based compat)
 * @param claudeSessionId - Claude Code's internal session_id
 * @param _slots - Ignored (data comes from SQLite)
 */
export const findBoundSession = async (
  _ipcBaseDir: string,
  claudeSessionId: string,
  _slots: Record<string, { sessionId: string } | undefined>
): Promise<BoundSession | null> => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) return null

  const result = findSessionByClaudeId(dbResult.right, claudeSessionId)
  if (E.isLeft(result) || !result.right) return null

  return {
    sessionId: result.right.id,
    slotNum: result.right.slot_num,
  }
}

/**
 * Find a session that hasn't been bound to any Claude session yet.
 * Returns the first session (by slot number) without a claude_session_id.
 *
 * @param _ipcBaseDir - Ignored (file-based compat)
 * @param _slots - Ignored (data comes from SQLite)
 */
export const findUnboundSession = async (
  _ipcBaseDir: string,
  _slots: Record<string, { sessionId: string } | undefined>
): Promise<BoundSession | null> => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) return null

  const result = listActiveSessions(dbResult.right)
  if (E.isLeft(result)) return null

  const unbound = result.right.find((s) => s.claude_session_id === null)
  if (!unbound) return null

  return {
    sessionId: unbound.id,
    slotNum: unbound.slot_num,
  }
}

/**
 * Bind a Claude Code session_id to an AFK session.
 *
 * @param _ipcBaseDir - Ignored (file-based compat)
 * @param afkSessionId - AFK session UUID
 * @param claudeSessionId - Claude Code's internal session_id
 */
export const bindSession = async (
  _ipcBaseDir: string,
  afkSessionId: string,
  claudeSessionId: string
): Promise<void> => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) return

  updateSessionBinding(dbResult.right, afkSessionId, claudeSessionId)
}
