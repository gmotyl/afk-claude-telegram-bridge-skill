import * as E from 'fp-ts/Either'
import { openMemoryDatabase, closeDatabase } from '../db'
import { insertSession, insertEvent, insertPendingStop, updateSessionThreadId } from '../db-queries'
import { loadState, saveState } from '../state-persistence-sqlite'

describe('state-persistence-sqlite', () => {
  beforeEach(() => {
    const result = openMemoryDatabase()
    expect(E.isRight(result)).toBe(true)
  })

  afterEach(() => {
    closeDatabase()
  })

  describe('loadState', () => {
    it('returns initial state when no sessions exist', async () => {
      const result = await loadState('/ignored')()
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const state = result.right
      expect(state.slots[1]).toBeUndefined()
      expect(state.slots[2]).toBeUndefined()
      expect(Object.keys(state.pendingStops)).toHaveLength(0)
    })

    it('reconstructs slots from sessions table', async () => {
      const { getDatabase } = await import('../db')
      const dbR = getDatabase()
      if (!E.isRight(dbR)) throw new Error('no db')

      insertSession(dbR.right, 'sess-1', 1, 'my-project', '2024-06-15T10:00:00Z')
      updateSessionThreadId(dbR.right, 'sess-1', 42)

      const result = await loadState('/ignored')()
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const slot = result.right.slots[1]
      expect(slot).toBeDefined()
      expect(slot?.sessionId).toBe('sess-1')
      expect(slot?.projectName).toBe('my-project')
      expect(slot?.threadId).toBe(42)
      expect(slot?.activatedAt).toBeInstanceOf(Date)
    })

    it('reconstructs pendingStops', async () => {
      const { getDatabase } = await import('../db')
      const dbR = getDatabase()
      if (!E.isRight(dbR)) throw new Error('no db')

      insertSession(dbR.right, 'sess-1', 1, 'project', '2024-01-01')
      insertEvent(dbR.right, 'evt-1', 'sess-1', 'Stop', '{}')
      insertPendingStop(dbR.right, 'evt-1', 'sess-1')

      const result = await loadState('/ignored')()
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      const ps = result.right.pendingStops['evt-1']
      expect(ps).toBeDefined()
      expect(ps?.eventId).toBe('evt-1')
      expect(ps?.slotNum).toBe(1)
      expect(ps?.sessionId).toBe('sess-1')
    })

    it('handles multiple sessions across slots', async () => {
      const { getDatabase } = await import('../db')
      const dbR = getDatabase()
      if (!E.isRight(dbR)) throw new Error('no db')

      insertSession(dbR.right, 'sess-1', 1, 'project-a', '2024-01-01')
      insertSession(dbR.right, 'sess-2', 3, 'project-b', '2024-01-01')

      const result = await loadState('/ignored')()
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return

      expect(result.right.slots[1]?.sessionId).toBe('sess-1')
      expect(result.right.slots[2]).toBeUndefined()
      expect(result.right.slots[3]?.sessionId).toBe('sess-2')
      expect(result.right.slots[4]).toBeUndefined()
    })
  })

  describe('saveState', () => {
    it('is a no-op (returns Right)', async () => {
      const result = await saveState('/ignored', {
        slots: { 1: undefined, 2: undefined, 3: undefined, 4: undefined },
        pendingStops: {},
      })()
      expect(E.isRight(result)).toBe(true)
    })
  })
})
