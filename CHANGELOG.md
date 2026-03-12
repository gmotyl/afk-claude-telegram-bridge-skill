# Changelog

All notable changes to this project will be documented in this file.

## [3.1.0] — Drop Native Dependencies (2026-03-12)

Replace `better-sqlite3` (native C++ addon) with Node.js built-in `node:sqlite` module to eliminate version-dependent build failures.

### Added

- **Marker file gate** (`active_count`) — hook.sh gate check is now pure bash (no node invocation on hot path)
- **Stale session detection** — if daemon PID is dead and heartbeat is older than 15 minutes, marker resets automatically
- **Node.js version check** in `install.sh` — fails early with clear message if Node < 22.5

### Changed

- **SQLite driver** — `better-sqlite3` → `node:sqlite` (built-in since Node 22.5+)
- **Minimum Node.js version** — 18+ → 22.5+
- **hook.sh** — gate check reads marker file instead of spawning node to query SQLite; `--status` and `--reset` use `node:sqlite` instead of `better-sqlite3`
- **`@types/node`** upgraded to v25 for `node:sqlite` type declarations

### Removed

- `better-sqlite3` dependency (native C++ addon that broke on Node.js version upgrades)
- `@types/better-sqlite3` dev dependency
- `NODE_PATH` exports from all shell scripts
- `node_modules` symlink/install in `install.sh`

## [3.0.0] — SQLite IPC (2026-03-04)

Replace file-based IPC with SQLite for reliability and atomicity.

### Added

- **SQLite database layer** — `better-sqlite3` with WAL mode, busy timeout, and schema versioning
- **Typed query helpers** for all tables (sessions, events, responses, permission_batches, pending_stops, known_topics)
- **SQLite-backed service adapters** — drop-in replacements for file-based IPC, session binding, state persistence, and queued instructions
- **Known topics tracking** — daemon registers created Telegram topics in `known_topics` table so `/afk-reset` can clean them up

### Changed

- **IPC mechanism** — events and responses now stored in SQLite tables instead of JSONL files and response JSON files
- **Session binding** — uses `claude_session_id` column in sessions table instead of `bound_session` files
- **State persistence** — reconstructed from SQLite tables on daemon start instead of lockfile-protected `state.json`
- **Hook session routing** — non-AFK sessions are no longer incorrectly routed through the bridge when only one slot is active
- **Thread ID persistence** — `threadId` from Telegram topic creation is now persisted to SQLite, surviving daemon restarts
- **Hook wrapper** (`hook.sh`) simplified — session gating delegated to `hook.js` via SQLite queries
- **Reset command** reads thread IDs from both `known_topics` and `sessions` tables for reliable topic cleanup

### Removed

- File-based IPC services (`ipc.ts`, `session-binding.ts`, `state-persistence.ts`, `queued-instruction.ts`, `file-lock.ts`, `instruction-writer.ts`)
- `proper-lockfile` dependency (SQLite handles concurrency)

### Fixed

- `better-sqlite3` import — changed from `import * as` (namespace) to default import to fix "is not a constructor" error in minified bundles
- Session leak — other Claude sessions no longer get routed through AFK bridge when they don't match any bound session
- Topic cleanup on reset — topics are now tracked in `known_topics` table and properly deleted
- Dual daemon — activate now persists daemon PID to `daemon.pid` so hooks don't spawn a second daemon
- Duplicate topics — caused by dual daemons both processing the same SessionStart event

## [2.1.1] — Fix IPC Race Condition (2026-03-01)

### Fixed

- **IPC event race condition** — hook appended all events to a single `events.jsonl` file; daemon would read then delete the entire file, losing any events written between the read and delete. Now each event is written to a unique `event-{uuid}.jsonl` file, eliminating the race window. This fixes intermittent hangs where permission requests (especially Edit) were never forwarded to Telegram.
- **Trust auto-approve silent failure** — `writeResponse()` result was not checked in the trusted session auto-approve path. If the write failed, the hook would hang forever with no error. Now falls through to normal batch flow on failure.

### Changed

- New `writeEventAtomic()` IPC function for race-safe per-event file writes; `writeEvent()` (append mode) preserved for backward compatibility
- Hook callers (`permission.ts`, `stop.ts`) switched to `writeEventAtomic()` for all event writes including keep-alive and daemon recovery re-sends

## [2.1.0] — Permission Batching, Session Trust & Config Auto-approve (2026-03-01)

### Added

- **Permission batching** — accumulates permission requests within a 2s window and shows "Approve All (N)" button for multiple requests in a single Telegram message
- **Session trust** — after N approvals (default: 3), offers "Trust this session?" button to auto-approve all future requests for that session
- **Config-based auto-approve** — `autoApproveTools` in config.json to whitelist specific destructive tools (e.g. `["Bash"]`), optionally filtered by `autoApprovePaths` prefixes
- **Multi-row inline keyboard** — `sendMultiRowButtonsToTopic` Telegram helper for batch permission messages
- New config fields: `autoApproveTools`, `autoApprovePaths`, `permissionBatchWindowMs`, `sessionTrustThreshold`

### Changed

- Hook auto-approve logic now uses `shouldAutoApprove()` which checks both built-in destructive tool list and config whitelist
- Daemon `handleCallbackQuery` extended with `batch_approve`, `batch_deny`, `trust`, and `no_trust` callback actions

## [2.0.0] — TypeScript Rewrite (2026-02-26 — 2026-03-01)

Complete rewrite from Python to TypeScript with functional programming patterns.

### Added

- **TypeScript + esbuild + Jest toolchain** — strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- **Functional error handling** with fp-ts `Either`/`TaskEither` — no thrown exceptions from business logic
- **Structured error types** with tagged discriminated unions and smart constructors
- **Layered architecture** — pure core (`src/core/`), I/O services (`src/services/`), orchestration (`src/hook/`, `src/bridge/`, `src/cli/`)
- **IPC event processor** with typed JSONL read/write
- **State persistence** module with file locking (`proper-lockfile`)
- **Telegram API client** service with typed responses
- **Config loader** module with legacy Python format migration
- **Hook system** — argument parser, permission request handling, main entry point
- **Stop hook with active listening loop** — polls for Telegram instructions after Claude finishes, continues until "Let it stop"
- **Daemon main loop** — processes IPC events, polls Telegram, delivers responses via files
- **CLI activate/deactivate** commands with daemon lifecycle management
- **File locking, daemon launcher, IPC directory** services
- **Session binding** — first hook event binds Claude session to AFK slot
- **Queued instruction service** and pending stop state management
- **Build system** — esbuild bundles three entry points (`hook.js`, `bridge.js`, `cli.js`) as self-contained Node.js bundles
- **Deployment scripts** — `npm run deploy` builds and installs to `~/.claude/hooks/telegram-bridge/`
- **106+ unit tests** covering state management, event processing, deactivation, session binding, daemon internals, and regressions
- **E2E integration tests** for active listening flow
- **Test helpers** — fixtures, mock filesystem, mock Telegram responses

### Changed

- **Zero runtime dependencies** — fp-ts bundled into output via esbuild (no `node_modules` needed at runtime)
- **Immutable state** — all types use `readonly`, state updates via spread operator

### Removed

- Python implementation and legacy scripts
