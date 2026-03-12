# Design: Migrate from better-sqlite3 to node:sqlite

**Date:** 2026-03-12
**Status:** Approved
**Problem:** better-sqlite3 is a native C++ addon that breaks on Node.js version changes. Since the bridge is a shared skill installed by multiple users with different Node versions, this causes silent failures — the hook gate check swallows errors with `2>/dev/null`, AFK_ACTIVE never gets set, and the Stop hook exits immediately instead of blocking.

## Solution

Replace `better-sqlite3` with Node.js built-in `node:sqlite` module (stable since Node 22.5+). Zero external dependencies, same synchronous API, native WAL mode and multi-process locking.

Add a marker file (`active_count`) for the hook.sh gate check so the hot path (every hook invocation) is pure bash with no node invocation needed.

## API Mapping

| better-sqlite3 | node:sqlite |
|---|---|
| `require('better-sqlite3')(path)` | `new DatabaseSync(path)` |
| `new Database(path, { readonly: true })` | `new DatabaseSync(path, { readOnly: true })` |
| `db.pragma('journal_mode = WAL')` | `db.exec('PRAGMA journal_mode = WAL')` |
| `db.prepare(sql).run(...)` | same |
| `db.prepare(sql).get(...)` | same |
| `db.prepare(sql).all(...)` | same |
| `NODE_PATH` / `node_modules` for native module | not needed — built-in |

## Components

### 1. Replace better-sqlite3 with node:sqlite

- Swap import: `require('better-sqlite3')` → `import { DatabaseSync } from 'node:sqlite'`
- Constructor: `new Database(path)` → `new DatabaseSync(path)`
- Read-only: `{ readonly: true }` → `{ readOnly: true }`
- Pragma: `db.pragma(...)` → `db.exec('PRAGMA ...')`
- Add `timeout` option for busy database handling
- Remove `NODE_PATH` exports from hook.sh and all scripts
- Remove `better-sqlite3` from package.json dependencies
- Remove `node_modules` symlink from install script

### 2. Marker file gate (`active_count`)

- Plain text file containing number of active sessions (e.g., "1", "2", "0")
- Updated by `cli.js activate` (increment) and `cli.js deactivate` (decrement)
- hook.sh reads with `cat` — zero node invocation on hot path
- Stale check: if `daemon.pid` process is dead AND heartbeat > 15 min → reset marker to 0

### 3. hook.sh gate replacement (lines 25-33)

```bash
# Fast gate: marker file (no node needed)
if [ -f "$CONFIG_DIR/active_count" ] && [ "$(cat "$CONFIG_DIR/active_count" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
  if [ -f "$CONFIG_DIR/daemon.pid" ]; then
    _PID=$(cat "$CONFIG_DIR/daemon.pid" 2>/dev/null)
    if [ -n "$_PID" ] && kill -0 "$_PID" 2>/dev/null; then
      export AFK_ACTIVE=1
    elif [ -f "$CONFIG_DIR/daemon.heartbeat" ]; then
      _HB=$(cat "$CONFIG_DIR/daemon.heartbeat" 2>/dev/null)
      _NOW=$(date +%s)
      if [ $((_NOW - _HB / 1000)) -lt 900 ]; then
        export AFK_ACTIVE=1
      else
        echo "0" > "$CONFIG_DIR/active_count"
      fi
    fi
  else
    export AFK_ACTIVE=1
  fi
fi
```

### 4. Node version check

- `install.sh`: check Node >= 22.5, fail with clear message if not
- `hook.sh`: optional runtime check (or just let import fail with clear error)
- `README.md`: document minimum Node 22.5+ requirement

## What stays the same

- SQLite schema (sessions, events, pending_stops, known_topics, session_bindings)
- WAL mode (enabled via pragma)
- Daemon loop architecture (1s interval)
- Session binding logic
- Permission batching and trust mechanism
- All hook types (Stop, PermissionRequest, Notification)
- Deployment scripts (switch-to-ts, switch-to-python)

## Files changed

- `package.json` — remove better-sqlite3 dependency
- `src/core/db.ts` — swap driver import and constructor
- `src/bridge/daemon.ts` — use updated db layer
- `src/hook/index.ts` — use updated db layer
- `src/cli/activate.ts` — use updated db layer + write marker file
- `src/cli/deactivate.ts` — use updated db layer + write marker file
- `hook.sh` — replace node SQLite gate with marker file + stale PID check, remove NODE_PATH
- `install.sh` — add Node version check, remove node_modules symlink/rebuild
- Tests — update mocks from better-sqlite3 to node:sqlite

## Minimum requirement

- Node.js >= 22.5.0
