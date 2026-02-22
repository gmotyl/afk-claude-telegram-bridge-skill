# Session Isolation Fix — Design Document

**Date:** 2026-02-22
**Approach:** A — Environment-based Session Binding

## Problem

Two bugs in the telegram-bridge hook system:

1. **Cross-session leak:** Hook events from non-AFK Claude sessions (e.g., CH project in another terminal) get routed to the active AFK session's Telegram topic. Caused by single-session fallback in `hook.py:514-521`.

2. **AFK session output missing:** The AFK session's own output sometimes doesn't reach Telegram. Caused by the `/afk` command generating a UUID that doesn't match Claude Code's internal `session_id` passed in hook events.

## Root Cause

The `/afk` command generates a random UUID and creates `ipc/{uuid}/`. Claude Code's hooks pass a different `session_id` (Claude's internal ID). These never match. The fallback logic (`if len(active_sessions) == 1: use it`) routes ALL sessions to the single AFK slot indiscriminately.

## Solution: Binding on First Contact

When the AFK session's first hook event arrives, bind Claude's real `session_id` to the IPC directory. After binding, only matching sessions route through.

### Binding Flow

1. `/afk` creates `ipc/{uuid}/` with `meta.json` (no `bound_session` file yet)
2. First hook event arrives with `session_id=claude-real-id`
3. `hook.py` checks: direct match? No. Bound match? No. Unbound slots? One.
4. Binds: writes `claude-real-id` to `ipc/{uuid}/bound_session`
5. All future events with `claude-real-id` map to this IPC dir
6. Events from other sessions find no match, no unbound slots — exit silently

### Race Condition: Multiple Concurrent `/afk`

If two terminals call `/afk` simultaneously, there are two unbound slots. When the first hook event arrives, `hook.py` sees `len(unbound) != 1` and exits without binding. On the next event, one slot may be bound and the other still unbound — binding proceeds naturally. Worst case: both sessions need a second hook event to bind.

## Files Changed

### `hook.py`
- Replace single-session fallback in `cmd_hook()` with binding logic
- Add `_find_bound_session(session_id)` — scan IPC dirs for matching `bound_session` file
- Add `_find_unbound_slots()` — find IPC dirs without `bound_session`
- Add `_bind_session(ipc_dir, session_id)` — write binding file

### `hook.sh`
- Update early-exit logic (lines 76-86) to check bindings and unbound slots before fast-exiting

### No changes
- `bridge.py` — daemon reads IPC dirs, unaffected by binding
- `afk.md` / `back.md` — activation/deactivation flow unchanged
- `cmd_deactivate()` — `shutil.rmtree` already cleans up `bound_session`
