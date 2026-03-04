/**
 * @module e2e-sqlite-stop
 * E2E integration test for the full stop/instruction flow through SQLite.
 *
 * Simulates: hook writes Stop event → daemon reads + creates pending_stop →
 * user replies in Telegram → daemon writes response → hook polls + gets instruction.
 */

import * as E from 'fp-ts/Either'
import { openMemoryDatabase, closeDatabase, getDatabase } from '../services/db'
import {
  insertSession,
  insertEvent,
  findUnprocessedEvents,
  markEventProcessed,
  insertResponse,
  findUnreadResponse,
  insertPendingStop,
  findPendingStopBySession,
  updateQueuedInstruction,
  deletePendingStop,
  deleteSession,
} from '../services/db-queries'

describe('E2E: SQLite Stop/Instruction Flow', () => {
  beforeEach(() => {
    const dbResult = openMemoryDatabase()
    expect(E.isRight(dbResult)).toBe(true)
  })

  afterEach(() => {
    closeDatabase()
  })

  it('full stop → instruction delivery lifecycle', () => {
    const dbResult = getDatabase()
    expect(E.isRight(dbResult)).toBe(true)
    if (E.isLeft(dbResult)) return
    const db = dbResult.right

    const sessionId = 'session-stop-e2e'
    const stopEventId = 'evt-stop-001'

    // 1. Insert session (simulate /afk activate)
    insertSession(db, sessionId, 1, 'my-project', new Date().toISOString())

    // 2. Hook writes Stop event
    const stopEvent = {
      _tag: 'Stop' as const,
      eventId: stopEventId,
      slotNum: 1,
      sessionId,
      lastMessage: 'Finished implementing the feature',
      stopHookActive: true,
    }
    const eventResult = insertEvent(db, stopEventId, sessionId, 'Stop', JSON.stringify(stopEvent))
    expect(E.isRight(eventResult)).toBe(true)

    // 3. Daemon reads unprocessed events, finds Stop
    const unprocessed = findUnprocessedEvents(db, sessionId)
    expect(E.isRight(unprocessed)).toBe(true)
    if (E.isRight(unprocessed)) {
      expect(unprocessed.right.length).toBe(1)
      expect(unprocessed.right[0]!.event_type).toBe('Stop')
    }

    // 4. Daemon creates pending_stop record
    const psResult = insertPendingStop(db, stopEventId, sessionId)
    expect(E.isRight(psResult)).toBe(true)

    // 5. Daemon marks event as processed
    markEventProcessed(db, stopEventId)

    // 6. Verify pending stop exists
    const ps = findPendingStopBySession(db, sessionId)
    expect(E.isRight(ps)).toBe(true)
    if (E.isRight(ps)) {
      expect(ps.right).toBeDefined()
      expect(ps.right!.event_id).toBe(stopEventId)
    }

    // 7. Simulate user reply in Telegram → daemon writes response
    const responseResult = insertResponse(
      db,
      `resp-${stopEventId}`,
      stopEventId,
      JSON.stringify({ instruction: 'now run the tests and fix any failures' })
    )
    expect(E.isRight(responseResult)).toBe(true)

    // 8. Hook polls and finds the response
    const response = findUnreadResponse(db, stopEventId)
    expect(E.isRight(response)).toBe(true)
    if (E.isRight(response)) {
      expect(response.right).toBeDefined()
      const payload = JSON.parse(response.right!.payload) as Record<string, unknown>
      expect(payload.instruction).toBe('now run the tests and fix any failures')
    }

    // 9. Daemon cleans up pending stop
    const deletePs = deletePendingStop(db, stopEventId)
    expect(E.isRight(deletePs)).toBe(true)

    // Verify pending stop is gone
    const psAfter = findPendingStopBySession(db, sessionId)
    expect(E.isRight(psAfter)).toBe(true)
    if (E.isRight(psAfter)) {
      expect(psAfter.right).toBeUndefined()
    }
  })

  it('queued instruction flow: message arrives before stop', () => {
    const dbResult = getDatabase()
    expect(E.isRight(dbResult)).toBe(true)
    if (E.isLeft(dbResult)) return
    const db = dbResult.right

    const sessionId = 'session-queue-e2e'
    const stopEventId = 'evt-stop-002'

    // 1. Set up session
    insertSession(db, sessionId, 2, 'other-project', new Date().toISOString())

    // 2. Stop event arrives, daemon creates pending_stop
    insertEvent(db, stopEventId, sessionId, 'Stop', '{}')
    insertPendingStop(db, stopEventId, sessionId)

    // 3. A message arrives while waiting — daemon queues it
    const queueResult = updateQueuedInstruction(db, stopEventId, 'please deploy to staging')
    expect(E.isRight(queueResult)).toBe(true)

    // 4. Verify queued instruction is stored
    const ps = findPendingStopBySession(db, sessionId)
    expect(E.isRight(ps)).toBe(true)
    if (E.isRight(ps)) {
      expect(ps.right!.queued_instruction).toBe('please deploy to staging')
    }

    // 5. Daemon auto-delivers queued instruction as response
    insertResponse(db, `resp-${stopEventId}`, stopEventId, JSON.stringify({
      instruction: 'please deploy to staging'
    }))

    // 6. Hook reads response
    const response = findUnreadResponse(db, stopEventId)
    expect(E.isRight(response)).toBe(true)
    if (E.isRight(response)) {
      const payload = JSON.parse(response.right!.payload) as Record<string, unknown>
      expect(payload.instruction).toBe('please deploy to staging')
    }

    // 7. Cleanup
    deletePendingStop(db, stopEventId)
    deleteSession(db, sessionId)

    // 8. Verify full cascade cleanup
    const sessionsAfter = findPendingStopBySession(db, sessionId)
    if (E.isRight(sessionsAfter)) {
      expect(sessionsAfter.right).toBeUndefined()
    }
  })

  it('multiple stop events across sessions are isolated', () => {
    const dbResult = getDatabase()
    expect(E.isRight(dbResult)).toBe(true)
    if (E.isLeft(dbResult)) return
    const db = dbResult.right

    // Two sessions
    insertSession(db, 'sess-1', 1, 'proj-1', new Date().toISOString())
    insertSession(db, 'sess-2', 2, 'proj-2', new Date().toISOString())

    // Each has a stop event + pending stop
    insertEvent(db, 'stop-1', 'sess-1', 'Stop', '{}')
    insertEvent(db, 'stop-2', 'sess-2', 'Stop', '{}')
    insertPendingStop(db, 'stop-1', 'sess-1')
    insertPendingStop(db, 'stop-2', 'sess-2')

    // Reply to session 1 only
    insertResponse(db, 'resp-1', 'stop-1', JSON.stringify({ instruction: 'fix bug' }))

    // Session 1 has a response, session 2 does not
    const resp1 = findUnreadResponse(db, 'stop-1')
    const resp2 = findUnreadResponse(db, 'stop-2')
    if (E.isRight(resp1)) expect(resp1.right).toBeDefined()
    if (E.isRight(resp2)) expect(resp2.right).toBeUndefined()

    // Delete session 1 — session 2 unaffected
    deleteSession(db, 'sess-1')
    const ps2 = findPendingStopBySession(db, 'sess-2')
    if (E.isRight(ps2)) {
      expect(ps2.right).toBeDefined()
      expect(ps2.right!.event_id).toBe('stop-2')
    }
  })
})
