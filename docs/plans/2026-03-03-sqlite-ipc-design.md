# SQLite IPC Replacement Design

**Date:** 2026-03-03
**Status:** Approved
**Scope:** Replace file-based IPC (JSONL events, JSON responses, state.json, known_topics.jsonl) with single SQLite database

---

## Problem

Current file-based IPC has race conditions with multiple topics, requires custom dedup logic, and uses scattered files (`event-*.jsonl`, `response-*.json`, `state.json`, `known_topics.jsonl`, `bound_session`, `queued_instruction.json`). Not reliably cross-platform.

## Decision

Single `bridge.db` SQLite database replaces all IPC files. WAL mode enables concurrent read/write without blocking. ACID transactions eliminate race conditions.

## Requirements

- **Correctness first**: Guaranteed delivery while daemon is running
- **Cross-platform**: macOS, Linux, Windows (same code)
- **Session-scoped**: Queue destroyed on session end / `/afk-reset`
- **Topic isolation**: S1-S4 separate, no cross-contamination
- **Best-effort recovery**: Notify user on daemon crash, user retries

## Architecture

### File Structure

```
~/.claude/hooks/telegram-bridge/
├── config.json          (unchanged - user-editable)
├── bridge.db            (NEW - replaces state.json, ipc/*, known_topics.jsonl)
└── daemon.log           (unchanged)
```

### Schema

```sql
-- Slot/session management (replaces state.json slots)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  slot_num INTEGER NOT NULL,
  claude_session_id TEXT UNIQUE,
  project_name TEXT,
  thread_id INTEGER,
  activated_at DATETIME NOT NULL,
  last_heartbeat DATETIME,
  trusted BOOLEAN DEFAULT FALSE,
  approval_count INTEGER DEFAULT 0,
  UNIQUE(slot_num)
);

-- All IPC events (replaces event-{uuid}.jsonl files)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  event_type TEXT NOT NULL,
  payload JSON NOT NULL,
  processed BOOLEAN DEFAULT FALSE,
  processed_at DATETIME
);

-- Daemon → Hook responses (replaces response-{eventId}.json files)
CREATE TABLE responses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  payload JSON NOT NULL,
  read BOOLEAN DEFAULT FALSE
);

-- Permission batch grouping
CREATE TABLE permission_batches (
  batch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  slot_num INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  flushed_at DATETIME,
  telegram_message_id INTEGER,
  status TEXT DEFAULT 'buffering'
);

CREATE TABLE permission_batch_items (
  batch_id TEXT NOT NULL REFERENCES permission_batches(batch_id),
  event_id TEXT NOT NULL REFERENCES events(id),
  PRIMARY KEY (batch_id, event_id)
);

-- Pending stop events awaiting user instruction
CREATE TABLE pending_stops (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  telegram_message_id INTEGER,
  queued_instruction TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Known topics for crash recovery / afk-reset cleanup
CREATE TABLE known_topics (
  thread_id INTEGER PRIMARY KEY,
  topic_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME
);

-- Indexes
CREATE INDEX idx_events_session_unprocessed
  ON events(session_id, processed) WHERE processed = FALSE;
CREATE INDEX idx_responses_event
  ON responses(event_id) WHERE read = FALSE;
CREATE INDEX idx_sessions_slot
  ON sessions(slot_num);
```

### File Replacement Map

| Current File | SQLite Replacement |
|---|---|
| `state.json` (slots) | `sessions` table |
| `ipc/{id}/event-*.jsonl` | `events` table |
| `ipc/{id}/response-*.json` | `responses` table |
| `ipc/{id}/bound_session` | `sessions.claude_session_id` |
| `ipc/{id}/queued_instruction.json` | `pending_stops.queued_instruction` |
| `known_topics.jsonl` | `known_topics` table |
| In-memory batch map | `permission_batches` + `permission_batch_items` |
| In-memory dedup sets | `events.processed` flag + UNIQUE constraints |

## Data Flows

### Permission Request

1. Hook: `INSERT INTO events` (permission_request)
2. Hook: Poll `SELECT FROM responses WHERE event_id = ?`
3. Daemon: `SELECT FROM events WHERE processed = FALSE` (on poll cycle)
4. Daemon: Buffer in `permission_batches` (2s window)
5. Daemon: Flush batch → send Telegram buttons
6. User clicks → Telegram callback
7. Daemon: `INSERT INTO responses` + update batch status
8. Hook: Poll finds response → output decision

### Stop/Instruction

1. Hook: `INSERT INTO events` (stop) + poll for response
2. Daemon: `INSERT INTO pending_stops` + send "Reply with instruction" to topic
3. User replies in Telegram topic
4. Daemon: `INSERT INTO responses` + `DELETE FROM pending_stops`
5. Hook: Poll finds response → output instruction

### Session Lifecycle

- `/afk activate`: INSERT session + INSERT known_topic
- First hook call: UPDATE session SET claude_session_id
- `/afk deactivate`: DELETE session (CASCADE clears events/responses)
- `/afk-reset`: Read active topics → delete from Telegram → delete bridge.db

## Technical Choices

### SQLite Library: `better-sqlite3`

- Synchronous API (hook blocks until approval — natural fit)
- Fastest Node.js SQLite binding
- Cross-platform (macOS, Linux, Windows)
- WAL mode: readers don't block writers

### Connection Setup

```typescript
journal_mode: 'WAL'       // Concurrent read/write
busy_timeout: 5000        // Wait on lock contention
foreign_keys: true        // Enforce referential integrity
```

### FP-TS Integration

All DB operations return `TaskEither<DbError, T>` with discriminated union errors:
- `ConnectionError`, `QueryError`, `ConstraintError`, `BusyError`

### Migration Strategy

`PRAGMA user_version` for schema versioning. Check on daemon start, run migrations if needed.

## Error Recovery

| Error | Handling |
|---|---|
| `SQLITE_BUSY` | `busy_timeout: 5000` auto-retries |
| DB corrupted | Delete `bridge.db`, notify user, recreate on next start |
| DB missing | Create fresh with schema on daemon start |
| Daemon crash mid-tx | SQLite auto-rollback, unprocessed events retry |
| Hook crash mid-poll | Orphaned responses cleaned by daemon |

## Concurrency Guarantees

| Scenario | Handling |
|---|---|
| Two hooks write events simultaneously | Separate INSERT transactions, SQLite serializes |
| Daemon reads while hook writes | WAL: no blocking |
| Multiple daemons accidentally started | SQLite file lock → second gets SQLITE_BUSY |

## Scope Reduction

- **Delete Qwen bridge** — out of scope, will be rebuilt later for other CLIs
- **Claude Code only** for now
