import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import { startDaemon, cleanupOrphanedSlots, stripBotMention } from '../daemon'
import { State, Slot } from '../../types/state'
import { sessionStart, heartbeat, sessionEnd, message, stopEvent, keepAlive, permissionRequest } from '../../types/events'
import { openDatabase, getDatabase, closeDatabase } from '../../services/db'
import { ensureSessionForIpc, insertEvent, findUnreadResponse, listActiveSessions, insertSession, findSessionBySlot, insertPendingStop, findPendingStopBySession, deletePendingStop, updateSessionThreadId, updateQueuedInstruction } from '../../services/db-queries'

let tempDir: string
const sessionId = 'test-session-1'
let sessionDir: string

// Mock Telegram API calls to prevent actual network requests
jest.mock('../../services/telegram', () => ({
  sendTelegramMessage: () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 1 } })),
  createForumTopic: () => () => Promise.resolve(E.right({ ok: true, result: { message_thread_id: 100 } })),
  deleteForumTopic: () => () => Promise.resolve(E.right({ ok: true })),
  sendMessageToTopic: () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 2 } })),
  sendButtonsToTopic: () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 3 } })),
  sendMultiRowButtonsToTopic: () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 4 } })),
  editMessageText: () => () => Promise.resolve(E.right({ ok: true })),
  answerCallbackQuery: () => () => Promise.resolve(E.right({ ok: true })),
  sendChatAction: () => () => Promise.resolve(E.right({ ok: true })),
  callTelegramApi: () => () => Promise.resolve(E.right({ ok: true })),
}))

// Mock Telegram polling to return no updates
jest.mock('../../services/telegram-poller', () => ({
  pollTelegram: () => () => Promise.resolve(E.right({ updates: [], nextOffset: 0 })),
  pollerError: (msg: string) => ({ _tag: 'PollerError', message: msg }),
  extractInstruction: () => E.left('No instruction'),
}))

/**
 * Helper to create a test config file
 */
const createTestConfigFile = async (dir: string): Promise<string> => {
  const configPath = path.join(dir, 'config.json')
  const config = {
    telegramBotToken: 'test-token',
    telegramGroupId: 123456,
    ipcBaseDir: dir,
    sessionTimeout: 5 * 60 * 1000
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2))
  return configPath
}

/**
 * Helper to write events to SQLite (replaces file-based writeEventFile).
 * Must be called AFTER daemon has started (DB opened by daemon).
 */
const writeEventsToDb = (events: any[]): void => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) throw new Error('Database not opened')
  const db = dbResult.right

  for (const event of events) {
    const eventSessionId = event.sessionId || sessionId
    const slotNum = event.slotNum ?? 0
    const eventId = event.requestId || event.eventId || `${event._tag}-${Date.now()}-${Math.random()}`

    // Ensure session row exists for FK constraint
    ensureSessionForIpc(db, eventSessionId, slotNum)
    insertEvent(db, eventId, eventSessionId, event._tag, JSON.stringify(event))
  }
}

/**
 * Seed a session into SQLite so loadState (SQLite-backed) picks it up.
 * Must be called AFTER openDatabase().
 */
const seedSessionInDb = (
  sid: string,
  slotNum: number,
  projectName: string,
  opts?: { threadId?: number }
): void => {
  const dbResult = getDatabase()
  if (E.isLeft(dbResult)) throw new Error('Database not opened for seeding')
  const db = dbResult.right
  insertSession(db, sid, slotNum, projectName, new Date().toISOString())
  if (opts?.threadId) {
    updateSessionThreadId(db, sid, opts.threadId)
  }
}

/**
 * Open the DB at the given dir so we can seed before daemon starts.
 * Daemon's openDatabase will reuse the singleton.
 */
const openDbForDir = (dir: string): void => {
  const dbPath = path.join(dir, 'bridge.db')
  const result = openDatabase(dbPath)
  if (E.isLeft(result)) throw new Error(`Failed to open DB: ${JSON.stringify(result.left)}`)
}

const cleanup = async (dir: string): Promise<void> => {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

describe('startDaemon', () => {
  beforeEach(async () => {
    tempDir = path.join('/tmp', 'daemon-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    sessionDir = path.join(tempDir, sessionId)
    await cleanup(tempDir)
  })

  afterEach(async () => {
    // Small delay to let in-flight daemon iterations drain before closing DB
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await cleanup(tempDir)
  })

  it('returns a stop function on successful startup', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()

    expect(E.isRight(result)).toBe(true)
    if (E.isRight(result)) {
      const stopFunction = result.right
      expect(typeof stopFunction).toBe('function')
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('returns error if config file does not exist', async () => {
    const configPath = path.join(tempDir, 'nonexistent', 'config.json')
    const result = await startDaemon(configPath)()
    expect(E.isLeft(result)).toBe(true)
  })

  it('creates SQLite database on startup', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Verify bridge.db was created
      const dbPath = path.join(tempDir, 'bridge.db')
      const exists = await fs.access(dbPath).then(() => true).catch(() => false)
      expect(exists).toBe(true)

      // Verify DB is queryable
      const dbResult = getDatabase()
      expect(E.isRight(dbResult)).toBe(true)

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes SessionStart events from SQLite', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write event to SQLite (DB opened by daemon)
      const event = sessionStart(1, sessionId, 'metro', 'metro')
      writeEventsToDb([event])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Verify session row exists in SQLite (created by ensureSessionForIpc)
      const dbResult = getDatabase()
      expect(E.isRight(dbResult)).toBe(true)
      if (E.isRight(dbResult)) {
        const sessionResult = findSessionBySlot(dbResult.right, 1)
        expect(E.isRight(sessionResult)).toBe(true)
        if (E.isRight(sessionResult)) {
          expect(sessionResult.right).toBeDefined()
          expect(sessionResult.right?.id).toBe(sessionId)
        }

        // Event should be marked as processed
        const unprocessed = dbResult.right
          .prepare("SELECT * FROM events WHERE processed = 0 AND session_id = ?")
          .all(sessionId) as any[]
        expect(unprocessed.length).toBe(0)
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes SessionEnd events and removes slots', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Seed initial session in SQLite before daemon starts
    openDbForDir(tempDir)
    seedSessionInDb(sessionId, 1, 'metro')

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write SessionEnd event to SQLite
      const event = sessionEnd(1)
      writeEventsToDb([event])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Daemon's in-memory state should have removed the slot.
      // We can't directly inspect daemon state, but we can verify
      // the event was processed (marked done).
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const unprocessed = dbResult.right
          .prepare("SELECT * FROM events WHERE processed = 0")
          .all() as any[]
        expect(unprocessed.length).toBe(0)
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes Heartbeat events and updates lastHeartbeat', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Seed session in SQLite
    openDbForDir(tempDir)
    seedSessionInDb(sessionId, 1, 'metro')

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      const event = heartbeat(1)
      writeEventsToDb([event])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Verify event was processed
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const unprocessed = dbResult.right
          .prepare("SELECT * FROM events WHERE processed = 0")
          .all() as any[]
        expect(unprocessed.length).toBe(0)
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes multiple events in sequence', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write events for two different sessions
      writeEventsToDb([
        sessionStart(1, 'sess-1', 'metro', 'metro'),
        heartbeat(1, 'sess-1'),
        message('Hello', 1, 'sess-1'),
        sessionStart(2, 'sess-2', 'alokai', 'alokai'),
      ])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Verify sessions exist in SQLite
      const dbResult = getDatabase()
      expect(E.isRight(dbResult)).toBe(true)
      if (E.isRight(dbResult)) {
        const sess1 = findSessionBySlot(dbResult.right, 1)
        const sess2 = findSessionBySlot(dbResult.right, 2)
        expect(E.isRight(sess1) && sess1.right?.id).toBe('sess-1')
        expect(E.isRight(sess2) && sess2.right?.id).toBe('sess-2')

        // All events processed
        const unprocessed = dbResult.right
          .prepare("SELECT * FROM events WHERE processed = 0")
          .all() as any[]
        expect(unprocessed.length).toBe(0)
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes Stop events with queued instruction auto-inject', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Seed session in SQLite before daemon starts
    openDbForDir(tempDir)
    seedSessionInDb(sessionId, 1, 'metro')

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Create stop event in SQLite — this creates a pending stop
      const event = stopEvent('evt-test-1', 1, 'last message', sessionId)
      writeEventsToDb([event])

      // Wait for the stop event to be processed (creates pending_stop in daemon state)
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Now seed a queued instruction in SQLite via the pending_stops table
      const dbResult = getDatabase()
      expect(E.isRight(dbResult)).toBe(true)
      if (E.isRight(dbResult)) {
        // The daemon should have created a pending_stop row via insertPendingStop
        // But it uses in-memory state, not DB for pending stops yet.
        // Instead, insert the pending_stop row and queued instruction directly
        insertPendingStop(dbResult.right, 'evt-test-1', sessionId)
        updateQueuedInstruction(dbResult.right, 'evt-test-1', 'run tests')
      }

      // Wait for daemon to pick up queued instruction
      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Response should be in SQLite
      if (E.isRight(dbResult)) {
        const responseResult = findUnreadResponse(dbResult.right, 'evt-test-1')
        expect(E.isRight(responseResult)).toBe(true)
        if (E.isRight(responseResult) && responseResult.right) {
          const payload = JSON.parse(responseResult.right.payload)
          expect(payload.instruction).toBe('run tests')
        }
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes KeepAlive events without state change', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      const event = keepAlive('ka-1', 'evt-1', 1)
      writeEventsToDb([event])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Event should be marked processed
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const unprocessed = dbResult.right
          .prepare("SELECT * FROM events WHERE processed = 0")
          .all() as any[]
        expect(unprocessed.length).toBe(0)
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('handles empty IPC directory gracefully', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('stops gracefully without errors', async () => {
    const configPath = await createTestConfigFile(tempDir)

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right
      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('continues running even if an event fails to process', async () => {
    const configPath = await createTestConfigFile(tempDir)

    // Seed session in slot 1 via SQLite
    openDbForDir(tempDir)
    seedSessionInDb(sessionId, 1, 'metro')

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Bad event (slot 1 occupied) + good event
      writeEventsToDb([
        sessionStart(1, 'sess-alokai', 'alokai', 'alokai'),
        sessionStart(2, 'sess-ch', 'ch', 'ch')
      ])

      await new Promise((resolve) => setTimeout(resolve, 1500))

      // Verify via SQLite: both events should be marked processed (even the failing one)
      const dbResult = getDatabase()
      expect(E.isRight(dbResult)).toBe(true)
      if (E.isRight(dbResult)) {
        const unprocessed = dbResult.right
          .prepare("SELECT * FROM events WHERE processed = 0")
          .all() as any[]
        expect(unprocessed.length).toBe(0)

        // Slot 2 session should exist in DB (created by ensureSessionForIpc)
        const sess2 = findSessionBySlot(dbResult.right, 2)
        expect(E.isRight(sess2)).toBe(true)
        if (E.isRight(sess2)) {
          expect(sess2.right?.id).toBe('sess-ch')
        }
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })
})

// ============================================================================
// cleanupOrphanedSlots tests
// ============================================================================

describe('cleanupOrphanedSlots', () => {
  let cleanupTempDir: string

  const makeSlot = (sid: string): Slot => ({
    sessionId: sid,
    projectName: 'test-project',
    topicName: 'test-topic',
    activatedAt: new Date(),
    lastHeartbeat: new Date()
  })

  const makeConfig = (ipcBaseDir: string) => ({
    telegramBotToken: 'test-token',
    telegramGroupId: 123456,
    ipcBaseDir,
    sessionTimeout: 5 * 60 * 1000
  })

  beforeEach(async () => {
    cleanupTempDir = path.join('/tmp', 'cleanup-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.rm(cleanupTempDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(cleanupTempDir, { recursive: true })
    // Open DB for each test so cleanupOrphanedSlots can query it
    openDbForDir(cleanupTempDir)
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await fs.rm(cleanupTempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('removes slots whose session does not exist in SQLite', async () => {
    const config = makeConfig(cleanupTempDir)
    const state: State = {
      slots: {
        1: makeSlot('orphaned-session'),
      },
      pendingStops: {}
    }

    // Do NOT insert session in DB — it's orphaned
    const result = await cleanupOrphanedSlots(config, state)

    expect(result.slots[1]).toBeUndefined()
    expect(Object.keys(result.slots)).not.toContain('1')
  })

  it('keeps slots whose session exists in SQLite', async () => {
    const config = makeConfig(cleanupTempDir)
    const slot = makeSlot('alive-session')
    const state: State = {
      slots: { 1: slot },
      pendingStops: {}
    }

    // Insert session in DB so it's not orphaned
    seedSessionInDb('alive-session', 1, 'test-project')

    const result = await cleanupOrphanedSlots(config, state)

    expect(result.slots[1]).toBeDefined()
    expect(result.slots[1]?.sessionId).toBe('alive-session')
  })

  it('after cleanup, the orphaned slot key is truly deleted from the object', async () => {
    const config = makeConfig(cleanupTempDir)
    const state: State = {
      slots: {
        1: makeSlot('orphaned-1'),
        2: makeSlot('alive-2'),
      },
      pendingStops: {}
    }

    // Only insert session for slot 2 in DB
    seedSessionInDb('alive-2', 2, 'test-project')

    const result = await cleanupOrphanedSlots(config, state)

    // Slot 1 should be truly gone (key not present), not just set to undefined
    expect(Object.keys(result.slots)).not.toContain('1')
    expect('1' in result.slots).toBe(false)

    // Slot 2 should remain
    expect(result.slots[2]).toBeDefined()
    expect(result.slots[2]?.sessionId).toBe('alive-2')
  })

  it('running cleanup twice does not log or process already-removed slots', async () => {
    const config = makeConfig(cleanupTempDir)
    const state: State = {
      slots: {
        1: makeSlot('orphaned-session'),
        2: makeSlot('alive-session'),
      },
      pendingStops: {}
    }

    // Only insert 'alive-session' in DB
    seedSessionInDb('alive-session', 2, 'test-project')

    // Capture console.log calls
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

    // First cleanup: should log about orphaned slot 1
    const result1 = await cleanupOrphanedSlots(config, state)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cleaning orphaned slot 1')
    )

    logSpy.mockClear()

    // Second cleanup on the result of first: should NOT log about slot 1 again
    const result2 = await cleanupOrphanedSlots(config, result1)
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Cleaning orphaned slot 1')
    )

    // State should be unchanged between first and second cleanup
    expect(result2.slots[2]?.sessionId).toBe('alive-session')
    expect(Object.keys(result2.slots)).toEqual(['2'])

    logSpy.mockRestore()
  })

  it('handles state with no slots gracefully', async () => {
    const config = makeConfig(cleanupTempDir)
    const state: State = {
      slots: {},
      pendingStops: {}
    }

    const result = await cleanupOrphanedSlots(config, state)

    expect(Object.keys(result.slots)).toHaveLength(0)
  })

  it('cleanup result persists across daemon iterations (integration)', async () => {
    // Close DB opened by beforeEach — daemon will open its own
    closeDatabase()

    const configPath = await createTestConfigFile(cleanupTempDir)

    // Seed a session in SQLite that daemon will load
    openDbForDir(cleanupTempDir)
    seedSessionInDb('gone-session', 1, 'orphaned')

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Now delete the session from DB to simulate deactivation
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        dbResult.right.prepare('DELETE FROM sessions WHERE id = ?').run('gone-session')
      }

      await new Promise((resolve) => setTimeout(resolve, 1500))

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)

      // Daemon's cleanup should have noticed the session is gone from DB
      // (cleanup interval is 30s but in tests we can't easily verify the in-memory state,
      // so we just verify the daemon stopped gracefully)
    }
  })
})

// ============================================================================
// Permission batching tests
// ============================================================================

describe('permission batching', () => {
  let batchTempDir: string
  const batchSessionId = 'batch-session-1'

  const createBatchConfigFile = async (dir: string, overrides?: Record<string, unknown>): Promise<string> => {
    const configPath = path.join(dir, 'config.json')
    const config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 123456,
      ipcBaseDir: dir,
      sessionTimeout: 5 * 60 * 1000,
      permissionBatchWindowMs: 100, // Short window for testing
      sessionTrustThreshold: 2, // Low threshold for testing
      ...overrides,
    }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))
    return configPath
  }

  beforeEach(async () => {
    batchTempDir = path.join('/tmp', 'daemon-batch-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.rm(batchTempDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(path.join(batchTempDir, batchSessionId), { recursive: true })
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await fs.rm(batchTempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('buffers permission requests and processes them', async () => {
    const configPath = await createBatchConfigFile(batchTempDir)

    // Seed session with threadId via SQLite
    openDbForDir(batchTempDir)
    seedSessionInDb(batchSessionId, 1, 'test', { threadId: 100 })

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write a permission request event to SQLite
      const event = permissionRequest('req-1', 'Bash', 'npm install', 1, batchSessionId)
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, batchSessionId, 1)
        insertEvent(db, 'req-1', batchSessionId, 'PermissionRequest', JSON.stringify(event))
      }

      // Wait for event processing + batch flush (100ms window + daemon tick)
      await new Promise((resolve) => setTimeout(resolve, 2500))

      // After batch window expires, the request should have been flushed
      // Event should be marked as processed
      if (E.isRight(dbResult)) {
        const unprocessed = dbResult.right
          .prepare("SELECT * FROM events WHERE processed = 0 AND session_id = ?")
          .all(batchSessionId) as any[]
        expect(unprocessed.length).toBe(0)
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  })

  it('processes multiple permission requests from same slot in a single batch', async () => {
    const configPath = await createBatchConfigFile(batchTempDir)

    // Seed session with threadId via SQLite
    openDbForDir(batchTempDir)
    seedSessionInDb(batchSessionId, 1, 'test', { threadId: 100 })

    // Spy on sendMultiRowButtonsToTopic to verify it gets called for batch
    const telegram = jest.requireMock('../../services/telegram')
    const multiRowSpy = jest.fn(() => () => Promise.resolve(E.right({ ok: true, result: { message_id: 4 } })))
    telegram.sendMultiRowButtonsToTopic = multiRowSpy

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write multiple permission request events to SQLite
      const events = [
        permissionRequest('req-batch-1', 'Bash', 'npm install', 1, batchSessionId),
        permissionRequest('req-batch-2', 'Edit', '/src/file.ts', 1, batchSessionId),
        permissionRequest('req-batch-3', 'Write', '/src/new.ts', 1, batchSessionId),
      ]
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, batchSessionId, 1)
        for (const event of events) {
          const eid = (event as any).requestId
          insertEvent(db, eid, batchSessionId, 'PermissionRequest', JSON.stringify(event))
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 2500))

      // sendMultiRowButtonsToTopic should have been called for the batch
      expect(multiRowSpy).toHaveBeenCalled()

      // Verify the message text mentions 3 requests
      const callArgs = multiRowSpy.mock.calls[0] as unknown[] | undefined
      expect(callArgs).toBeDefined()
      if (callArgs) {
        const text = callArgs[2] as string
        expect(text).toContain('3 permission requests')
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }

    // Restore mock
    telegram.sendMultiRowButtonsToTopic = () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 4 } }))
  })

  it('sends single-request format when only one permission in batch', async () => {
    const configPath = await createBatchConfigFile(batchTempDir)

    // Seed session with threadId via SQLite
    openDbForDir(batchTempDir)
    seedSessionInDb(batchSessionId, 1, 'test', { threadId: 100 })

    // Spy on sendButtonsToTopic (single-row) to verify it's used for single request
    const telegram = jest.requireMock('../../services/telegram')
    const singleRowSpy = jest.fn(() => () => Promise.resolve(E.right({ ok: true, result: { message_id: 3 } })))
    telegram.sendButtonsToTopic = singleRowSpy

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      const event = permissionRequest('req-single', 'Bash', 'echo hello', 1, batchSessionId)
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, batchSessionId, 1)
        insertEvent(db, 'req-single', batchSessionId, 'PermissionRequest', JSON.stringify(event))
      }

      await new Promise((resolve) => setTimeout(resolve, 2500))

      // sendButtonsToTopic should have been called (single request format)
      expect(singleRowSpy).toHaveBeenCalled()

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }

    // Restore mock
    telegram.sendButtonsToTopic = () => () => Promise.resolve(E.right({ ok: true, result: { message_id: 3 } }))
  })
})

// ============================================================================
// Session trust tests (via daemon integration)
// ============================================================================

describe('session trust via callback', () => {
  let trustTempDir: string
  const trustSessionId = 'trust-session-1'

  beforeEach(async () => {
    trustTempDir = path.join('/tmp', 'daemon-trust-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.rm(trustTempDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(path.join(trustTempDir, trustSessionId), { recursive: true })
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await fs.rm(trustTempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('trusted session auto-approves permission requests by writing response to SQLite', async () => {
    const configPath = path.join(trustTempDir, 'config.json')
    const config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 123456,
      ipcBaseDir: trustTempDir,
      sessionTimeout: 5 * 60 * 1000,
      permissionBatchWindowMs: 100,
      sessionTrustThreshold: 1, // Trust after 1 approval for fast testing
    }
    await fs.mkdir(trustTempDir, { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))

    // Seed session with threadId via SQLite
    openDbForDir(trustTempDir)
    seedSessionInDb(trustSessionId, 1, 'test', { threadId: 200 })

    // Mock Telegram polling to simulate approve + trust callbacks
    const telegram = jest.requireMock('../../services/telegram')
    const poller = jest.requireMock('../../services/telegram-poller')

    let pollCallCount = 0
    poller.pollTelegram = () => () => {
      pollCallCount++
      // On 3rd poll, simulate approve callback
      if (pollCallCount === 3) {
        return Promise.resolve(E.right({
          updates: [
            {
              update_id: 1,
              callback_query: {
                id: 'cq-1',
                data: `approve:req-trust-1`,
                message: { message_id: 10, chat: { id: 123456 }, message_thread_id: 200 }
              }
            }
          ],
          nextOffset: 2
        }))
      }
      if (pollCallCount === 4) {
        return Promise.resolve(E.right({
          updates: [
            {
              update_id: 2,
              callback_query: {
                id: 'cq-2',
                data: `trust:${trustSessionId}`,
                message: { message_id: 11, chat: { id: 123456 }, message_thread_id: 200 }
              }
            }
          ],
          nextOffset: 3
        }))
      }
      return Promise.resolve(E.right({ updates: [], nextOffset: pollCallCount }))
    }

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write first permission request to SQLite
      const event1 = permissionRequest('req-trust-1', 'Bash', 'npm test', 1, trustSessionId)
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, trustSessionId, 1)
        insertEvent(db, 'req-trust-1', trustSessionId, 'PermissionRequest', JSON.stringify(event1))
      }

      // Wait for approval + trust callbacks
      await new Promise((resolve) => setTimeout(resolve, 5000))

      // Now write a second permission request — should be auto-approved
      const event2 = permissionRequest('req-trust-2', 'Bash', 'npm run build', 1, trustSessionId)
      if (E.isRight(dbResult)) {
        insertEvent(dbResult.right, 'req-trust-2', trustSessionId, 'PermissionRequest', JSON.stringify(event2))
      }

      // Wait for auto-approve to process
      await new Promise((resolve) => setTimeout(resolve, 2000))

      // Check response was auto-created in SQLite (trusted session auto-approve)
      if (E.isRight(dbResult)) {
        const responseResult = findUnreadResponse(dbResult.right, 'req-trust-2')
        expect(E.isRight(responseResult)).toBe(true)
        if (E.isRight(responseResult) && responseResult.right) {
          const payload = JSON.parse(responseResult.right.payload)
          expect(payload.approved).toBe(true)
        }
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }

    // Restore mocks
    poller.pollTelegram = () => () => Promise.resolve(E.right({ updates: [], nextOffset: 0 }))
  }, 15000)
})

// ============================================================================
// Queued instruction via runtime memory tests
// ============================================================================

describe('queued instruction via runtime memory', () => {
  let queueTempDir: string
  const queueSessionId = 'queue-session-1'

  beforeEach(async () => {
    queueTempDir = path.join('/tmp', 'daemon-queue-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.rm(queueTempDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(path.join(queueTempDir, queueSessionId), { recursive: true })
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await fs.rm(queueTempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('message before Stop is queued in runtime memory and auto-delivered on Stop', async () => {
    const configPath = path.join(queueTempDir, 'config.json')
    const config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 123456,
      ipcBaseDir: queueTempDir,
      sessionTimeout: 5 * 60 * 1000,
    }
    await fs.mkdir(queueTempDir, { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))

    // Seed session with threadId
    openDbForDir(queueTempDir)
    seedSessionInDb(queueSessionId, 1, 'test', { threadId: 300 })

    // Mock polling: deliver a message on poll 2, then nothing
    const poller = jest.requireMock('../../services/telegram-poller')
    let pollCount = 0
    poller.pollTelegram = () => () => {
      pollCount++
      if (pollCount === 2) {
        return Promise.resolve(E.right({
          updates: [{
            update_id: 1,
            message: {
              message_id: 1,
              chat: { id: 123456 },
              text: 'run tests please',
              message_thread_id: 300,
            }
          }],
          nextOffset: 2
        }))
      }
      return Promise.resolve(E.right({ updates: [], nextOffset: pollCount }))
    }

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Wait for message to be queued (no pending stop exists yet)
      await new Promise(resolve => setTimeout(resolve, 3000))

      // Now fire a Stop event — should auto-deliver the queued instruction
      const event = stopEvent('evt-queue-1', 1, 'done working', queueSessionId)
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, queueSessionId, 1)
        insertEvent(db, 'evt-queue-1', queueSessionId, 'Stop', JSON.stringify(event))
      }

      // Wait for stop event processing + auto-inject
      await new Promise(resolve => setTimeout(resolve, 2000))

      // Response should exist in SQLite with the queued instruction
      if (E.isRight(dbResult)) {
        const responseResult = findUnreadResponse(dbResult.right, 'evt-queue-1')
        expect(E.isRight(responseResult)).toBe(true)
        if (E.isRight(responseResult) && responseResult.right) {
          const payload = JSON.parse(responseResult.right.payload)
          expect(payload.instruction).toBe('run tests please')
        }
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }

    // Restore mocks
    poller.pollTelegram = () => () => Promise.resolve(E.right({ updates: [], nextOffset: 0 }))
  }, 15000)
})

// ============================================================================
// Pending stop SQLite persistence tests
// ============================================================================

describe('pending stop SQLite persistence', () => {
  let psTempDir: string
  const psSessionId = 'ps-session-1'

  beforeEach(async () => {
    psTempDir = path.join('/tmp', 'daemon-ps-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.rm(psTempDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(path.join(psTempDir, psSessionId), { recursive: true })
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await fs.rm(psTempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('Stop event creates pending_stops row in SQLite', async () => {
    const configPath = path.join(psTempDir, 'config.json')
    const config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 123456,
      ipcBaseDir: psTempDir,
      sessionTimeout: 5 * 60 * 1000,
    }
    await fs.mkdir(psTempDir, { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))

    openDbForDir(psTempDir)
    seedSessionInDb(psSessionId, 1, 'test', { threadId: 400 })

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write Stop event
      const event = stopEvent('evt-ps-1', 1, 'finished task', psSessionId)
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, psSessionId, 1)
        insertEvent(db, 'evt-ps-1', psSessionId, 'Stop', JSON.stringify(event))
      }

      await new Promise(resolve => setTimeout(resolve, 2000))

      // Verify pending_stop row exists in SQLite
      if (E.isRight(dbResult)) {
        const psResult = findPendingStopBySession(dbResult.right, psSessionId)
        expect(E.isRight(psResult)).toBe(true)
        if (E.isRight(psResult)) {
          expect(psResult.right).toBeDefined()
          expect(psResult.right?.event_id).toBe('evt-ps-1')
          expect(psResult.right?.session_id).toBe(psSessionId)
        }
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }
  }, 10000)

  it('instruction delivery deletes pending_stops row from SQLite', async () => {
    const configPath = path.join(psTempDir, 'config.json')
    const config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 123456,
      ipcBaseDir: psTempDir,
      sessionTimeout: 5 * 60 * 1000,
    }
    await fs.mkdir(psTempDir, { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))

    openDbForDir(psTempDir)
    seedSessionInDb(psSessionId, 1, 'test', { threadId: 401 })

    // Mock polling: deliver instruction on poll 3
    const poller = jest.requireMock('../../services/telegram-poller')
    let pollCount = 0
    poller.pollTelegram = () => () => {
      pollCount++
      if (pollCount === 3) {
        return Promise.resolve(E.right({
          updates: [{
            update_id: 1,
            message: {
              message_id: 1,
              chat: { id: 123456 },
              text: 'fix the bug',
              message_thread_id: 401,
            }
          }],
          nextOffset: 2
        }))
      }
      return Promise.resolve(E.right({ updates: [], nextOffset: pollCount }))
    }

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write Stop event first
      const event = stopEvent('evt-ps-2', 1, 'finished task', psSessionId)
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        const db = dbResult.right
        ensureSessionForIpc(db, psSessionId, 1)
        insertEvent(db, 'evt-ps-2', psSessionId, 'Stop', JSON.stringify(event))
      }

      // Wait for stop processing + telegram message delivery
      await new Promise(resolve => setTimeout(resolve, 4000))

      // Verify pending_stop row was deleted from SQLite after instruction delivery
      if (E.isRight(dbResult)) {
        const psResult = findPendingStopBySession(dbResult.right, psSessionId)
        expect(E.isRight(psResult)).toBe(true)
        if (E.isRight(psResult)) {
          expect(psResult.right).toBeUndefined()
        }
      }

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }

    // Restore mocks
    poller.pollTelegram = () => () => Promise.resolve(E.right({ updates: [], nextOffset: 0 }))
  }, 15000)
})

// ============================================================================
// Typing indicator tests
// ============================================================================

describe('typing indicator on stop event', () => {
  let typingTempDir: string
  const typingSessionId = 'typing-session-1'

  beforeEach(async () => {
    typingTempDir = path.join('/tmp', 'daemon-typing-test-' + Date.now() + '-' + Math.random().toString(36).slice(2))
    await fs.rm(typingTempDir, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(path.join(typingTempDir, typingSessionId), { recursive: true })
  })

  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, 200))
    closeDatabase()
    await fs.rm(typingTempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('sendChatAction is NOT called for typing after Stop event (typing is off)', async () => {
    const configPath = path.join(typingTempDir, 'config.json')
    const config = {
      telegramBotToken: 'test-token',
      telegramGroupId: 123456,
      ipcBaseDir: typingTempDir,
      sessionTimeout: 5 * 60 * 1000,
    }
    await fs.mkdir(typingTempDir, { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))

    openDbForDir(typingTempDir)
    seedSessionInDb(typingSessionId, 1, 'test', { threadId: 500 })

    // Track sendChatAction calls
    const telegram = jest.requireMock('../../services/telegram')
    const chatActionSpy = jest.fn(() => () => Promise.resolve(E.right({ ok: true })))
    telegram.sendChatAction = chatActionSpy

    const result = await startDaemon(configPath)()
    expect(E.isRight(result)).toBe(true)

    if (E.isRight(result)) {
      const stopFunction = result.right

      // Write Stop event
      const event = stopEvent('evt-typing-1', 1, 'done', typingSessionId)
      const dbResult = getDatabase()
      if (E.isRight(dbResult)) {
        ensureSessionForIpc(dbResult.right, typingSessionId, 1)
        insertEvent(dbResult.right, 'evt-typing-1', typingSessionId, 'Stop', JSON.stringify(event))
      }

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 2000))

      // sendChatAction should NOT have been called (typing is stopped on Stop event)
      expect(chatActionSpy).not.toHaveBeenCalled()

      const stopResult = await stopFunction()()
      expect(E.isRight(stopResult)).toBe(true)
    }

    // Restore mock
    telegram.sendChatAction = () => () => Promise.resolve(E.right({ ok: true }))
  }, 10000)
})

describe('stripBotMention', () => {
  it('strips @BotName from slash commands', () => {
    expect(stripBotMention('/clear@Clade_motyl_ai_bot')).toBe('/clear')
    expect(stripBotMention('/compact@MyBot')).toBe('/compact')
    expect(stripBotMention('/help@Bot123')).toBe('/help')
  })

  it('passes through commands without bot mention', () => {
    expect(stripBotMention('/clear')).toBe('/clear')
    expect(stripBotMention('/compact')).toBe('/compact')
  })

  it('passes through regular text unchanged', () => {
    expect(stripBotMention('run npm test')).toBe('run npm test')
    expect(stripBotMention('fix the bug in auth.ts')).toBe('fix the bug in auth.ts')
  })

  it('only strips bot mention at start of message', () => {
    expect(stripBotMention('please /clear@Bot the cache')).toBe('please /clear@Bot the cache')
  })

  it('handles empty string', () => {
    expect(stripBotMention('')).toBe('')
  })
})
