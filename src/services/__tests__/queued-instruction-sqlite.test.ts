import * as E from 'fp-ts/Either'
import { openMemoryDatabase, closeDatabase } from '../db'
import { insertSession, insertEvent, insertPendingStop } from '../db-queries'
import {
  readQueuedInstruction,
  writeQueuedInstruction,
  deleteQueuedInstruction,
} from '../queued-instruction-sqlite'

describe('queued-instruction-sqlite', () => {
  beforeEach(() => {
    const result = openMemoryDatabase()
    expect(E.isRight(result)).toBe(true)
    if (!E.isRight(result)) throw new Error('Failed to open memory database')

    // Seed session + event + pending stop
    insertSession(result.right, 'sess-1', 1, 'project', '2024-01-01')
    insertEvent(result.right, 'evt-1', 'sess-1', 'Stop', '{}')
    insertPendingStop(result.right, 'evt-1', 'sess-1')
  })

  afterEach(() => {
    closeDatabase()
  })

  describe('readQueuedInstruction', () => {
    it('returns null when no instruction queued', async () => {
      const result = await readQueuedInstruction('/ipc/sess-1')()
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return
      expect(result.right).toBeNull()
    })

    it('returns instruction after write', async () => {
      await writeQueuedInstruction('/ipc/sess-1', 'do something')()

      const result = await readQueuedInstruction('/ipc/sess-1')()
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return
      expect(result.right?.text).toBe('do something')
    })
  })

  describe('writeQueuedInstruction', () => {
    it('writes instruction to pending stop', async () => {
      const writeResult = await writeQueuedInstruction('/ipc/sess-1', 'build the thing')()
      expect(E.isRight(writeResult)).toBe(true)

      const readResult = await readQueuedInstruction('/ipc/sess-1')()
      if (!E.isRight(readResult)) return
      expect(readResult.right?.text).toBe('build the thing')
    })

    it('overwrites existing instruction', async () => {
      await writeQueuedInstruction('/ipc/sess-1', 'first')()
      await writeQueuedInstruction('/ipc/sess-1', 'second')()

      const result = await readQueuedInstruction('/ipc/sess-1')()
      if (!E.isRight(result)) return
      expect(result.right?.text).toBe('second')
    })

    it('returns error when no pending stop exists', async () => {
      const result = await writeQueuedInstruction('/ipc/nonexistent-session', 'hello')()
      expect(E.isLeft(result)).toBe(true)
    })
  })

  describe('deleteQueuedInstruction', () => {
    it('clears queued instruction', async () => {
      await writeQueuedInstruction('/ipc/sess-1', 'something')()
      const delResult = await deleteQueuedInstruction('/ipc/sess-1')()
      expect(E.isRight(delResult)).toBe(true)

      const readResult = await readQueuedInstruction('/ipc/sess-1')()
      if (!E.isRight(readResult)) return
      // After delete, should return null (empty string treated as no instruction)
      expect(readResult.right).toBeNull()
    })

    it('is idempotent — no error when no instruction', async () => {
      const result = await deleteQueuedInstruction('/ipc/sess-1')()
      expect(E.isRight(result)).toBe(true)
    })

    it('succeeds when no pending stop exists', async () => {
      const result = await deleteQueuedInstruction('/ipc/nonexistent-session')()
      expect(E.isRight(result)).toBe(true)
    })
  })
})
