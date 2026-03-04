import * as E from 'fp-ts/Either'
import { openMemoryDatabase, closeDatabase } from '../db'
import { insertSession, updateSessionBinding } from '../db-queries'
import {
  findBoundSession,
  findUnboundSession,
  bindSession,
} from '../session-binding-sqlite'

describe('session-binding-sqlite', () => {
  beforeEach(() => {
    const result = openMemoryDatabase()
    expect(E.isRight(result)).toBe(true)
  })

  afterEach(() => {
    closeDatabase()
  })

  describe('findBoundSession', () => {
    it('finds session bound to claude_session_id', async () => {
      const db = E.isRight(openMemoryDatabase()) ? undefined : undefined
      // Session already seeded by beforeEach, but we need a fresh one
      // (openMemoryDatabase replaces the global db)
      const dbResult = E.toUnion(openMemoryDatabase())
      // db was already opened in beforeEach, use getDatabase
      const { getDatabase } = await import('../db')
      const dbR = getDatabase()
      if (!E.isRight(dbR)) throw new Error('no db')
      const dbInst = dbR.right

      insertSession(dbInst, 'sess-1', 1, 'project-a', '2024-01-01')
      updateSessionBinding(dbInst, 'sess-1', 'claude-abc')

      const result = await findBoundSession('/ipc', 'claude-abc', {})
      expect(result).not.toBeNull()
      expect(result?.sessionId).toBe('sess-1')
      expect(result?.slotNum).toBe(1)
    })

    it('returns null for unknown claude_session_id', async () => {
      const result = await findBoundSession('/ipc', 'nonexistent', {})
      expect(result).toBeNull()
    })
  })

  describe('findUnboundSession', () => {
    it('finds session without claude_session_id', async () => {
      const { getDatabase } = await import('../db')
      const dbR = getDatabase()
      if (!E.isRight(dbR)) throw new Error('no db')

      insertSession(dbR.right, 'sess-1', 1, 'project-a', '2024-01-01')

      const result = await findUnboundSession('/ipc', {})
      expect(result).not.toBeNull()
      expect(result?.sessionId).toBe('sess-1')
      expect(result?.slotNum).toBe(1)
    })

    it('skips bound sessions', async () => {
      const { getDatabase } = await import('../db')
      const dbR = getDatabase()
      if (!E.isRight(dbR)) throw new Error('no db')

      insertSession(dbR.right, 'sess-1', 1, 'project-a', '2024-01-01')
      updateSessionBinding(dbR.right, 'sess-1', 'claude-abc')

      const result = await findUnboundSession('/ipc', {})
      expect(result).toBeNull()
    })

    it('returns first unbound by slot order', async () => {
      const { getDatabase } = await import('../db')
      const dbR = getDatabase()
      if (!E.isRight(dbR)) throw new Error('no db')

      insertSession(dbR.right, 'sess-2', 2, 'project-b', '2024-01-01')
      insertSession(dbR.right, 'sess-1', 1, 'project-a', '2024-01-01')
      updateSessionBinding(dbR.right, 'sess-1', 'claude-x')

      const result = await findUnboundSession('/ipc', {})
      expect(result).not.toBeNull()
      expect(result?.slotNum).toBe(2)
    })
  })

  describe('bindSession', () => {
    it('binds claude_session_id to afk session', async () => {
      const { getDatabase } = await import('../db')
      const dbR = getDatabase()
      if (!E.isRight(dbR)) throw new Error('no db')

      insertSession(dbR.right, 'sess-1', 1, 'project-a', '2024-01-01')

      await bindSession('/ipc', 'sess-1', 'claude-xyz')

      const bound = await findBoundSession('/ipc', 'claude-xyz', {})
      expect(bound).not.toBeNull()
      expect(bound?.sessionId).toBe('sess-1')
    })
  })
})
