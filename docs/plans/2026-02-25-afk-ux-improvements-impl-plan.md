# AFK UX Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix stuck agent issues, batch permission requests, add typing indicator, /ping command, and remote session end.

**Architecture:** All changes are in bridge.py (daemon) and hook.py (hook). No new files. Config gets new optional fields with defaults. IPC protocol extended with force_clear file and retry flag.

**Tech Stack:** Python 3 stdlib only (urllib, json, os, time, pathlib)

---

### Task 1: Add `sendChatAction` to TelegramAPI

**Files:**
- Modify: `bridge.py:38-140` (TelegramAPI class)

**Step 1: Add `send_chat_action` method**

Add after `answer_callback` method (line 125):

```python
def send_chat_action(self, action="typing", thread_id=None):
    """Send chat action (typing indicator) to a topic."""
    data = {
        "chat_id": self.chat_id,
        "action": action,
    }
    if thread_id:
        data["message_thread_id"] = thread_id
    return self._request("sendChatAction", data)
```

**Step 2: Register /ping, /end commands in `set_my_commands`**

Update `set_my_commands` (line 64-72) to include new commands:

```python
def set_my_commands(self):
    data = {
        "commands": [
            {"command": "compact", "description": "Compress conversation context"},
            {"command": "clear", "description": "Clear conversation history"},
            {"command": "ping", "description": "Check if agent is alive"},
            {"command": "end", "description": "End AFK session from Telegram"},
        ]
    }
    return self._request("setMyCommands", data)
```

**Step 3: Commit**

```bash
git add bridge.py
git commit -m "feat: add sendChatAction and register /ping, /end commands"
```

---

### Task 2: Implement typing indicator in daemon

**Files:**
- Modify: `bridge.py:225-278` (BridgeDaemon.__init__ and run loop)
- Modify: `bridge.py:486-502` (callback handlers for allow/stop)
- Modify: `bridge.py:676-683` (message handler — instruction routing)

**Step 1: Add typing state to `__init__`**

After `self.context_warning_sent = {}` (line 238), add:

```python
# Typing indicator: session_id -> True when Claude is processing
self.typing_sessions = {}
self.typing_last_sent = {}  # session_id -> timestamp of last typing action
```

**Step 2: Add `_update_typing` method**

Add after `_send_context_warning` method (around line 803):

```python
def _update_typing(self):
    """Send typing action for sessions where Claude is working."""
    now = time.time()
    for session_id in list(self.typing_sessions.keys()):
        if not self.typing_sessions.get(session_id):
            continue
        last = self.typing_last_sent.get(session_id, 0)
        if now - last >= 4.5:
            thread_id = self.session_threads.get(session_id)
            if thread_id:
                self.tg.send_chat_action("typing", thread_id=thread_id)
            self.typing_last_sent[session_id] = now
```

**Step 3: Call `_update_typing` in main loop**

In `run()` (line 247-277), add call after event scan, before Telegram polling:

```python
# In run() loop, after _scan_events call:
self._update_typing()
```

**Step 4: Start typing when instruction sent to Claude**

In `_handle_callback` — after `allow` action writes response (line 487):
```python
# After self._write_response for allow:
self.typing_sessions[session_id] = True
```

In `_handle_message` — after writing instruction response (line 678):
```python
# After self._write_response for instruction:
self.typing_sessions[target_session] = True
```

**Step 5: Stop typing when event arrives from Claude**

In `_process_event` (line 318), at the top before the if/elif chain:
```python
# Stop typing when we hear back from Claude
if etype in ("stop", "permission_request", "response", "notification"):
    self.typing_sessions[session_id] = False
```

**Step 6: Commit**

```bash
git add bridge.py
git commit -m "feat: native Telegram typing indicator while Claude processes"
```

---

### Task 3: Implement /ping command

**Files:**
- Modify: `bridge.py:590-649` (command interception in `_handle_message`)

**Step 1: Add /ping to command interception**

In `_handle_message` (line 596-649), add `/ping` handling before the COMMAND_MAP block. Insert after the `@botname` strip (line 588) and before COMMAND_MAP:

```python
# Handle /ping — daemon answers directly, no IPC needed
if text.lower() == "/ping":
    target_session = None
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
        # Check last event timestamp
        event_file = IPC_DIR / target_session / "events.jsonl"
        last_activity = 0
        try:
            if event_file.exists():
                with open(event_file) as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                ev = json.loads(line)
                                ts = ev.get("timestamp", 0)
                                if ts > last_activity:
                                    last_activity = ts
                            except json.JSONDecodeError:
                                pass
        except OSError:
            pass

        now = time.time()
        if last_activity > 0:
            age = int(now - last_activity)
            if age < 60:
                status = f"🏓 Agent alive — last activity {age}s ago"
            elif age < 300:
                status = f"⚠️ Agent slow — last activity {age}s ago. Try /clear if stuck"
            else:
                status = f"💀 Agent likely stuck — no activity for {age}s. Use /clear to restart"
        else:
            status = "❓ No activity data available"

        # Check if there's a pending event waiting for response
        pending_info = ""
        for eid, info in self.pending_events.items():
            if info["session_id"] == target_session:
                pending_info = f"\n📋 Pending: {info['type']} (event {eid})"
                break

        self.tg.send_message(
            f"{status}{pending_info}",
            thread_id=msg_thread_id,
        )
    else:
        self.tg.send_message("❓ No session found for this topic", thread_id=msg_thread_id)
    return
```

**Step 2: Add stale warning in `_scan_events`**

Add a stale detection check. After `_scan_events` method, add new method:

```python
def _check_stale_events(self):
    """Warn if pending events have been waiting too long."""
    stale_seconds = self.config.get("stale_warning_seconds", 90)
    now = time.time()
    for event_id, info in list(self.pending_events.items()):
        created = info.get("created_at", now)
        session_id = info["session_id"]
        warned_key = f"stale_{event_id}"

        if now - created > stale_seconds and warned_key not in self.context_warning_sent:
            age = int(now - created)
            thread_id = self.session_threads.get(session_id)
            if thread_id:
                self.tg.send_message(
                    f"⚠️ Agent may be unresponsive — pending {info['type']} for {age}s.\nTry /ping or /clear",
                    thread_id=thread_id,
                )
            self.context_warning_sent[warned_key] = True
            log.warning(f"[STALE] Event {event_id} pending for {age}s")
```

And call it in `run()` loop alongside `_update_typing`:

```python
self._check_stale_events()
```

Also, when creating pending events (permission_request and stop), add `created_at`:

```python
# In pending_events dict creation, add:
"created_at": time.time(),
```

**Step 3: Commit**

```bash
git add bridge.py
git commit -m "feat: /ping command and automatic stale event warnings"
```

---

### Task 4: Implement /end command and "End AFK" button

**Files:**
- Modify: `bridge.py:217-221` (stop_keyboard function)
- Modify: `bridge.py:462-502` (_handle_callback)
- Modify: `bridge.py:590-649` (_handle_message command interception)

**Step 1: Add "End AFK" button to stop keyboard**

Update `stop_keyboard` (line 217-221):

```python
def stop_keyboard(event_id, session_id):
    return {"inline_keyboard": [
        [{"text": "🛑 Let it stop", "callback_data": f"stop:{event_id}"}],
        [{"text": "🔚 End AFK Session", "callback_data": f"end_session:{session_id}"}],
    ]}
```

Update all callers of `stop_keyboard` to pass `session_id`:
- Line 413: `kb = stop_keyboard(event_id, session_id)`

**Step 2: Handle `end_session` callback**

In `_handle_callback` (after the `stop` action handler, around line 502), add:

```python
elif action == "end_session":
    target_sid = event_id  # callback_data is "end_session:{session_id}"
    self.tg.answer_callback(cq_id, "Ending AFK session...")
    thread_id = self.session_threads.get(target_sid)
    if thread_id:
        self.tg.send_message("👋 <b>AFK Session ended from Telegram</b>", thread_id=thread_id)
    self._kill_session(target_sid, "ended from Telegram")
    # Also resolve any pending stop events for this session
    for eid in list(self.pending_events.keys()):
        if self.pending_events[eid]["session_id"] == target_sid:
            del self.pending_events[eid]
    # Clean up typing
    self.typing_sessions.pop(target_sid, None)
```

Note: `end_session` must be added to the skip-pending-lookup list (line 473):

```python
if action in ("compact", "clear", "dismiss_ctx", "end_session"):
```

**Step 3: Handle /end command in messages**

In `_handle_message`, add `/end` alongside `/ping` handling (before COMMAND_MAP):

```python
if text.lower() == "/end":
    target_session = None
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
        self.tg.send_message("👋 <b>AFK Session ended from Telegram</b>", thread_id=msg_thread_id)
        self._kill_session(target_session, "ended from Telegram via /end")
        for eid in list(self.pending_events.keys()):
            if self.pending_events[eid]["session_id"] == target_session:
                del self.pending_events[eid]
        self.typing_sessions.pop(target_session, None)
    else:
        self.tg.send_message("❓ No session found for this topic", thread_id=msg_thread_id)
    return
```

**Step 4: Handle kill file in hook.py for clean console exit**

In `hook.py`, update the Stop handler's kill detection (line 700-702). Currently it just exits — add a stderr message:

```python
if response and response.get("_killed"):
    reason = response.get("_reason", "topic deleted")
    print(f"\n🔚 AFK session ended from Telegram ({reason}). Returning control to local console.", file=sys.stderr)
    log.info(f"[STOP] Killed by daemon: {reason}")
    sys.exit(0)
```

Also update `_poll_response_or_kill` to read the kill file content:

```python
if _check_kill_file(ipc_dir):
    reason = "unknown"
    kill_path = os.path.join(ipc_dir, "kill")
    try:
        with open(kill_path) as f:
            reason = f.read().strip() or "unknown"
    except OSError:
        pass
    log.info(f"[POLL] Kill file detected: {reason}")
    return {"_killed": True, "_reason": reason}
```

**Step 5: Commit**

```bash
git add bridge.py hook.py
git commit -m "feat: /end command and End AFK button for remote session termination"
```

---

### Task 5: Permission batching (Tier 2)

**Files:**
- Modify: `bridge.py:318-375` (_process_event for permission_request)
- Modify: `bridge.py:462-496` (_handle_callback for batch approve/deny)

**Step 1: Add batch state to `__init__`**

After typing state in `__init__`:

```python
# Permission batching: session_id -> {events: [...], timer_start: float}
self.permission_batch = {}
```

**Step 2: Modify permission_request processing for batching**

Replace the `permission_request` handling in `_process_event` (lines 361-375):

```python
elif etype == "permission_request":
    self._increment_interaction(session_id)
    batch_window = self.config.get("permission_batch_window_seconds", 2)

    if session_id not in self.permission_batch:
        self.permission_batch[session_id] = {
            "events": [],
            "timer_start": time.time(),
            "thread_id": thread_id,
            "slot": slot,
        }

    self.permission_batch[session_id]["events"].append(event)
    log.info(f"[PERMISSION] Queued event {event_id} for batching ({len(self.permission_batch[session_id]['events'])} in batch)")
```

**Step 3: Add batch flush method**

Add after `_check_stale_events`:

```python
def _flush_permission_batches(self):
    """Send batched permission requests that have waited long enough."""
    batch_window = self.config.get("permission_batch_window_seconds", 2)
    now = time.time()

    for session_id in list(self.permission_batch.keys()):
        batch = self.permission_batch[session_id]
        if now - batch["timer_start"] < batch_window:
            continue  # Still collecting

        events = batch["events"]
        thread_id = batch["thread_id"]
        slot = batch["slot"]
        del self.permission_batch[session_id]

        if len(events) == 1:
            # Single request — use normal format
            event = events[0]
            event_id = event["id"]
            text = format_permission_message(event, slot)
            # Check session trust
            if self._is_session_trusted(session_id):
                self._auto_approve_permission(event, session_id)
                return
            kb = permission_keyboard(event_id)
            result = self._send_to_session(text, session_id, reply_markup=kb)
            if result and result.get("ok"):
                self.pending_events[event_id] = {
                    "session_id": session_id,
                    "type": "permission_request",
                    "message_id": result["result"]["message_id"],
                    "slot": slot,
                    "created_at": time.time(),
                }
        else:
            # Batch — combined message with Approve All
            batch_id = str(uuid.uuid4())[:8]
            lines = [f"🔐 <b>Permission Requests ({len(events)})</b>\n"]
            event_ids = []
            for i, ev in enumerate(events, 1):
                tool = ev.get("tool_name", "?")
                desc = ev.get("description", "")
                short_desc = desc.split("\n")[0][:80] if desc else ""
                lines.append(f"{i}. <b>{escape_html(tool)}</b>: {escape_html(short_desc)}")
                event_ids.append(ev["id"])

            text = "\n".join(lines)
            # Check session trust
            if self._is_session_trusted(session_id):
                for ev in events:
                    self._auto_approve_permission(ev, session_id)
                return

            kb = {"inline_keyboard": [
                [{"text": f"✅ Approve All ({len(events)})", "callback_data": f"approve_all:{batch_id}"},
                 {"text": "❌ Deny All", "callback_data": f"deny_all:{batch_id}"}],
            ]}
            result = self._send_to_session(text, session_id, reply_markup=kb)
            if result and result.get("ok"):
                self.pending_events[batch_id] = {
                    "session_id": session_id,
                    "type": "permission_batch",
                    "message_id": result["result"]["message_id"],
                    "event_ids": event_ids,
                    "slot": slot,
                    "created_at": time.time(),
                }
```

**Step 4: Add batch approve/deny callback handlers**

In `_handle_callback`, add to the skip-pending-lookup list:

```python
if action in ("compact", "clear", "dismiss_ctx", "end_session", "approve_all", "deny_all", "trust_session"):
```

Then add handlers (after `end_session` handler):

```python
elif action in ("approve_all", "deny_all"):
    batch_id = event_id  # callback_data is "approve_all:{batch_id}"
    batch_info = self.pending_events.get(batch_id)
    if not batch_info:
        self.tg.answer_callback(cq_id, "Batch expired")
        return
    session_id = batch_info["session_id"]
    ipc_dir = IPC_DIR / session_id
    decision = "allow" if action == "approve_all" else "deny"
    msg = "" if action == "approve_all" else "Denied via Telegram (batch)"

    for eid in batch_info.get("event_ids", []):
        if decision == "allow":
            self._write_response(ipc_dir, eid, {"decision": "allow"})
        else:
            self._write_response(ipc_dir, eid, {"decision": "deny", "message": msg})

    count = len(batch_info.get("event_ids", []))
    label = "Approved" if action == "approve_all" else "Denied"
    self.tg.answer_callback(cq_id, f"{label} {count} requests")
    self.tg.edit_message(batch_info["message_id"], f"{'✅' if decision == 'allow' else '❌'} {label} all ({count})")
    del self.pending_events[batch_id]

    # Track approvals for session trust
    if decision == "allow":
        self._track_approval(session_id, count)
    # Start typing if approved
    if decision == "allow":
        self.typing_sessions[session_id] = True
```

**Step 5: Call `_flush_permission_batches` in run loop**

In `run()`, add alongside other per-loop calls:

```python
self._flush_permission_batches()
```

**Step 6: Add uuid import to bridge.py**

Add `import uuid` to bridge.py imports (not yet imported there).

**Step 7: Commit**

```bash
git add bridge.py
git commit -m "feat: permission request batching with Approve All button"
```

---

### Task 6: Session trust (Tier 3)

**Files:**
- Modify: `bridge.py` (BridgeDaemon class)

**Step 1: Add trust state to `__init__`**

```python
# Session trust: session_id -> True when user trusts all permissions
self.trusted_sessions = {}
self.approval_counts = {}  # session_id -> count of individual approvals
```

**Step 2: Add helper methods**

```python
def _is_session_trusted(self, session_id):
    return self.trusted_sessions.get(session_id, False)

def _track_approval(self, session_id, count=1):
    """Track approval count and offer trust after threshold."""
    self.approval_counts[session_id] = self.approval_counts.get(session_id, 0) + count
    threshold = self.config.get("session_trust_threshold", 3)
    if self.approval_counts[session_id] >= threshold and not self._is_session_trusted(session_id):
        thread_id = self.session_threads.get(session_id)
        if thread_id:
            kb = {"inline_keyboard": [
                [{"text": "🔓 Trust this session", "callback_data": f"trust_session:{session_id}"}],
            ]}
            self.tg.send_message(
                f"💡 You've approved {self.approval_counts[session_id]} requests. Trust this session to auto-approve?",
                thread_id=thread_id,
                reply_markup=kb,
            )

def _auto_approve_permission(self, event, session_id):
    """Auto-approve a permission request (for trusted sessions)."""
    event_id = event["id"]
    ipc_dir = IPC_DIR / session_id
    self._write_response(ipc_dir, event_id, {"decision": "allow"})
    tool_name = event.get("tool_name", "?")
    thread_id = self.session_threads.get(session_id)
    if thread_id:
        self.tg.send_message(f"✅ Auto-approved (trusted): {escape_html(tool_name)}", thread_id=thread_id)
    self.typing_sessions[session_id] = True
    log.info(f"[TRUST] Auto-approved {tool_name} for trusted session {session_id[:8]}")
```

**Step 3: Handle trust_session callback**

In `_handle_callback`:

```python
elif action == "trust_session":
    target_sid = event_id
    self.trusted_sessions[target_sid] = True
    self.tg.answer_callback(cq_id, "Session trusted!")
    thread_id = self.session_threads.get(target_sid)
    if thread_id:
        self.tg.send_message("🔓 <b>Session trusted</b> — all permissions will auto-approve", thread_id=thread_id)
    log.info(f"[TRUST] Session {target_sid[:8]} trusted by user")
```

**Step 4: Reset trust on /clear**

In the clear command handler (line 568-570), add:

```python
self.trusted_sessions.pop(target_sid, None)
self.approval_counts.pop(target_sid, None)
```

**Step 5: Track individual approvals**

In the existing `allow` callback handler (line 486-490), add after the existing code:

```python
self._track_approval(session_id)
```

**Step 6: Commit**

```bash
git add bridge.py
git commit -m "feat: session trust with auto-approve after threshold"
```

---

### Task 7: Path-based auto-approve (Tier 1)

**Files:**
- Modify: `hook.py:591-605` (PermissionRequest auto-approve logic)

**Step 1: Add path matching to auto-approve check**

Replace the simple auto-approve check in `cmd_hook` (lines 594-605):

```python
# Auto-approve: check tool name + optional path matching
if tool_name in auto_approve:
    # For tools with file paths, also check auto_approve_paths
    auto_paths = config.get("auto_approve_paths", [])
    if auto_paths:
        # Extract path from tool input
        tool_input = event_data.get("tool_input", {})
        file_path = (tool_input.get("file_path") or
                     tool_input.get("path") or
                     tool_input.get("notebook_path") or "")
        if file_path:
            import fnmatch
            path_approved = any(fnmatch.fnmatch(file_path, pat) for pat in auto_paths)
            if not path_approved:
                pass  # Fall through to Telegram approval
            else:
                result = {
                    "hookSpecificOutput": {
                        "hookEventName": "PermissionRequest",
                        "decision": {"behavior": "allow"},
                    },
                }
                json.dump(result, sys.stdout)
                sys.exit(0)
        else:
            # Tool has no path (e.g. WebSearch) — auto-approve by tool name alone
            result = {
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {"behavior": "allow"},
                },
            }
            json.dump(result, sys.stdout)
            sys.exit(0)
    else:
        # No path rules configured — auto-approve by tool name alone (existing behavior)
        result = {
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": {"behavior": "allow"},
            },
        }
        json.dump(result, sys.stdout)
        sys.exit(0)
```

**Step 2: Commit**

```bash
git add hook.py
git commit -m "feat: path-based auto-approve for permission requests"
```

---

### Task 8: IPC reliability — force_clear and retry

**Files:**
- Modify: `bridge.py:590-649` (command interception — /clear writes force_clear)
- Modify: `hook.py:787-833` (polling functions — check force_clear, add retry)

**Step 1: Write `force_clear` file on /clear command**

In bridge.py `_handle_message`, in the `/clear` command handling section (around line 616-648), add after writing the queued instruction or response:

```python
# Always write force_clear as backup (bypasses stuck IPC)
force_clear_path = IPC_DIR / target_session / "force_clear"
try:
    with open(force_clear_path, "w") as f:
        f.write(str(time.time()))
    log.info(f"[CLEAR] Wrote force_clear for session {target_session[:8]}")
except OSError:
    pass
```

Also add the same in the `clear` callback handler (line 540-570).

**Step 2: Check force_clear in hook.py polling**

Update `_poll_response` (line 813-833) to also check for force_clear:

```python
def _poll_response(ipc_dir, event_id, timeout):
    """Poll for a response file written by the daemon. Returns dict or None."""
    response_path = os.path.join(ipc_dir, f"response-{event_id}.json")
    force_clear_path = os.path.join(ipc_dir, "force_clear")
    deadline = time.time() + timeout
    interval = 0.5

    while time.time() < deadline:
        # Check force_clear first (bypasses stuck IPC)
        if os.path.exists(force_clear_path):
            try:
                os.remove(force_clear_path)
            except OSError:
                pass
            log.info("[POLL] force_clear detected, returning clear instruction")
            return {"decision": "allow"}  # Allow the pending tool so /clear can proceed

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

Update `_poll_response_or_kill` (line 787-810) similarly:

```python
def _poll_response_or_kill(ipc_dir, event_id, timeout):
    """Poll for response, but exit early if kill or force_clear appears."""
    response_path = os.path.join(ipc_dir, f"response-{event_id}.json")
    force_clear_path = os.path.join(ipc_dir, "force_clear")
    deadline = time.time() + timeout
    interval = 0.5

    while time.time() < deadline:
        if _check_kill_file(ipc_dir):
            reason = "unknown"
            kill_path = os.path.join(ipc_dir, "kill")
            try:
                with open(kill_path) as f:
                    reason = f.read().strip() or "unknown"
            except OSError:
                pass
            log.info(f"[POLL] Kill file detected: {reason}")
            return {"_killed": True, "_reason": reason}

        # Check force_clear
        if os.path.exists(force_clear_path):
            try:
                os.remove(force_clear_path)
            except OSError:
                pass
            log.info("[POLL] force_clear detected, returning /clear instruction")
            return {"instruction": "/clear"}

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

**Step 3: Add retry logic to permission polling**

In `_poll_response`, add retry after 30s. Replace the timeout return at the end:

```python
    # After 30s with no response, check if event was processed but response lost
    retry_at = time.time() + 30
    retried = False

    while time.time() < deadline:
        # ... existing polling code ...

        # Retry: re-append event if no response after 30s
        if not retried and time.time() > retry_at:
            event_file = os.path.join(ipc_dir, "events.jsonl")
            # We don't have the event here — just log a warning
            log.warning(f"[POLL] No response for event {event_id} after 30s")
            retried = True

    return None
```

Actually, simpler approach — just log the warning rather than re-append (re-appending needs the full event which polling doesn't have). The force_clear mechanism handles the /clear case which is the main stuck scenario.

**Step 4: Commit**

```bash
git add bridge.py hook.py
git commit -m "feat: force_clear bypass for stuck IPC and improved polling"
```

---

### Task 9: Config defaults and cleanup

**Files:**
- Modify: `bridge.py` (config reads with defaults)
- Modify: `hook.py` (config reads)

**Step 1: Document new config fields**

Add defaults wherever config is read. All new fields already use `.get()` with defaults:
- `stale_warning_seconds`: 90
- `permission_batch_window_seconds`: 2
- `session_trust_threshold`: 3

No code changes needed — already handled by `.get()` with defaults in each usage.

**Step 2: Update install.sh to document new config options**

In install.sh, if there's a config template, add the new fields. Otherwise just document in README.

**Step 3: Final integration test**

Manual test checklist:
1. Run `/afk` → verify activation works
2. Send a message → verify typing dots appear while Claude works
3. Send `/ping` → verify health check response
4. Trigger multiple permission requests → verify batching
5. Approve 3+ requests → verify trust offer appears
6. Tap "Trust Session" → verify auto-approve
7. Send `/clear` → verify force_clear works even if stuck
8. Send `/end` → verify session ends cleanly with console message
9. Click "End AFK" button → verify same behavior

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: complete AFK UX improvements — batching, typing, ping, trust, remote end"
```
