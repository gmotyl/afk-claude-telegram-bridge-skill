# AFK Telegram Bridge — UX Improvements Design

**Date:** 2026-02-25
**Status:** Approved

## Problem

Real-world AFK usage revealed several UX issues:
- Agent becomes genuinely stuck with no way to detect it (must /clear blindly)
- Permission requests flood Telegram (6+ individual Read approvals in a row)
- No visual feedback while Claude processes (can't tell alive vs dead)
- /clear unreliable when IPC flow is stuck
- No way to end AFK session from Telegram (must /back in console)

## Changes

### 1. /ping Command & Health Detection

**User-initiated /ping:**
- Daemon intercepts `/ping` in topic (like `/clear`, `/compact`)
- Checks last event timestamp in `events.jsonl` for that session
- Responds directly (no IPC round-trip):
  - Fresh (<60s): "🏓 Agent alive — last activity 12s ago"
  - Stale (>60s): "⚠️ Agent may be stuck — no activity for 2m. Try /clear"

**Automatic stale warning:**
- If a pending event (permission/stop) has no response for >90s, daemon warns:
  "⚠️ Agent seems unresponsive. Try /ping or /clear"
- Config: `stale_warning_seconds: 90`

### 2. Permission Batching & Trust

**Tier 1 — Path-based auto-approve (config.json):**
```json
{
  "auto_approve_paths": ["/Users/gmotyl/git/*"],
  "auto_approve_tools": ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TaskList", "TaskGet", "TaskCreate", "TaskUpdate"]
}
```
Both tool name AND file path must match for auto-approval. Path matching uses glob patterns.

**Tier 2 — Batch collection (bridge.py):**
- On permission_request event, start 2s collection window
- Group additional permission_request events arriving in window
- Single message: "🔐 Permission Requests (4):\n1. Read: file_a\n2. Read: file_b\n..."
- Buttons: "Approve All (4)" / "Deny All"
- Solo requests (1 in window) use current format

**Tier 3 — Session trust (bridge.py):**
- After 3 individual approvals in same session, add "🔓 Trust Session" button
- Once tapped: all subsequent permissions auto-approve with log: "✅ Auto-approved (trusted): Read file_x"
- Trust resets on /clear or session end

### 3. Native Typing Indicator

- New TelegramAPI method: `send_chat_action(chat_id, topic_id, action="typing")`
- Trigger: when daemon routes instruction to Claude or processes "allow" callback
- Loop: send typing action every 4.5s (Telegram shows dots for ~5s)
- Stop: when next event from that session arrives in events.jsonl
- State: `self.typing_sessions[session_id] = True/False`

### 4. IPC Reliability

**Response file watchdog (hook.py):**
- If no response-{event_id}.json after 30s, re-append event to events.jsonl with `retry: true`
- Daemon ignores duplicate events (checks event_id)

**/clear reliability:**
- Daemon writes `force_clear` file to IPC dir on /clear command
- hook.py checks for `force_clear` in polling loop (parallel to response check)
- When detected: returns special "force_clear" instruction to Claude
- Bypasses normal IPC response flow entirely

**Diagnostic logging:**
- All IPC operations get `[DIAG]` prefixed log lines with timestamps
- Config: `diagnostic_logging: true` (default false)

### 5. Remote Session End

**/end command in Telegram:**
- Daemon intercepts `/end` in topic
- Writes `kill` marker to IPC dir
- Sends "👋 AFK Session ended from Telegram"
- Cleans up: releases slot, deletes topic, updates state.json

**"End AFK" button:**
- Added to stop/task-complete message alongside existing buttons
- Callback: `end_session:{session_id}` → same flow as /end

**Console notification:**
- hook.py detects `kill` file during polling
- Prints to stderr: "AFK session ended from Telegram. Returning control."
- Exits hook cleanly (returns empty instruction)

## Config Changes

```json
{
  "auto_approve_paths": [],
  "stale_warning_seconds": 90,
  "permission_batch_window_seconds": 2,
  "session_trust_threshold": 3,
  "diagnostic_logging": false
}
```

## Files Modified

- `bridge.py` — Typing indicator, /ping, /end, permission batching, stale detection, session trust
- `hook.py` — Path-based auto-approve, force_clear detection, IPC retry, remote end handling
- `config.json` — New config fields with defaults
- `install.sh` — Updated defaults
