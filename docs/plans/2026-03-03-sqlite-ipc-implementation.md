# SQLite IPC Replacement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace file-based IPC (JSONL events, JSON responses, state.json, bound_session files) with a single SQLite database (`bridge.db`) to eliminate race conditions and enable cross-platform support.

**Architecture:** Single `bridge.db` with WAL mode. `better-sqlite3` for synchronous access (fits hook's blocking model). All DB operations wrapped in `TaskEither<DbError, T>`. One-file-per-topic isolation replaced by table-level session isolation with ACID transactions.

**Tech Stack:** `better-sqlite3` (sync SQLite), `fp-ts` (existing), Jest (existing), esbuild (existing)

**Design Doc:** `docs/plans/2026-03-03-sqlite-ipc-design.md`

---

## Phase 1: Database Foundation

### Task 1.1: Add better-sqlite3 dependency and types

**Files:**
- Modify: `package.json`

**Step 1: Install better-sqlite3**

Run: `cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge && npm install better-sqlite3 && npm install -D @types/better-sqlite3`

Expected: package.json updated, node_modules installed

**Step 2: Verify TypeScript types resolve**

Run: `npx tsc --noEmit`

Expected: No new type errors

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add better-sqlite3 dependency for SQLite IPC"
```

---

### Task 1.2: Create DbError type and DB connection module

**Files:**
- Create: `src/types/db.ts`
- Create: `src/services/db.ts`
- Create: `src/services/__tests__/db.test.ts`

**Step 1: Write DbError type**

`src/types/db.ts`:
```typescript
export type DbError =
  | { readonly _tag: 'ConnectionError'; readonly message: string }
  | { readonly _tag: 'QueryError'; readonly message: string; readonly query: string }
  | { readonly _tag: 'ConstraintError'; readonly constraint: string }
  | { readonly _tag: 'BusyError'; readonly retryAfterMs: number }

export const connectionError = (message: string): DbError => ({ _tag: 'ConnectionError', message })
export const queryError = (message: string, query: string): DbError => ({ _tag: 'QueryError', message, query })
export const constraintError = (constraint: string): DbError => ({ _tag: 'ConstraintError', constraint })
export const busyError = (retryAfterMs: number): DbError => ({ _tag: 'BusyError', retryAfterMs })
```

**Step 2: Write failing tests for DB connection**

`src/services/__tests__/db.test.ts`:
```typescript
import * as E from 'fp-ts/Either'
import * as TE from 'fp-ts/TaskEither'
import { pipe } from 'fp-ts/function'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

// Tests to write:
// 1. openDatabase creates bridge.db at given path
// 2. openDatabase creates schema tables on first open
// 3. openDatabase with existing DB doesn't recreate tables
// 4. openDatabase sets WAL mode
// 5. openDatabase sets busy_timeout
// 6. openDatabase sets foreign_keys
// 7. closeDatabase closes connection
// 8. openDatabase with invalid path returns ConnectionError
// 9. getDatabase returns connection after open
// 10. Schema has all expected tables: sessions, events, responses, permission_batches, permission_batch_items, pending_stops, known_topics
// 11. Schema has expected indexes
// 12. PRAGMA user_version is set to 1 after migration
```

Run: `npx jest src/services/__tests__/db.test.ts --verbose`
Expected: FAIL (module doesn't exist)

**Step 3: Implement DB connection module**

`src/services/db.ts`:
```typescript
import Database from 'better-sqlite3'
import * as E from 'fp-ts/Either'
import * as TE from 'fp-ts/TaskEither'
import { pipe } from 'fp-ts/function'
import { DbError, connectionError, queryError } from '../types/db'

const SCHEMA_VERSION = 1

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  slot_num INTEGER NOT NULL,
  claude_session_id TEXT UNIQUE,
  project_name TEXT,
  thread_id INTEGER,
  activated_at TEXT NOT NULL,
  last_heartbeat TEXT,
  trusted INTEGER DEFAULT 0,
  approval_count INTEGER DEFAULT 0,
  UNIQUE(slot_num)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed INTEGER DEFAULT 0,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  payload TEXT NOT NULL,
  read INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS permission_batches (
  batch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  slot_num INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  flushed_at TEXT,
  telegram_message_id INTEGER,
  status TEXT DEFAULT 'buffering'
);

CREATE TABLE IF NOT EXISTS permission_batch_items (
  batch_id TEXT NOT NULL REFERENCES permission_batches(batch_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, event_id)
);

CREATE TABLE IF NOT EXISTS pending_stops (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  telegram_message_id INTEGER,
  queued_instruction TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS known_topics (
  thread_id INTEGER PRIMARY KEY,
  topic_name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session_unprocessed
  ON events(session_id, processed) WHERE processed = 0;
CREATE INDEX IF NOT EXISTS idx_responses_event
  ON responses(event_id) WHERE read = 0;
CREATE INDEX IF NOT EXISTS idx_sessions_slot
  ON sessions(slot_num);
`

let db: Database.Database | null = null

export const openDatabase = (dbPath: string): E.Either<DbError, Database.Database> => {
  try {
    const instance = new Database(dbPath)
    instance.pragma('journal_mode = WAL')
    instance.pragma('busy_timeout = 5000')
    instance.pragma('foreign_keys = ON')

    const version = instance.pragma('user_version', { simple: true }) as number
    if (version < SCHEMA_VERSION) {
      instance.exec(SCHEMA_SQL)
      instance.pragma(`user_version = ${SCHEMA_VERSION}`)
    }

    db = instance
    return E.right(instance)
  } catch (err) {
    return E.left(connectionError(err instanceof Error ? err.message : String(err)))
  }
}

export const closeDatabase = (): E.Either<DbError, void> => {
  try {
    if (db) {
      db.close()
      db = null
    }
    return E.right(undefined)
  } catch (err) {
    return E.left(connectionError(err instanceof Error ? err.message : String(err)))
  }
}

export const getDatabase = (): E.Either<DbError, Database.Database> =>
  db ? E.right(db) : E.left(connectionError('Database not opened'))
```

**Step 4: Run tests**

Run: `npx jest src/services/__tests__/db.test.ts --verbose`
Expected: All pass

**Step 5: Commit**

```bash
git add src/types/db.ts src/services/db.ts src/services/__tests__/db.test.ts
git commit -m "feat: add SQLite database layer with schema and connection management"
```

---

### Task 1.3: Create DB query helpers (typed wrappers)

**Files:**
- Create: `src/services/db-queries.ts`
- Create: `src/services/__tests__/db-queries.test.ts`

**Purpose:** Typed insert/select/update/delete functions for each table. All return `Either<DbError, T>`. These replace the raw SQL scattered throughout the codebase.

**Tables to cover with typed helpers:**

1. **sessions** — insertSession, findSessionBySlot, findSessionByClaudeId, updateSessionBinding, updateSessionHeartbeat, updateSessionTrust, deleteSession, listActiveSessions
2. **events** — insertEvent, findUnprocessedEvents, markEventProcessed, deleteSessionEvents
3. **responses** — insertResponse, findUnreadResponse, markResponseRead
4. **permission_batches** — insertBatch, addBatchItem, findBufferingBatches, flushBatch, resolveBatch
5. **pending_stops** — insertPendingStop, findPendingStopBySlot, updateQueuedInstruction, deletePendingStop
6. **known_topics** — insertKnownTopic, markTopicDeleted, findActiveTopics

**Step 1: Write failing tests** — Cover each function with happy path + error cases

**Step 2: Implement each function group** — Follow existing fp-ts pattern (Either/TaskEither returns)

**Step 3: Run tests**

Run: `npx jest src/services/__tests__/db-queries.test.ts --verbose`
Expected: All pass

**Step 4: Commit**

```bash
git add src/services/db-queries.ts src/services/__tests__/db-queries.test.ts
git commit -m "feat: add typed SQLite query helpers for all tables"
```

---

## Phase 2: Replace IPC Service

### Task 2.1: Create SQLite-backed IPC service

**Files:**
- Create: `src/services/ipc-sqlite.ts`
- Create: `src/services/__tests__/ipc-sqlite.test.ts`

**Purpose:** Drop-in replacement for `src/services/ipc.ts`. Same function signatures but backed by SQLite instead of files.

**Functions to implement (matching existing IPC interface):**

```typescript
// Replaces writeEventAtomic — INSERT INTO events
export const writeEvent = (db: Database, sessionId: string, event: IpcEvent): E.Either<DbError, void>

// Replaces listEvents + readEventQueue — SELECT FROM events WHERE processed = 0
export const readUnprocessedEvents = (db: Database, sessionId: string): E.Either<DbError, IpcEvent[]>

// Replaces deleteEventFile — UPDATE events SET processed = 1
export const markEventsProcessed = (db: Database, eventIds: string[]): E.Either<DbError, void>

// Replaces writeResponse — INSERT INTO responses
export const writeResponse = (db: Database, eventId: string, payload: Record<string, unknown>): E.Either<DbError, void>

// Replaces readResponse — SELECT FROM responses WHERE event_id = ? AND read = 0
export const readResponse = (db: Database, eventId: string): E.Either<DbError, Record<string, unknown> | null>

// Replaces deleteResponseFile — UPDATE responses SET read = 1
export const markResponseRead = (db: Database, eventId: string): E.Either<DbError, void>
```

**Key difference from file-based:** All operations are synchronous (better-sqlite3) and wrapped in `E.Either`. No need for `TaskEither` since there's no async I/O.

**Step 1: Write failing tests** — Mirror existing `ipc.test.ts` test cases but with SQLite

**Step 2: Implement** — Each function is a prepared statement + run/get/all

**Step 3: Run tests**

Run: `npx jest src/services/__tests__/ipc-sqlite.test.ts --verbose`
Expected: All pass

**Step 4: Commit**

```bash
git add src/services/ipc-sqlite.ts src/services/__tests__/ipc-sqlite.test.ts
git commit -m "feat: add SQLite-backed IPC service replacing file-based JSONL"
```

---

### Task 2.2: Create SQLite-backed state service

**Files:**
- Create: `src/services/state-sqlite.ts`
- Create: `src/services/__tests__/state-sqlite.test.ts`

**Purpose:** Replace `state-persistence.ts` (state.json) with sessions table operations.

**Functions:**

```typescript
// Replaces loadState — SELECT all from sessions + pending_stops
export const loadState = (db: Database): E.Either<DbError, State>

// Replaces saveState — Not needed anymore! Individual operations are atomic.
// Instead, provide granular operations:
export const addSession = (db: Database, slotNum: number, slot: Slot): E.Either<DbError, void>
export const removeSession = (db: Database, sessionId: string): E.Either<DbError, void>
export const updateHeartbeat = (db: Database, sessionId: string, now: Date): E.Either<DbError, void>
export const bindClaudeSession = (db: Database, sessionId: string, claudeSessionId: string): E.Either<DbError, void>
export const findBoundSession = (db: Database, claudeSessionId: string): E.Either<DbError, BoundSession | null>
export const setSessionTrusted = (db: Database, sessionId: string): E.Either<DbError, void>
export const incrementApprovalCount = (db: Database, sessionId: string): E.Either<DbError, number>
export const cleanupStaleSessions = (db: Database, timeoutMs: number, now: Date): E.Either<DbError, void>
```

**Key insight:** No more "load entire state → modify → save entire state" pattern. Each mutation is an atomic SQL operation. This eliminates the read-modify-write race condition that plagues state.json.

**Step 1: Write failing tests**

**Step 2: Implement**

**Step 3: Run tests**

Run: `npx jest src/services/__tests__/state-sqlite.test.ts --verbose`
Expected: All pass

**Step 4: Commit**

```bash
git add src/services/state-sqlite.ts src/services/__tests__/state-sqlite.test.ts
git commit -m "feat: add SQLite-backed state service replacing state.json"
```

---

### Task 2.3: Create SQLite-backed permission batch service

**Files:**
- Create: `src/services/batch-sqlite.ts`
- Create: `src/services/__tests__/batch-sqlite.test.ts`

**Purpose:** Replace in-memory `runtime.permissionBatches` and `runtime.pendingBatches` with `permission_batches` + `permission_batch_items` tables.

**Functions:**

```typescript
// Buffer a permission request into a batch
export const bufferPermission = (db: Database, slotNum: number, sessionId: string, eventId: string): E.Either<DbError, string>
// Returns batchId (creates new batch if none buffering for this slot)

// Get batches ready to flush (oldest entry > windowMs)
export const getFlushableBatches = (db: Database, windowMs: number): E.Either<DbError, FlushableBatch[]>

// Mark batch as flushed with telegram message info
export const flushBatch = (db: Database, batchId: string, telegramMessageId: number): E.Either<DbError, void>

// Resolve batch (approve/deny all items)
export const resolveBatch = (db: Database, batchId: string, approved: boolean, approvedBy?: string): E.Either<DbError, string[]>
// Returns list of eventIds that were resolved

// Resolve single item from batch
export const resolveBatchItem = (db: Database, eventId: string, approved: boolean): E.Either<DbError, void>

// Find batch by batchId (for callback routing)
export const findBatch = (db: Database, batchId: string): E.Either<DbError, BatchInfo | null>
```

**Step 1: Write failing tests**

**Step 2: Implement**

**Step 3: Run tests**

Run: `npx jest src/services/__tests__/batch-sqlite.test.ts --verbose`
Expected: All pass

**Step 4: Commit**

```bash
git add src/services/batch-sqlite.ts src/services/__tests__/batch-sqlite.test.ts
git commit -m "feat: add SQLite-backed permission batch service"
```

---

## Phase 3: Daemon Integration

### Task 3.1: Refactor daemon to use SQLite services

**Files:**
- Modify: `src/bridge/daemon.ts` (1,211 lines — major refactor)
- Modify: `src/bridge/__tests__/daemon.test.ts`

**This is the largest task.** The daemon currently:
1. Scans IPC directories for event files → Replace with `readUnprocessedEvents(db, sessionId)`
2. Writes response files → Replace with `writeResponse(db, eventId, payload)`
3. Loads/saves state.json → Replace with granular SQLite operations
4. Manages in-memory permission batches → Replace with `batch-sqlite` service
5. Tracks processed events in runtime Sets → Replace with `events.processed` flag
6. Manages known_topics.jsonl → Replace with `known_topics` table

**Refactor strategy:** Change daemon to accept a `Database` instance instead of file paths. Each subsystem swap is independent.

**Sub-steps:**

**Step 1: Update DaemonRuntime** — Remove file-based fields, add `db: Database`

Remove from runtime:
- `processedStopEvents: Set<string>` → use `events.processed` column
- `processedRequestIds: Set<string>` → use `events.processed` column
- `permissionBatches: Map` → use `batch-sqlite` service
- `pendingBatches: Map` → use `batch-sqlite` service
- `approvalCounts: Map` → use `sessions.approval_count` column
- `trustedSessions: Set` → use `sessions.trusted` column

Add to runtime:
- `db: Database`

**Step 2: Update startDaemon()** — Open DB on startup

```typescript
// Before: loadState(stateFile)
// After:  openDatabase(dbPath) → loadState(db)
```

**Step 3: Update processAllEvents()** — Replace file scanning with DB query

```typescript
// Before: scan ipc/{sessionId}/ for .jsonl files, read each, parse
// After:  for each active session → readUnprocessedEvents(db, sessionId)
```

**Step 4: Update processEventSideEffects()** — Replace file writes with DB inserts

```typescript
// Before: writeResponse(ipcDir, requestId, {approved: true})
// After:  writeResponse(db, requestId, {approved: true})
```

**Step 5: Update flushPermissionBatches()** — Use batch-sqlite service

**Step 6: Update handleCallbackQuery()** — Use batch-sqlite for resolution

**Step 7: Update state mutations** — Replace saveState() calls with granular DB operations

**Step 8: Update known_topics management** — Replace JSONL append with DB insert

**Step 9: Update cleanup/teardown** — closeDatabase() on shutdown

**Step 10: Write/update tests** — Use in-memory SQLite (`:memory:`) for fast tests

Run: `npx jest src/bridge/__tests__/daemon.test.ts --verbose`
Expected: All pass

**Step 11: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 12: Commit**

```bash
git add src/bridge/daemon.ts src/bridge/__tests__/daemon.test.ts
git commit -m "refactor: daemon uses SQLite for state, events, responses, and batches"
```

---

## Phase 4: Hook Integration

### Task 4.1: Refactor hook to use SQLite

**Files:**
- Modify: `src/hook/index.ts` (425 lines)
- Modify: `src/hook/permission.ts` (159 lines)
- Modify: `src/hook/stop.ts` (267 lines)
- Modify: `src/hook/__tests__/index.test.ts`
- Modify: `src/hook/__tests__/permission.test.ts`
- Modify: `src/hook/__tests__/stop.test.ts`

**Hook changes:**

**`permission.ts` — requestPermission()**
```typescript
// Before:
//   writeEventAtomic(ipcDir, event) → poll response-{requestId}.json every 100ms
// After:
//   writeEvent(db, sessionId, event) → poll SELECT FROM responses WHERE event_id = ? every 100ms
```

**`stop.ts` — handleStopRequest()**
```typescript
// Before:
//   writeEventAtomic(ipcDir, event) → poll response-{eventId}.json + send KeepAlive files
// After:
//   writeEvent(db, sessionId, event) → poll SELECT FROM responses + INSERT KeepAlive events
```

**`index.ts` — runHook()**
```typescript
// Before:
//   resolveSession reads state.json + bound_session files
// After:
//   resolveSession queries sessions table + updates claude_session_id
```

**Key: Hook opens same bridge.db as daemon.** WAL mode ensures hook reads don't block daemon writes.

**Step 1: Update permission.ts** — Replace file ops with DB queries

**Step 2: Update stop.ts** — Replace file ops with DB queries

**Step 3: Update index.ts** — Replace session resolution with DB queries

**Step 4: Update all hook tests** — Use in-memory SQLite

Run: `npx jest src/hook/__tests__/ --verbose`
Expected: All pass

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/hook/
git commit -m "refactor: hook uses SQLite for events, responses, and session binding"
```

---

### Task 4.2: Refactor CLI activate/deactivate to use SQLite

**Files:**
- Modify: `src/cli/activate.ts`
- Modify: `src/cli/deactivate.ts`
- Modify: `src/cli/__tests__/` (if exists)

**activate.ts changes:**
```typescript
// Before: create IPC dir, write meta.json, update state.json
// After:  INSERT INTO sessions, INSERT INTO known_topics
```

**deactivate.ts changes:**
```typescript
// Before: read state.json, remove slot, delete IPC dir, save state.json
// After:  DELETE FROM sessions WHERE id = ? (CASCADE clears events/responses)
```

**Step 1: Update activate.ts**

**Step 2: Update deactivate.ts**

**Step 3: Run tests**

Run: `npm test`
Expected: All pass

**Step 4: Commit**

```bash
git add src/cli/
git commit -m "refactor: CLI activate/deactivate uses SQLite"
```

---

## Phase 5: Cleanup

### Task 5.1: Delete old file-based services

**Files:**
- Delete: `src/services/ipc.ts` (346 lines)
- Delete: `src/services/state-persistence.ts` (162 lines)
- Delete: `src/services/session-binding.ts` (150 lines)
- Delete: `src/services/file-lock.ts`
- Delete: `src/services/instruction-writer.ts`
- Delete: `src/services/queued-instruction.ts`
- Delete: `src/services/__tests__/ipc.test.ts`
- Delete: `src/services/__tests__/state-persistence.test.ts`
- Delete: `src/services/__tests__/session-binding.test.ts`
- Delete: corresponding test files for deleted modules

**Step 1: Verify no imports reference old modules**

Run: `grep -r "from.*services/ipc" src/ --include="*.ts" | grep -v ipc-sqlite | grep -v __tests__`
Run: `grep -r "from.*services/state-persistence" src/ --include="*.ts" | grep -v __tests__`
Run: `grep -r "from.*services/session-binding" src/ --include="*.ts" | grep -v __tests__`
Run: `grep -r "from.*services/file-lock" src/ --include="*.ts" | grep -v __tests__`
Run: `grep -r "from.*services/instruction-writer" src/ --include="*.ts" | grep -v __tests__`
Run: `grep -r "from.*services/queued-instruction" src/ --include="*.ts" | grep -v __tests__`

Expected: No results (all imports updated in Phase 3-4)

**Step 2: Delete files**

**Step 3: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 4: Remove `proper-lockfile` dependency** (no longer needed)

Run: `npm uninstall proper-lockfile`

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove file-based IPC, state-persistence, session-binding, file-lock"
```

---

### Task 5.2: Delete Qwen bridge references

**Files:**
- Modify: `notes/telegram-bridge/PROJECT.md` — Remove Qwen section
- Check/clean any Qwen references in source

**Step 1: Remove Qwen references from PROJECT.md**

**Step 2: Search for any Qwen references in source**

Run: `grep -ri "qwen" src/ --include="*.ts"`

Expected: No results (Qwen was a separate repo)

**Step 3: Commit**

```bash
git add notes/telegram-bridge/PROJECT.md
git commit -m "chore: remove Qwen bridge references from PROJECT.md"
```

---

### Task 5.3: Update build and deployment scripts

**Files:**
- Modify: `build.mjs` — Ensure `better-sqlite3` is externalized (native module, can't bundle)
- Modify: `scripts/install-ts.sh` — Remove IPC dir creation, add bridge.db path
- Modify: `scripts/switch-to-ts.sh` — Update if needed
- Delete: `scripts/switch-to-python.sh` — Python version no longer relevant after SQLite migration

**Step 1: Update esbuild config** — Mark `better-sqlite3` as external

```javascript
// build.mjs — add to esbuild options:
external: ['better-sqlite3']
```

**Step 2: Update install script** — Remove IPC directory setup

**Step 3: Verify build**

Run: `npm run build`
Expected: Clean build, no warnings

**Step 4: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 5: Commit**

```bash
git add build.mjs scripts/
git commit -m "chore: update build config for better-sqlite3 native module"
```

---

### Task 5.4: Update /afk-reset to delete bridge.db

**Files:**
- Modify: wherever `/afk-reset` is implemented (CLI or skill)

**Reset logic:**
```typescript
// Before: scan known_topics.jsonl → delete topics → rm -rf ipc/ → delete state.json
// After:  SELECT FROM known_topics WHERE deleted_at IS NULL → delete topics from Telegram → rm bridge.db
```

**Step 1: Update reset handler**

**Step 2: Test manually** — Activate session, reset, verify bridge.db deleted and topics cleaned

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: /afk-reset deletes bridge.db for clean SQLite reset"
```

---

## Phase 6: End-to-End Validation

### Task 6.1: Integration test — full permission flow through SQLite

**Files:**
- Create: `src/__tests__/e2e-sqlite-permission.test.ts`

**Test scenario:**
1. Open in-memory DB
2. Insert session (simulate `/afk activate`)
3. Write permission_request event (simulate hook)
4. Read unprocessed events (simulate daemon)
5. Write response (simulate daemon after Telegram callback)
6. Read response (simulate hook poll)
7. Verify response matches, mark read
8. Delete session (simulate `/afk deactivate`)
9. Verify CASCADE clears all related rows

**Step 1: Write test**

**Step 2: Run test**

Run: `npx jest src/__tests__/e2e-sqlite-permission.test.ts --verbose`
Expected: Pass

**Step 3: Commit**

```bash
git add src/__tests__/e2e-sqlite-permission.test.ts
git commit -m "test: add e2e integration test for SQLite permission flow"
```

---

### Task 6.2: Integration test — full stop/instruction flow through SQLite

**Files:**
- Create: `src/__tests__/e2e-sqlite-stop.test.ts`

**Test scenario:**
1. Open in-memory DB
2. Insert session
3. Write stop event (hook)
4. Daemon reads event, inserts pending_stop
5. Simulate user reply: insert response
6. Hook polls, finds response
7. Verify instruction delivered correctly

**Step 1: Write test**

**Step 2: Run test**

Run: `npx jest src/__tests__/e2e-sqlite-stop.test.ts --verbose`
Expected: Pass

**Step 3: Commit**

```bash
git add src/__tests__/e2e-sqlite-stop.test.ts
git commit -m "test: add e2e integration test for SQLite stop/instruction flow"
```

---

### Task 6.3: Full test suite + typecheck + build

**Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Run full test suite**

Run: `npm test`
Expected: All pass

**Step 3: Run build**

Run: `npm run build`
Expected: Clean build

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: SQLite IPC migration complete — all tests passing"
```

---

## Task Summary

| Phase | Task | Description | Estimated Complexity |
|-------|------|-------------|---------------------|
| 1 | 1.1 | Add better-sqlite3 dependency | Small |
| 1 | 1.2 | DB connection + schema module | Medium |
| 1 | 1.3 | Typed query helpers | Medium |
| 2 | 2.1 | SQLite-backed IPC service | Medium |
| 2 | 2.2 | SQLite-backed state service | Medium |
| 2 | 2.3 | SQLite-backed batch service | Medium |
| 3 | 3.1 | Daemon refactor to SQLite | Large |
| 4 | 4.1 | Hook refactor to SQLite | Large |
| 4 | 4.2 | CLI activate/deactivate refactor | Small |
| 5 | 5.1 | Delete old file-based services | Small |
| 5 | 5.2 | Delete Qwen bridge references | Small |
| 5 | 5.3 | Update build/deploy scripts | Small |
| 5 | 5.4 | Update /afk-reset | Small |
| 6 | 6.1 | E2E test: permission flow | Medium |
| 6 | 6.2 | E2E test: stop/instruction flow | Medium |
| 6 | 6.3 | Full validation | Small |

**Total: 16 tasks across 6 phases**

---

## Notes for Implementer

1. **In-memory SQLite for tests:** Use `new Database(':memory:')` — fast, isolated, no cleanup needed
2. **WAL mode only works on disk:** In-memory DBs don't need WAL. Tests can skip WAL verification.
3. **better-sqlite3 is synchronous:** All operations are `E.Either`, not `TE.TaskEither`. This simplifies the hook (which blocks anyway) and the daemon (which runs a sync loop).
4. **CASCADE deletes:** When a session is deleted, all its events, responses, batches, and pending stops are automatically deleted. This replaces the manual `rm -rf ipc/{sessionId}/` cleanup.
5. **No migration from Python:** The Python version uses completely different file formats. Users switching from Python to SQLite will need to `/afk-reset` first (clean start).
6. **esbuild external:** `better-sqlite3` is a native Node module and CANNOT be bundled by esbuild. It must be marked as external and installed separately in the target environment.
