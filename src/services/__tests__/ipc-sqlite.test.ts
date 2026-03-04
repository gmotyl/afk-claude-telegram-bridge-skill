import * as E from 'fp-ts/Either'
import { openMemoryDatabase, closeDatabase } from '../db'
import { insertSession } from '../db-queries'
import {
  writeEvent,
  readEventQueue,
  readEventsBySession,
  deleteEventFile,
  markSessionEventsProcessed,
  writeResponse,
  readResponse,
  listEvents,
  createIpcDir,
  removeIpcDir,
  writeMetaFile,
  cleanOrphanedIpcDirs,
} from '../ipc-sqlite'
import { permissionRequest, stopEvent } from '../../types/events'

describe('ipc-sqlite', () => {
  beforeEach(() => {
    const result = openMemoryDatabase()
    expect(E.isRight(result)).toBe(true)
    if (!E.isRight(result)) throw new Error('Failed to open memory database')

    // Seed a session for FK constraints
    insertSession(result.right, 'sess-1', 1, 'test-project', '2024-01-01T00:00:00Z')
  })

  afterEach(() => {
    closeDatabase()
  })

  // ==========================================================================
  // Events
  // ==========================================================================

  describe('writeEvent + readEventsBySession', () => {
    it('writes and reads a permission request event', async () => {
      const event = permissionRequest('req-1', 'Bash', 'ls -la', 1, 'sess-1')
      const writeResult = await writeEvent('/ipc/sess-1/events.jsonl', event)()
      expect(E.isRight(writeResult)).toBe(true)

      const readResult = await readEventsBySession('sess-1')()
      expect(E.isRight(readResult)).toBe(true)
      if (!E.isRight(readResult)) return

      expect(readResult.right).toHaveLength(1)
      expect(readResult.right[0]?._tag).toBe('PermissionRequest')
      if (readResult.right[0]?._tag === 'PermissionRequest') {
        expect(readResult.right[0].tool).toBe('Bash')
        expect(readResult.right[0].command).toBe('ls -la')
      }
    })

    it('writes and reads a stop event', async () => {
      const event = stopEvent('stop-1', 1, 'Last message here', 'sess-1')
      const writeResult = await writeEvent('/ipc/sess-1/events.jsonl', event)()
      expect(E.isRight(writeResult)).toBe(true)

      const readResult = await readEventsBySession('sess-1')()
      expect(E.isRight(readResult)).toBe(true)
      if (!E.isRight(readResult)) return

      expect(readResult.right).toHaveLength(1)
      expect(readResult.right[0]?._tag).toBe('Stop')
    })

    it('returns empty array for session with no events', async () => {
      const readResult = await readEventsBySession('sess-1')()
      expect(E.isRight(readResult)).toBe(true)
      if (!E.isRight(readResult)) return
      expect(readResult.right).toHaveLength(0)
    })
  })

  describe('readEventQueue (compatibility shim)', () => {
    it('extracts sessionId from file path', async () => {
      const event = permissionRequest('req-1', 'Bash', 'echo hi', 1, 'sess-1')
      await writeEvent('/ipc/sess-1/events.jsonl', event)()

      const result = await readEventQueue('/base/ipc/sess-1/events.jsonl')()
      expect(E.isRight(result)).toBe(true)
      if (!E.isRight(result)) return
      expect(result.right).toHaveLength(1)
    })
  })

  describe('markSessionEventsProcessed', () => {
    it('marks all events as processed', async () => {
      const e1 = permissionRequest('req-1', 'Bash', 'cmd1', 1, 'sess-1')
      const e2 = permissionRequest('req-2', 'Write', 'cmd2', 1, 'sess-1')
      await writeEvent('/ipc/sess-1/events.jsonl', e1)()
      await writeEvent('/ipc/sess-1/events.jsonl', e2)()

      const markResult = await markSessionEventsProcessed('sess-1')()
      expect(E.isRight(markResult)).toBe(true)

      // No more unprocessed events
      const readResult = await readEventsBySession('sess-1')()
      expect(E.isRight(readResult)).toBe(true)
      if (!E.isRight(readResult)) return
      expect(readResult.right).toHaveLength(0)
    })
  })

  describe('deleteEventFile (compatibility shim)', () => {
    it('marks events processed via path extraction', async () => {
      const event = permissionRequest('req-1', 'Bash', 'cmd', 1, 'sess-1')
      await writeEvent('/ipc/sess-1/events.jsonl', event)()

      const delResult = await deleteEventFile('/base/ipc/sess-1/events.jsonl')()
      expect(E.isRight(delResult)).toBe(true)

      const readResult = await readEventsBySession('sess-1')()
      if (!E.isRight(readResult)) return
      expect(readResult.right).toHaveLength(0)
    })
  })

  // ==========================================================================
  // Responses
  // ==========================================================================

  describe('writeResponse + readResponse', () => {
    it('writes and reads a permission response', async () => {
      // Must have an event first (FK constraint)
      const event = permissionRequest('req-1', 'Bash', 'cmd', 1, 'sess-1')
      await writeEvent('/ipc/sess-1/events.jsonl', event)()

      const writeResult = await writeResponse('/ipc/sess-1', 'req-1', { approved: true })()
      expect(E.isRight(writeResult)).toBe(true)

      const readResult = await readResponse('/ipc/sess-1', 'req-1')()
      expect(E.isRight(readResult)).toBe(true)
      if (!E.isRight(readResult)) return
      expect(readResult.right).not.toBeNull()
      expect((readResult.right as unknown as Record<string, unknown>)['approved']).toBe(true)
    })

    it('writes and reads a stop response', async () => {
      const event = stopEvent('stop-1', 1, 'msg', 'sess-1')
      await writeEvent('/ipc/sess-1/events.jsonl', event)()

      const writeResult = await writeResponse('/ipc/sess-1', 'stop-1', { instruction: 'do stuff' })()
      expect(E.isRight(writeResult)).toBe(true)

      const readResult = await readResponse('/ipc/sess-1', 'stop-1')()
      expect(E.isRight(readResult)).toBe(true)
      if (!E.isRight(readResult)) return
      expect(readResult.right?.instruction).toBe('do stuff')
    })

    it('returns null when no response exists', async () => {
      const event = permissionRequest('req-1', 'Bash', 'cmd', 1, 'sess-1')
      await writeEvent('/ipc/sess-1/events.jsonl', event)()

      const readResult = await readResponse('/ipc/sess-1', 'req-1')()
      expect(E.isRight(readResult)).toBe(true)
      if (!E.isRight(readResult)) return
      expect(readResult.right).toBeNull()
    })

    it('marks response as read after first read', async () => {
      const event = permissionRequest('req-1', 'Bash', 'cmd', 1, 'sess-1')
      await writeEvent('/ipc/sess-1/events.jsonl', event)()
      await writeResponse('/ipc/sess-1', 'req-1', { approved: false })()

      // First read succeeds
      const r1 = await readResponse('/ipc/sess-1', 'req-1')()
      expect(E.isRight(r1)).toBe(true)
      if (E.isRight(r1)) expect(r1.right).not.toBeNull()

      // Second read returns null (already read)
      const r2 = await readResponse('/ipc/sess-1', 'req-1')()
      expect(E.isRight(r2)).toBe(true)
      if (E.isRight(r2)) expect(r2.right).toBeNull()
    })
  })

  // ==========================================================================
  // No-op directory operations
  // ==========================================================================

  describe('directory operations (no-ops)', () => {
    it('listEvents returns synthetic entry', async () => {
      const result = await listEvents('/any/dir')()
      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) expect(result.right).toEqual(['events.jsonl'])
    })

    it('createIpcDir returns path', async () => {
      const result = await createIpcDir('/base', 'sess-1')()
      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) expect(result.right).toBe('/base/sess-1')
    })

    it('removeIpcDir succeeds', async () => {
      const result = await removeIpcDir('/base', 'sess-1')()
      expect(E.isRight(result)).toBe(true)
    })

    it('writeMetaFile succeeds', async () => {
      const result = await writeMetaFile('/dir', { key: 'value' })()
      expect(E.isRight(result)).toBe(true)
    })

    it('cleanOrphanedIpcDirs succeeds', async () => {
      const result = await cleanOrphanedIpcDirs('/base', new Set())()
      expect(E.isRight(result)).toBe(true)
    })
  })
})
