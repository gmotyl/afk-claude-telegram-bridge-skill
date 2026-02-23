# Design: AFK Session Resilience & Context Management

**Date:** 2026-02-23
**Status:** Proposed

## Problem Statement

Three related issues with long-running AFK sessions:

1. **Idle timeout kills session** — When Claude emits a Stop event and user doesn't respond within 10 minutes, the hook exits and Claude dies. Subsequent Telegram messages queue up but nobody is polling. User sees "waiting for input" but Claude is already gone.

2. **No context management** — Long-running AFK sessions accumulate conversation history indefinitely. Eventually context degrades or overflows. User has no way to compact or clear context from Telegram.

3. **Zombie processes** — If user deletes a Telegram topic, the hook process keeps polling forever with no way to receive input.

4. **Double /afk** — Running `/afk` twice in the same terminal can cause session leakage where unrelated sessions start listening on Telegram.

## Design

### 1. Keep-Alive Loop (hook.py — Stop handler)

**Current flow:**
```
Stop event → poll for 600s → timeout → sys.exit(0) → session dead
```

**New flow:**
```
Stop event → poll for 60s → timeout → write keep-alive event → re-poll → ...
  ↓ (on kill file detected)
  exit cleanly
  ↓ (on user taps [Let it stop])
  exit cleanly
  ↓ (on user sends instruction)
  route instruction, continue
```

Changes to `cmd_hook()` Stop handler:
- Replace single `_poll_response()` call with a loop
- Each iteration polls for `keep_alive_poll_seconds` (default: 60s)
- Between iterations, check for `kill` marker file → exit if found
- Write `keep-alive` event to `events.jsonl` every iteration (daemon uses this for heartbeat tracking)
- Daemon sends idle ping to Telegram every `idle_ping_hours` (default: 12h)
- Idle ping message: "Session idle for {hours}h. Still listening." (no buttons, just informational)

### 2. Zombie Detection (bridge.py)

When `send_message()` fails for a specific thread_id:
- Check if error indicates topic was deleted (HTTP 400, "message thread not found")
- If confirmed deleted:
  1. Write `kill` file to `IPC_DIR/{session_id}/kill`
  2. Remove session from `self.session_threads`
  3. Remove slot from state.json
  4. Log the cleanup

Hook-side:
- Poll loop checks for `IPC_DIR/{session_id}/kill` file between poll iterations
- If found → exit cleanly (no Telegram notification needed, topic is gone)

### 3. Context Management (bridge.py + hook.py)

#### Interaction Counter

Daemon tracks interactions per session:
- Incremented on each: `permission_request`, `stop` event, routed user message
- Stored in `IPC_DIR/{session_id}/meta.json` → `"interaction_count": N`
- Configurable threshold: `config.json` → `"context_warning_threshold": 150`

#### 80% Warning

When `interaction_count >= context_warning_threshold`:
- Send Telegram message with inline keyboard:
  - `[Compact]` — callback: `compact:{session_id}`
  - `[Clear]` — callback: `clear:{session_id}`
  - `[Dismiss]` — callback: `dismiss_ctx:{session_id}`
- On Dismiss: warn again when count reaches `threshold * 1.25` (100% mark)
- Warning is sent once per threshold crossing (not repeated)

#### Command Interception

Daemon intercepts these text messages from Telegram:
- `/clear` → write event type `"context_command"` with `"command": "clear"`
- `/compact` → write event type `"context_command"` with `"command": "compact"`

These also trigger from the 80% warning inline buttons.

Hook-side handling:
- During keep-alive poll loop, check for `context_command` events
- For `clear`: output JSON that injects `/clear` as user input
- For `compact`: output JSON that injects `/compact` as user input
- Both are routed through the Stop hook's instruction mechanism

### 4. Double /afk Guard (hook.py — cmd_activate)

Current check only matches by `session_id`. Add additional check:
- Before claiming a new slot, verify no existing slot has the same `project + topic_name` combination
- If duplicate found: print warning and exit instead of creating a second slot
- This prevents the scenario where `/afk` runs twice with different session IDs but same intent

## Config Defaults

```json
{
  "context_warning_threshold": 150,
  "idle_ping_hours": 12,
  "keep_alive_poll_seconds": 60
}
```

## Files Changed

| File | Changes |
|------|---------|
| `hook.py` | Keep-alive loop in Stop handler, kill file detection in poll loop, double-activate guard, context command handling |
| `bridge.py` | Interaction counter in `_process_event`, 80% warning with buttons, `/clear` + `/compact` interception in `_handle_message`, zombie detection in `send_message` failures, idle ping timer |
| `config.json` | New keys: `context_warning_threshold`, `idle_ping_hours`, `keep_alive_poll_seconds` |

## Implementation Order

1. Keep-alive loop (fixes the critical idle timeout bug)
2. Zombie detection (prevents resource waste)
3. Double /afk guard (prevents session leakage)
4. Interaction counter + 80% warning (context management)
5. /clear + /compact interception (context management commands)

## Risks

- **Keep-alive loop resource usage**: Minimal — one sleeping Python process per AFK session polling every 60s
- **Context command routing**: `/clear` and `/compact` are Claude Code built-in commands; routing them through the instruction mechanism should work but needs testing
- **Zombie detection false positives**: Network errors could be mistaken for deleted topics; add retry logic before writing kill file
