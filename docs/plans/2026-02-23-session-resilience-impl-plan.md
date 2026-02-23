# Session Resilience & Context Management — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make AFK sessions survive indefinitely (keep-alive loop), detect zombie processes (topic deletion), prevent double-activation, and add context management commands (/clear, /compact, 80% warning).

**Architecture:** All changes are in two files: `hook.py` (runs per-event, synchronous) and `bridge.py` (long-running daemon). Communication is via IPC files in `~/.claude/hooks/telegram-bridge/ipc/{session_id}/`. New `kill` marker file for zombie detection. Interaction counter stored in `meta.json`.

**Tech Stack:** Python 3 stdlib only (json, os, time, urllib). No external dependencies.

---

### Task 1: Double /afk Guard (hook.py)

**Files:**
- Modify: `hook.py:321-327` (inside `do_activate` closure)

**Step 1: Add duplicate project+topic check after existing session_id check**

In `hook.py`, inside `do_activate(state)`, after the existing session_id loop (line 325-327), add a second check:

```python
        # Check if already active (by session_id)
        for slot_num, info in slots.items():
            if info.get("session_id") == session_id:
                print(f"Session already active in slot S{slot_num}")
                return slot_num

        # Check for duplicate project+topic (different session_id, same intent)
        for slot_num, info in slots.items():
            if (info.get("project") == (project or "unknown")
                    and info.get("topic_name") == (topic_name or f"S{slot_num} - {project or 'unknown'}")):
                print(f"⚠️  Duplicate detected: project '{project}' already active in slot S{slot_num}")
                print(f"   Run /back first, then /afk again.")
                sys.exit(1)
```

**Step 2: Test manually**

```bash
# Terminal 1: activate
~/.claude/hooks/telegram-bridge/hook.sh --activate test-session-1 myproject "My Topic"
# Terminal 1 again: try to double-activate with different session_id
~/.claude/hooks/telegram-bridge/hook.sh --activate test-session-2 myproject "My Topic"
# Expected: "Duplicate detected" warning, exit 1
# Cleanup:
~/.claude/hooks/telegram-bridge/hook.sh --deactivate test-session-1
```

**Step 3: Commit**

```bash
git add hook.py
git commit -m "fix: prevent double /afk activation for same project+topic"
```

---

### Task 2: Keep-Alive Loop (hook.py)

**Files:**
- Modify: `hook.py:662-701` (Stop handler in `cmd_hook`)
- Modify: `hook.py:753-773` (`_poll_response` — add kill file check parameter)

**Step 1: Add `_check_kill_file` helper**

Add above `_poll_response` (around line 752):

```python
def _check_kill_file(ipc_dir):
    """Check if daemon wrote a kill marker (topic deleted)."""
    kill_path = os.path.join(ipc_dir, "kill")
    return os.path.exists(kill_path)
```

**Step 2: Add `_poll_response_or_kill` — poll with kill file awareness**

Add below `_check_kill_file`:

```python
def _poll_response_or_kill(ipc_dir, event_id, timeout):
    """Poll for response, but exit early if kill file appears."""
    response_path = os.path.join(ipc_dir, f"response-{event_id}.json")
    deadline = time.time() + timeout
    interval = 0.5

    while time.time() < deadline:
        # Check kill file first
        if _check_kill_file(ipc_dir):
            log.info("[POLL] Kill file detected, exiting")
            return {"_killed": True}

        if os.path.exists(response_path):
            try:
                with open(response_path) as f:
                    data = json.load(f)
                os.remove(response_path)
                return data
            except (json.JSONDecodeError, OSError):
                pass
        time.sleep(interval)
        if interval < 2.0:
            interval = min(interval * 1.2, 2.0)

    return None
```

**Step 3: Replace Stop handler with keep-alive loop**

Replace lines 662-701 in `cmd_hook()` with:

```python
    # ── Stop ──
    elif hook_event == "Stop":
        stop_hook_active = event_data.get("stop_hook_active", False)

        event_id = str(uuid.uuid4())[:8]
        last_msg = event_data.get("last_assistant_message", "")
        if len(last_msg) > 2000:
            last_msg = last_msg[:2000] + "..."

        event = {
            "id": event_id,
            "type": "stop",
            "last_message": last_msg,
            "session_id": session_id,
            "stop_hook_active": stop_hook_active,
            "timestamp": time.time(),
        }
        event_file = os.path.join(ipc_session_dir, "events.jsonl")
        with open(event_file, "a") as f:
            f.write(json.dumps(event) + "\n")
        log.info(f"[STOP] Wrote event {event_id} (stop_hook_active={stop_hook_active})")

        # Keep-alive loop: poll repeatedly instead of once
        keep_alive_poll = config.get("keep_alive_poll_seconds", 60)

        while True:
            response = _poll_response_or_kill(ipc_session_dir, event_id, keep_alive_poll)

            # Kill file detected — exit cleanly
            if response and response.get("_killed"):
                log.info("[STOP] Killed by daemon (topic deleted)")
                sys.exit(0)

            # Got instruction from user
            if response and response.get("instruction"):
                result = {
                    "decision": "block",
                    "reason": response["instruction"],
                }
                json.dump(result, sys.stdout)
                sys.exit(0)

            # Got explicit stop (user tapped "Let it stop")
            if response and not response.get("instruction") and "instruction" in response:
                sys.exit(0)

            # Timeout — write keep-alive event and re-poll
            if response is None:
                keep_alive_event = {
                    "id": str(uuid.uuid4())[:8],
                    "type": "keep_alive",
                    "session_id": session_id,
                    "original_event_id": event_id,
                    "timestamp": time.time(),
                }
                with open(event_file, "a") as f:
                    f.write(json.dumps(keep_alive_event) + "\n")
                log.debug(f"[STOP] Keep-alive ping, re-polling for event {event_id}")
                continue
```

**Step 4: Test manually**

```bash
# 1. Start an AFK session
# 2. Let Claude finish a task (Stop event fires)
# 3. Wait >60 seconds without responding on Telegram
# 4. Check hook.log for "[STOP] Keep-alive ping" messages
# 5. Send a message on Telegram — should still work
# Expected: Session stays alive indefinitely
```

**Step 5: Commit**

```bash
git add hook.py
git commit -m "feat: keep-alive loop prevents session death on idle timeout"
```

---

### Task 3: Zombie Detection — Daemon Side (bridge.py)

**Files:**
- Modify: `bridge.py:80-90` (`send_message` method)
- Modify: `bridge.py:207` (`BridgeDaemon.__init__`)
- Modify: `bridge.py:294` (`_process_event`)

**Step 1: Add error detection to TelegramAPI.send_message**

Replace `send_message` in `TelegramAPI` class:

```python
    def send_message(self, text, thread_id=None, reply_markup=None, parse_mode="HTML"):
        data = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": parse_mode,
        }
        if thread_id:
            data["message_thread_id"] = thread_id
        if reply_markup:
            data["reply_markup"] = reply_markup
        result = self._request("sendMessage", data)

        # Detect deleted topic
        if result and not result.get("ok"):
            error_desc = result.get("description", "").lower()
            if "thread not found" in error_desc or "message thread not found" in error_desc:
                return {"ok": False, "topic_deleted": True, "description": error_desc}

        return result
```

**Step 2: Add `_kill_session` method to BridgeDaemon**

Add to `BridgeDaemon` class after `_write_response`:

```python
    def _kill_session(self, session_id, reason="topic deleted"):
        """Write kill file and clean up session state."""
        ipc_session_dir = IPC_DIR / session_id
        kill_path = ipc_session_dir / "kill"
        try:
            with open(kill_path, "w") as f:
                f.write(reason)
            log.info(f"[KILL] Wrote kill file for session {session_id[:8]}: {reason}")
        except OSError as e:
            log.error(f"[KILL] Failed to write kill file: {e}")

        # Clean up daemon state
        if session_id in self.session_threads:
            del self.session_threads[session_id]

        # Remove slot from state.json
        try:
            state = load_state()
            slots = state.get("slots", {})
            slot_to_remove = None
            for slot_num, info in slots.items():
                if info.get("session_id") == session_id:
                    slot_to_remove = slot_num
                    break
            if slot_to_remove:
                del slots[slot_to_remove]
                save_state(state)
                log.info(f"[KILL] Removed slot S{slot_to_remove} from state")
        except Exception as e:
            log.error(f"[KILL] Failed to update state: {e}")
```

**Step 3: Add zombie check in _process_event where send_message is called**

In `_process_event`, after every `self.tg.send_message(...)` call that uses `thread_id`, add a check. Wrap the pattern with a helper. Add this method to `BridgeDaemon`:

```python
    def _send_to_session(self, text, session_id, reply_markup=None):
        """Send message to session's thread, handling deleted topics."""
        thread_id = self.session_threads.get(session_id)
        result = self.tg.send_message(text, thread_id=thread_id, reply_markup=reply_markup)

        if result and result.get("topic_deleted"):
            log.warning(f"[ZOMBIE] Topic deleted for session {session_id[:8]}, killing")
            self._kill_session(session_id, "topic deleted by user")
            return None

        return result
```

Then replace `self.tg.send_message(..., thread_id=thread_id, ...)` calls in `_process_event` (for permission_request, stop, notification, response events) with `self._send_to_session(...)`. The activation event keeps using `self.tg.send_message` directly since it just created the topic.

**Step 4: Test manually**

```bash
# 1. Start an AFK session
# 2. In Telegram, manually delete the topic
# 3. Trigger a Stop or Permission event
# 4. Check daemon.log for "[ZOMBIE] Topic deleted" message
# 5. Check that kill file exists: ls ~/.claude/hooks/telegram-bridge/ipc/*/kill
# 6. Verify hook process exits
```

**Step 5: Commit**

```bash
git add bridge.py
git commit -m "feat: zombie detection kills session when Telegram topic deleted"
```

---

### Task 4: Keep-Alive Handling in Daemon (bridge.py)

**Files:**
- Modify: `bridge.py:207` (`BridgeDaemon.__init__`)
- Modify: `bridge.py:294` (`_process_event`)

**Step 1: Add idle ping tracking to BridgeDaemon.__init__**

Add to `__init__`:

```python
        # Idle ping tracking: session_id -> last_ping_timestamp
        self.last_idle_ping = {}
```

**Step 2: Handle keep_alive events in _process_event**

Add a new `elif` branch in `_process_event`:

```python
        elif etype == "keep_alive":
            # Hook is still alive, check if we should send idle ping
            idle_ping_hours = self.config.get("idle_ping_hours", 12)
            idle_ping_seconds = idle_ping_hours * 3600
            last_ping = self.last_idle_ping.get(session_id, 0)
            now = time.time()

            if now - last_ping > idle_ping_seconds:
                hours_idle = int((now - last_ping) / 3600) if last_ping else 0
                if hours_idle > 0:
                    self._send_to_session(
                        f"💤 Session idle for {hours_idle}h. Still listening.",
                        session_id,
                    )
                self.last_idle_ping[session_id] = now
                log.info(f"[KEEPALIVE] Idle ping sent for session {session_id[:8]}")
            else:
                log.debug(f"[KEEPALIVE] Session {session_id[:8]} alive, next ping in {int(idle_ping_seconds - (now - last_ping))}s")
```

**Step 3: Initialize idle ping timestamp on activation**

In the `activation` branch of `_process_event`, after the topic is created, add:

```python
            self.last_idle_ping[session_id] = time.time()
```

**Step 4: Commit**

```bash
git add bridge.py
git commit -m "feat: daemon handles keep-alive events with 12h idle pings"
```

---

### Task 5: Interaction Counter + 80% Warning (bridge.py)

**Files:**
- Modify: `bridge.py:207` (`BridgeDaemon.__init__`)
- Modify: `bridge.py:294` (`_process_event`)
- Modify: `bridge.py:453` (`_handle_message`)
- Modify: `bridge.py:416` (`_handle_callback`)

**Step 1: Add interaction counter state to BridgeDaemon.__init__**

```python
        # Context management: session_id -> interaction count
        self.interaction_counts = {}
        self.context_warning_sent = {}  # session_id -> threshold at which warning was sent
```

**Step 2: Add `_increment_interaction` method**

```python
    def _increment_interaction(self, session_id):
        """Increment interaction counter and check threshold."""
        count = self.interaction_counts.get(session_id, 0) + 1
        self.interaction_counts[session_id] = count

        threshold = self.config.get("context_warning_threshold", 150)
        last_warned = self.context_warning_sent.get(session_id, 0)

        # Warn at threshold (80%) and again at threshold * 1.25 (100%)
        if count >= threshold and last_warned < threshold:
            self._send_context_warning(session_id, count, threshold)
            self.context_warning_sent[session_id] = threshold
        elif count >= int(threshold * 1.25) and last_warned < int(threshold * 1.25):
            self._send_context_warning(session_id, count, int(threshold * 1.25))
            self.context_warning_sent[session_id] = int(threshold * 1.25)

        # Update meta.json
        meta_path = IPC_DIR / session_id / "meta.json"
        try:
            if meta_path.exists():
                with open(meta_path) as f:
                    meta = json.load(f)
            else:
                meta = {}
            meta["interaction_count"] = count
            with open(meta_path, "w") as f:
                json.dump(meta, f, indent=2)
        except Exception:
            pass

        return count
```

**Step 3: Add `_send_context_warning` method**

```python
    def _send_context_warning(self, session_id, count, threshold):
        """Send context warning with action buttons."""
        thread_id = self.session_threads.get(session_id)
        text = (
            f"⚠️ <b>Context Usage Warning</b>\n\n"
            f"Interactions: {count} (threshold: {threshold})\n"
            f"Session may degrade. Choose an action:"
        )
        kb = {"inline_keyboard": [
            [{"text": "📦 Compact", "callback_data": f"compact:{session_id}"},
             {"text": "🗑 Clear", "callback_data": f"clear:{session_id}"}],
            [{"text": "💨 Dismiss", "callback_data": f"dismiss_ctx:{session_id}"}],
        ]}
        self.tg.send_message(text, thread_id=thread_id, reply_markup=kb)
        log.info(f"[CONTEXT] Warning sent for session {session_id[:8]} at count={count}")
```

**Step 4: Call `_increment_interaction` in _process_event**

Add `self._increment_interaction(session_id)` at the start of these branches in `_process_event`:
- `permission_request` (after the `elif etype ==` line)
- `stop` (after the `elif etype ==` line)

And in `_handle_message`, after a message is routed (both the immediate instruction path and the queued path), add:
```python
            self._increment_interaction(target_session)
```

**Step 5: Handle context warning callbacks in _handle_callback**

Add these branches after the existing `elif action == "stop":` block:

```python
        elif action == "compact":
            # session_id is in event_id position for context commands
            target_sid = event_id  # callback_data is "compact:{session_id}"
            ipc_dir = IPC_DIR / target_sid
            if ipc_dir.exists():
                ctx_event = {
                    "id": str(uuid.uuid4())[:8],
                    "type": "context_command",
                    "command": "compact",
                    "session_id": target_sid,
                    "timestamp": time.time(),
                }
                event_file = ipc_dir / "events.jsonl"
                with open(event_file, "a") as f:
                    f.write(json.dumps(ctx_event) + "\n")
            self.tg.answer_callback(cq_id, "Compacting context...")
            thread_id = self.session_threads.get(target_sid)
            if thread_id:
                self.tg.send_message("📦 Compacting context...", thread_id=thread_id)

        elif action == "clear":
            target_sid = event_id
            ipc_dir = IPC_DIR / target_sid
            if ipc_dir.exists():
                ctx_event = {
                    "id": str(uuid.uuid4())[:8],
                    "type": "context_command",
                    "command": "clear",
                    "session_id": target_sid,
                    "timestamp": time.time(),
                }
                event_file = ipc_dir / "events.jsonl"
                with open(event_file, "a") as f:
                    f.write(json.dumps(ctx_event) + "\n")
            self.tg.answer_callback(cq_id, "Clearing context...")
            thread_id = self.session_threads.get(target_sid)
            if thread_id:
                self.tg.send_message("🗑 Clearing context...", thread_id=thread_id)

        elif action == "dismiss_ctx":
            self.tg.answer_callback(cq_id, "Dismissed")
```

**Step 6: Commit**

```bash
git add bridge.py
git commit -m "feat: interaction counter with 80% context warning and action buttons"
```

---

### Task 6: /clear and /compact Command Interception (bridge.py + hook.py)

**Files:**
- Modify: `bridge.py:453` (`_handle_message`)
- Modify: `hook.py:662` (Stop handler keep-alive loop)

**Step 1: Intercept /clear and /compact in _handle_message**

At the top of `_handle_message`, after the `text` and `chat_id` extraction, before the session lookup, add:

```python
        # Intercept context management commands
        if text.lower() in ("/clear", "/compact"):
            command = text.lower().lstrip("/")
            # Find which session this topic belongs to
            target_session = None
            msg_thread_id = msg.get("message_thread_id")
            for sid, t_id in self.session_threads.items():
                if t_id == msg_thread_id:
                    target_session = sid
                    break

            if not target_session:
                state = load_state()
                active = get_active_sessions(state)
                if len(active) == 1:
                    target_session = list(active.keys())[0]

            if target_session:
                ipc_dir = IPC_DIR / target_session
                if ipc_dir.exists():
                    ctx_event = {
                        "id": str(uuid.uuid4())[:8],
                        "type": "context_command",
                        "command": command,
                        "session_id": target_session,
                        "timestamp": time.time(),
                    }
                    event_file = ipc_dir / "events.jsonl"
                    with open(event_file, "a") as f:
                        f.write(json.dumps(ctx_event) + "\n")
                    self.tg.send_message(
                        f"{'📦' if command == 'compact' else '🗑'} Sending /{command} to Claude...",
                        thread_id=msg_thread_id,
                    )
                    log.info(f"[CONTEXT] Intercepted /{command} for session {target_session[:8]}")

                    # Reset interaction counter on clear
                    if command == "clear":
                        self.interaction_counts[target_session] = 0
                        self.context_warning_sent[target_session] = 0
            return
```

**Step 2: Handle context_command in hook.py keep-alive loop**

In the keep-alive loop (Task 2), inside the `while True:` loop, after the `_poll_response_or_kill` call and before the timeout handling, add a check for context command files:

```python
            # Check for context commands (written by daemon)
            ctx_cmd_pattern = os.path.join(ipc_session_dir, "context_command_*.json")
            import glob as glob_mod
            ctx_files = glob_mod.glob(os.path.join(ipc_session_dir, "context_command_*.json"))
            # Also check events.jsonl for context_command events
```

Actually, simpler approach — the context commands are written to events.jsonl but the hook doesn't scan that file. Instead, have the daemon write a dedicated file:

Replace the context_command event writing in bridge.py (both in _handle_message and _handle_callback) to also write a dedicated response file that the hook's poll loop will pick up. The command gets injected as an instruction:

In `bridge.py`, when handling context commands (both from text and callbacks), instead of writing to events.jsonl, find the pending stop event and write a response:

```python
            if target_session:
                # Find pending stop event for this session
                stop_event_id = None
                for eid, info in self.pending_events.items():
                    if info["session_id"] == target_session and info["type"] == "stop":
                        stop_event_id = eid
                        break

                if stop_event_id:
                    # Route as instruction — Claude Code interprets /clear and /compact
                    ipc_dir = IPC_DIR / target_session
                    self._write_response(ipc_dir, stop_event_id, {"instruction": f"/{command}"})
                    msg_id = self.pending_events[stop_event_id]["message_id"]
                    self.tg.edit_message(msg_id, f"▶️ Running /{command}")
                    del self.pending_events[stop_event_id]
                else:
                    # Queue it for when Claude next stops
                    ipc_dir = IPC_DIR / target_session
                    queued_path = ipc_dir / "queued_instruction.json"
                    try:
                        with open(queued_path, "w") as f:
                            json.dump({"instruction": f"/{command}", "timestamp": time.time()}, f)
                    except OSError:
                        pass
```

This is simpler — it reuses the existing instruction routing mechanism. The hook's keep-alive loop already watches for response files via `_poll_response_or_kill`.

**Step 3: Test manually**

```bash
# 1. Start an AFK session, let Claude finish a task
# 2. On Telegram, send "/compact" in the session topic
# 3. Expected: Claude receives /compact as instruction, compacts context
# 4. Send "/clear" — Claude receives /clear, clears context
# 5. Check daemon.log for "[CONTEXT] Intercepted" messages
```

**Step 4: Commit**

```bash
git add bridge.py hook.py
git commit -m "feat: /clear and /compact command interception from Telegram"
```

---

### Task 7: Config Defaults Update

**Files:**
- Modify: `config.json`

**Step 1: Add new config keys**

Add to `config.json`:

```json
{
  "bot_token": "",
  "chat_id": "",
  "permission_timeout": 300,
  "stop_timeout": 600,
  "auto_approve_tools": [
    "Read", "Glob", "Grep", "WebSearch", "WebFetch",
    "TaskList", "TaskGet", "TaskCreate", "TaskUpdate"
  ],
  "max_slots": 4,
  "keep_alive_poll_seconds": 60,
  "idle_ping_hours": 12,
  "context_warning_threshold": 150
}
```

**Step 2: Commit**

```bash
git add config.json
git commit -m "feat: add config defaults for keep-alive and context management"
```

---

### Task 8: Integration Test — Full Flow

**No code changes.** Manual test to verify all features work together.

**Step 1: Fresh start**

```bash
# Deactivate any existing sessions
~/.claude/hooks/telegram-bridge/hook.sh --status
# (deactivate any active sessions)
```

**Step 2: Test keep-alive**

1. Start AFK session with `/afk`
2. Let Claude finish a task
3. Wait 2+ minutes without responding
4. Verify hook.log shows keep-alive pings
5. Send a message on Telegram — verify it still works

**Step 3: Test zombie detection**

1. Start AFK session
2. Delete the Telegram topic manually
3. Trigger a Stop or permission event
4. Verify daemon kills the session (check daemon.log)
5. Verify hook process exits

**Step 4: Test double /afk guard**

1. Try to activate same project+topic twice
2. Verify second activation is blocked with warning

**Step 5: Test /compact and /clear**

1. Start AFK session, do some work
2. Send `/compact` from Telegram
3. Verify Claude receives it and compacts
4. Send `/clear` from Telegram
5. Verify Claude receives it and clears

**Step 6: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: integration test fixes"
```
