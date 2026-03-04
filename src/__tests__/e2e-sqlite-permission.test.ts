/**
 * @module e2e-sqlite-permission
 * E2E integration test for the full permission flow through SQLite.
 *
 * Simulates: activate → hook writes permission event → daemon reads →
 * daemon writes response → hook polls response → deactivate → CASCADE cleanup.
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
  markResponseRead,
  deleteSession,
  listActiveSessions,
} from '../services/db-queries'

describe('E2E: SQLite Permission Flow', () => {
  beforeEach(() => {
    const dbResult = openMemoryDatabase()
    expect(E.isRight(dbResult)).toBe(true)
  })

  afterEach(() => {
    closeDatabase()
  })

  it('full permission request lifecycle through SQLite', () => {
    const dbResult = getDatabase()
    expect(E.isRight(dbResult)).toBe(true)
    if (E.isLeft(dbResult)) return
    const db = dbResult.right

    const sessionId = 'session-perm-e2e'
    const eventId = 'req-perm-001'

    // 1. Simulate /afk activate: INSERT session
    const insertResult = insertSession(db, sessionId, 1, 'my-project', new Date().toISOString())
    expect(E.isRight(insertResult)).toBe(true)

    // Verify session exists
    const sessions = listActiveSessions(db)
    expect(E.isRight(sessions)).toBe(true)
    if (E.isRight(sessions)) {
      expect(sessions.right.length).toBe(1)
      expect(sessions.right[0]!.id).toBe(sessionId)
    }

    // 2. Simulate hook: write permission_request event
    const event = {
      _tag: 'PermissionRequest' as const,
      requestId: eventId,
      slotNum: 1,
      sessionId,
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
    }
    const eventResult = insertEvent(db, eventId, sessionId, 'PermissionRequest', JSON.stringify(event))
    expect(E.isRight(eventResult)).toBe(true)

    // 3. Simulate daemon: read unprocessed events
    const unprocessed = findUnprocessedEvents(db, sessionId)
    expect(E.isRight(unprocessed)).toBe(true)
    if (E.isRight(unprocessed)) {
      expect(unprocessed.right.length).toBe(1)
      expect(unprocessed.right[0]!.event_type).toBe('PermissionRequest')
      const payload = JSON.parse(unprocessed.right[0]!.payload) as Record<string, unknown>
      expect(payload.toolName).toBe('Bash')
    }

    // 4. Simulate daemon: write approval response after Telegram callback
    const responseId = `resp-${eventId}`
    const responseResult = insertResponse(db, responseId, eventId, JSON.stringify({ approved: true }))
    expect(E.isRight(responseResult)).toBe(true)

    // 5. Simulate daemon: mark event as processed
    const markResult = markEventProcessed(db, eventId)
    expect(E.isRight(markResult)).toBe(true)

    // Verify event is now processed
    const unprocessedAfter = findUnprocessedEvents(db, sessionId)
    expect(E.isRight(unprocessedAfter)).toBe(true)
    if (E.isRight(unprocessedAfter)) {
      expect(unprocessedAfter.right.length).toBe(0)
    }

    // 6. Simulate hook: poll for response
    const response = findUnreadResponse(db, eventId)
    expect(E.isRight(response)).toBe(true)
    if (E.isRight(response)) {
      expect(response.right).not.toBeUndefined()
      const payload = JSON.parse(response.right!.payload) as Record<string, unknown>
      expect(payload.approved).toBe(true)
    }

    // 7. Simulate hook: mark response as read
    const readResult = markResponseRead(db, responseId)
    expect(E.isRight(readResult)).toBe(true)

    // Verify response is now read (no unread responses)
    const responseAfter = findUnreadResponse(db, eventId)
    expect(E.isRight(responseAfter)).toBe(true)
    if (E.isRight(responseAfter)) {
      expect(responseAfter.right).toBeUndefined()
    }

    // 8. Simulate /afk deactivate: DELETE session (CASCADE)
    const deleteResult = deleteSession(db, sessionId)
    expect(E.isRight(deleteResult)).toBe(true)

    // 9. Verify CASCADE: all related rows deleted
    const sessionsAfter = listActiveSessions(db)
    expect(E.isRight(sessionsAfter)).toBe(true)
    if (E.isRight(sessionsAfter)) {
      expect(sessionsAfter.right.length).toBe(0)
    }

    // Events should be cascade-deleted
    const eventsAfter = findUnprocessedEvents(db, sessionId)
    expect(E.isRight(eventsAfter)).toBe(true)
    if (E.isRight(eventsAfter)) {
      expect(eventsAfter.right.length).toBe(0)
    }
  })

  it('multiple sessions with independent permission flows', () => {
    const dbResult = getDatabase()
    expect(E.isRight(dbResult)).toBe(true)
    if (E.isLeft(dbResult)) return
    const db = dbResult.right

    // Create two sessions
    insertSession(db, 'session-a', 1, 'project-a', new Date().toISOString())
    insertSession(db, 'session-b', 2, 'project-b', new Date().toISOString())

    // Write events to each
    insertEvent(db, 'req-a-1', 'session-a', 'PermissionRequest', '{"tool":"Bash"}')
    insertEvent(db, 'req-b-1', 'session-b', 'PermissionRequest', '{"tool":"Write"}')

    // Verify isolation: each session sees only its own events
    const eventsA = findUnprocessedEvents(db, 'session-a')
    const eventsB = findUnprocessedEvents(db, 'session-b')
    expect(E.isRight(eventsA)).toBe(true)
    expect(E.isRight(eventsB)).toBe(true)
    if (E.isRight(eventsA)) expect(eventsA.right.length).toBe(1)
    if (E.isRight(eventsB)) expect(eventsB.right.length).toBe(1)

    // Delete session-a — session-b should be unaffected
    deleteSession(db, 'session-a')

    const eventsAAfter = findUnprocessedEvents(db, 'session-a')
    const eventsBAfter = findUnprocessedEvents(db, 'session-b')
    if (E.isRight(eventsAAfter)) expect(eventsAAfter.right.length).toBe(0)
    if (E.isRight(eventsBAfter)) expect(eventsBAfter.right.length).toBe(1)
  })
})
