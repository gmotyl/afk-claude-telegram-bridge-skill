#!/usr/bin/env python3
"""
telegram-bridge bridge.py — Telegram long-polling daemon.
Supports Telegram Topics and Message Buffer for queuing instructions.
"""
import json
import logging
import os
import signal
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BRIDGE_DIR = Path.home() / ".claude" / "hooks" / "telegram-bridge"
CONFIG_PATH = BRIDGE_DIR / "config.json"
STATE_PATH = BRIDGE_DIR / "state.json"
IPC_DIR = BRIDGE_DIR / "ipc"

HEARTBEAT_INTERVAL = 30
POLL_TIMEOUT = 30
EVENT_SCAN_INTERVAL = 0.5

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [bridge] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("bridge")

# ─── Telegram API ────────────────────────────────────────────────────────────


class TelegramAPI:
    def __init__(self, token, chat_id):
        self.token = token
        self.chat_id = str(chat_id)
        self.base_url = f"https://api.telegram.org/bot{token}"
        self.update_offset = 0

    def _request(self, method, data=None):
        url = f"{self.base_url}/{method}"
        if data:
            payload = json.dumps(data).encode("utf-8")
            req = urllib.request.Request(
                url, data=payload, headers={"Content-Type": "application/json"}
            )
        else:
            req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=POLL_TIMEOUT + 5) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as e:
            log.warning("Telegram API error on %s: %s", method, e)
            return None
        except Exception as e:
            log.warning("Unexpected error on %s: %s", method, e)
            return None

    def set_my_commands(self):
        """Register bot commands for Telegram command menu."""
        data = {
            "commands": [
                {"command": "compact", "description": "Compress conversation context"},
                {"command": "clear", "description": "Clear conversation history"},
                {"command": "ping", "description": "Check if agent is alive"},
                {"command": "end", "description": "End AFK session from Telegram"},
            ]
        }
        return self._request("setMyCommands", data)

    def create_forum_topic(self, name):
        """Create a new forum topic in the Telegram group"""
        data = {
            "chat_id": self.chat_id,
            "name": name
        }
        return self._request("createForumTopic", data)

    def delete_forum_topic(self, thread_id):
        """Delete a forum topic from the Telegram group"""
        data = {
            "chat_id": self.chat_id,
            "message_thread_id": thread_id
        }
        return self._request("deleteForumTopic", data)

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

    def edit_message(self, message_id, text, reply_markup=None, parse_mode="HTML"):
        data = {
            "chat_id": self.chat_id,
            "message_id": message_id,
            "text": text,
            "parse_mode": parse_mode,
        }
        if reply_markup:
            data["reply_markup"] = reply_markup
        return self._request("editMessageText", data)

    def answer_callback(self, callback_query_id, text=""):
        data = {"callback_query_id": callback_query_id}
        if text:
            data["text"] = text
        return self._request("answerCallbackQuery", data)

    def send_chat_action(self, action="typing", thread_id=None):
        """Send chat action (typing indicator) to a topic."""
        data = {
            "chat_id": self.chat_id,
            "action": action,
        }
        if thread_id:
            data["message_thread_id"] = thread_id
        return self._request("sendChatAction", data)

    def get_updates(self, timeout=POLL_TIMEOUT):
        data = {
            "offset": self.update_offset,
            "timeout": timeout,
            "allowed_updates": ["message", "callback_query"],
        }
        result = self._request("getUpdates", data)
        if result and result.get("ok"):
            updates = result.get("result", [])
            if updates:
                self.update_offset = updates[-1]["update_id"] + 1
            return updates
        return []


# ─── State helpers ───────────────────────────────────────────────────────────

def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"slots": {}, "daemon_pid": None}


def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def get_slot_for_session(state, session_id):
    for slot_num, info in state.get("slots", {}).items():
        if info.get("session_id") == session_id:
            return slot_num
    return None


def get_active_sessions(state):
    sessions = {}
    for slot_num, info in state.get("slots", {}).items():
        sid = info.get("session_id")
        if sid:
            sessions[sid] = slot_num
    return sessions


# ─── Message formatting ─────────────────────────────────────────────────────

def escape_html(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def format_permission_message(event, slot):
    tool = event.get("tool_name", "?")
    desc = event.get("description", "")
    return f"🔐 <b>Permission Request</b>\n\n<b>Tool:</b> {escape_html(tool)}\n\n<pre>{escape_html(desc)}</pre>"


def format_stop_message(event, slot):
    last_msg = event.get("last_message", "")
    if last_msg:
        last_msg = escape_html(last_msg)
        if len(last_msg) > 600:
            last_msg = last_msg[:600] + "..."
    return f"✅ <b>Task Complete</b>\n\n{last_msg}\n\n<i>Reply to give next instruction...</i>"


def format_notification_message(event, slot):
    ntype = event.get("notification_type", "")
    msg = escape_html(event.get("message", ""))
    title = escape_html(event.get("title", ""))
    emoji = {"permission_prompt": "🔔", "idle_prompt": "💤"}.get(ntype, "📢")
    return f"{emoji} {title}\n{msg}"


def permission_keyboard(event_id):
    return {"inline_keyboard": [
        [{"text": "✅ Approve", "callback_data": f"allow:{event_id}"},
         {"text": "❌ Deny", "callback_data": f"deny:{event_id}"}]
    ]}


def stop_keyboard(event_id, session_id):
    return {"inline_keyboard": [
        [{"text": "🔚 End AFK Session", "callback_data": f"end_session:{session_id}"}],
    ]}


# ─── Daemon ──────────────────────────────────────────────────────────────────

class BridgeDaemon:
    def __init__(self):
        self.config = load_config()
        self.tg = TelegramAPI(self.config["bot_token"], self.config["chat_id"])
        self.running = True
        self.event_positions = {}
        self.pending_events = {}
        # Map: session_id -> message_thread_id (Topic ID)
        self.session_threads = {}
        # Idle ping tracking: session_id -> last_ping_timestamp
        self.last_idle_ping = {}
        # Context management: session_id -> interaction count
        self.interaction_counts = {}
        self.context_warning_sent = {}  # session_id -> threshold at which warning was sent
        # Typing indicator: session_id -> True when Claude is processing
        self.typing_sessions = {}
        self.typing_last_sent = {}  # session_id -> timestamp of last typing action
        # Permission batching: session_id -> {events: [...], timer_start: float}
        self.permission_batch = {}
        # Session trust: session_id -> True when user trusts all permissions
        self.trusted_sessions = {}
        self.approval_counts = {}  # session_id -> count of individual approvals

        signal.signal(signal.SIGTERM, self._handle_sigterm)
        signal.signal(signal.SIGINT, self._handle_sigterm)

    def _handle_sigterm(self, signum, frame):
        log.info("Received signal %d, shutting down", signum)
        self.running = False

    def run(self):
        log.info("Bridge daemon starting")
        self.tg.set_my_commands()
        self.tg.get_updates(timeout=0)

        last_heartbeat, last_event_scan = 0, 0
        while self.running:
            now = time.time()

            if now - last_heartbeat > HEARTBEAT_INTERVAL:
                self._heartbeat()
                last_heartbeat = now

            if now - last_event_scan > EVENT_SCAN_INTERVAL:
                self._scan_events()
                last_event_scan = now

            self._update_typing()
            self._check_stale_events()
            self._flush_permission_batches()

            try:
                updates = self.tg.get_updates(timeout=2)
                for update in updates:
                    self._handle_update(update)
            except Exception as e:
                log.error("Error polling Telegram: %s", e)
                time.sleep(2)

            state = load_state()
            if not state.get("slots"):
                log.info("No active sessions, shutting down")
                self.running = False

        log.info("Bridge daemon stopped")

    def _heartbeat(self):
        try:
            state = load_state()
            state["daemon_heartbeat"] = time.time()
            save_state(state)
        except Exception:
            pass

    def _scan_events(self):
        if not IPC_DIR.exists():
            return

        state = load_state()
        active = get_active_sessions(state)

        for session_id, slot in active.items():
            event_file = IPC_DIR / session_id / "events.jsonl"
            if not event_file.exists():
                continue

            pos = self.event_positions.get(session_id, 0)
            try:
                with open(event_file) as f:
                    f.seek(pos)
                    new_lines = f.readlines()
                    self.event_positions[session_id] = f.tell()
            except OSError:
                continue

            for line in new_lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    self._process_event(event, session_id, slot)
                except json.JSONDecodeError:
                    pass

    def _process_event(self, event, session_id, slot):
        etype = event.get("type", "")
        event_id = event.get("id", "")
        thread_id = self.session_threads.get(session_id)
        log.info(f"[EVENT] Processing {etype} (id={event_id}) for session {session_id[:8]}... thread={thread_id}")

        # Stop typing when we hear back from Claude
        if etype in ("stop", "permission_request", "response", "notification"):
            self.typing_sessions[session_id] = False

        if etype == "activation":
            project = event.get("project", "Unknown")
            topic_name = event.get("topic_name", f"S{slot} - {project[:15]}")
            log.info(f"[ACTIVATION] Creating topic '{topic_name}' for {project}")
            res = self.tg.create_forum_topic(topic_name)

            if res and res.get("ok"):
                thread_id = res["result"]["message_thread_id"]
                self.session_threads[session_id] = thread_id
                log.info(f"[ACTIVATION] Topic created: thread_id={thread_id}")
                # Persist thread_id to state.json so hook.py can delete topic as fallback
                try:
                    st = load_state()
                    for s_num, s_info in st.get("slots", {}).items():
                        if s_info.get("session_id") == session_id:
                            s_info["thread_id"] = thread_id
                            save_state(st)
                            break
                except Exception as e:
                    log.error(f"[ACTIVATION] Failed to persist thread_id: {e}")
            else:
                log.error(f"[ACTIVATION] Failed to create topic: {res}")

            self.tg.send_message(f"📡 <b>AFK Activated</b>\nProject: {escape_html(project)}", thread_id=thread_id)
            self.last_idle_ping[session_id] = time.time()

        elif etype == "deactivation":
            log.info(f"[DEACTIVATION] Processing for session {session_id[:8]}...")
            # Send deactivation message first (if thread exists)
            if thread_id:
                self.tg.send_message(f"👋 <b>AFK Deactivated</b>", thread_id=thread_id)

            # Delete the forum topic
            if session_id in self.session_threads:
                topic_id = self.session_threads[session_id]
                log.info(f"[DEACTIVATION] Deleting topic {topic_id}")
                self.tg.delete_forum_topic(topic_id)
                del self.session_threads[session_id]

            # Signal that deactivation was processed
            processed_path = IPC_DIR / session_id / "deactivation_processed"
            try:
                with open(processed_path, "w") as f:
                    f.write("done")
            except OSError:
                pass

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

        elif etype == "stop":
            self._increment_interaction(session_id)
            is_response = event.get("stop_hook_active", False)

            # If this is a response to a Telegram instruction, forward the response first
            if is_response:
                last_msg = event.get("last_message", "").strip()
                if last_msg:
                    text = f"🤖 {escape_html(last_msg)}"
                    self._send_to_session(text, session_id)
                    log.info(f"[STOP] Forwarded response to Telegram (stop_hook_active)")
                # Fall through to normal stop handling — create pending event
                # so the next Telegram message gets routed as the next instruction

            # Check for queued instruction — auto-inject if available
            queued_path = IPC_DIR / session_id / "queued_instruction.json"
            if queued_path.exists():
                try:
                    with open(queued_path) as f:
                        queued = json.load(f)
                    instruction = queued.get("instruction", "").strip()
                    if instruction:
                        self._write_response(IPC_DIR / session_id, event_id, {"instruction": instruction})
                        queued_path.unlink()
                        text = f"▶️ Auto-continuing with queued instruction:\n<i>{escape_html(instruction[:300])}</i>"
                        self.tg.send_message(text, thread_id=thread_id)
                        log.info(f"[STOP] Auto-injected queued instruction: {instruction[:80]}")
                        return
                except Exception as e:
                    log.error(f"[STOP] Error reading queued instruction: {e}")

            if is_response:
                # Response already forwarded above — just show the prompt
                text = f"<i>Reply to give next instruction...</i>"
            else:
                text = format_stop_message(event, slot)
            kb = stop_keyboard(event_id, session_id)
            result = self._send_to_session(text, session_id, reply_markup=kb)
            if result and result.get("ok"):
                self.pending_events[event_id] = {
                    "session_id": session_id,
                    "type": "stop",
                    "message_id": result["result"]["message_id"],
                    "slot": slot,
                    "created_at": time.time()
                }
                log.info(f"[STOP] Sent to Telegram, msg_id={result['result']['message_id']}")
            else:
                log.error(f"[STOP] Failed to send: {result}")

        elif etype == "notification":
            text = format_notification_message(event, slot)
            self._send_to_session(text, session_id)

        elif etype == "response":
            response_text = event.get("text", "").strip()
            if response_text:
                if len(response_text) > 3000:
                    response_text = response_text[:2900] + "\n...(truncated)"
                self._send_to_session(f"🤖 {response_text}", session_id)

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

    def _handle_update(self, update):
        if "callback_query" in update:
            self._handle_callback(update["callback_query"])
        elif "message" in update:
            self._handle_message(update["message"])

    def _handle_callback(self, cq):
        data = cq.get("data", "")
        cq_id = cq.get("id", "")

        if ":" not in data:
            self.tg.answer_callback(cq_id, "Unknown action")
            return

        action, event_id = data.split(":", 1)

        # Context management callbacks don't use pending_events
        if action in ("compact", "clear", "dismiss_ctx", "end_session", "approve_all", "deny_all", "trust_session"):
            pass  # handled below, skip pending lookup
        else:
            pending = self.pending_events.get(event_id)

            if not pending:
                self.tg.answer_callback(cq_id, "Event expired")
                return

            session_id = pending["session_id"]
            msg_id = pending["message_id"]
            ipc_session_dir = IPC_DIR / session_id

        if action == "allow":
            self._write_response(ipc_session_dir, event_id, {"decision": "allow"})
            self.typing_sessions[session_id] = True
            self.tg.answer_callback(cq_id, "Approved")
            self.tg.edit_message(msg_id, f"✅ Approved")
            del self.pending_events[event_id]
            self._track_approval(session_id)

        elif action == "deny":
            self._write_response(ipc_session_dir, event_id, {"decision": "deny", "message": "Denied via Telegram"})
            self.tg.answer_callback(cq_id, "Denied")
            self.tg.edit_message(msg_id, f"❌ Denied")
            del self.pending_events[event_id]

        elif action == "stop":
            self._write_response(ipc_session_dir, event_id, {"instruction": ""})
            self.tg.answer_callback(cq_id, "Stopping")
            self.tg.edit_message(msg_id, f"🛑 Stopped")
            del self.pending_events[event_id]

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

        elif action == "trust_session":
            target_sid = event_id
            self.trusted_sessions[target_sid] = True
            self.tg.answer_callback(cq_id, "Session trusted!")
            thread_id = self.session_threads.get(target_sid)
            if thread_id:
                self.tg.send_message("🔓 <b>Session trusted</b> — all permissions will auto-approve", thread_id=thread_id)
            log.info(f"[TRUST] Session {target_sid[:8]} trusted by user")

        elif action == "compact":
            # session_id is in event_id position for context commands
            target_sid = event_id  # callback_data is "compact:{session_id}"
            ipc_dir = IPC_DIR / target_sid

            # Find pending stop event for this session to route command
            stop_event_id = None
            for eid, info in self.pending_events.items():
                if info["session_id"] == target_sid and info["type"] == "stop":
                    stop_event_id = eid
                    break

            compact_instruction = (
                "Summarize and compress this conversation to preserve key context while reducing token usage. "
                "Keep: current task state, key decisions, file paths, active errors. "
                "Drop: completed tool outputs, verbose logs, resolved discussions."
            )
            if stop_event_id:
                self._write_response(ipc_dir, stop_event_id, {"instruction": compact_instruction})
                msg_id = self.pending_events[stop_event_id]["message_id"]
                self.tg.edit_message(msg_id, f"▶️ Running /compact")
                del self.pending_events[stop_event_id]
            else:
                # Queue it
                queued_path = ipc_dir / "queued_instruction.json"
                try:
                    with open(queued_path, "w") as f:
                        json.dump({"instruction": compact_instruction, "timestamp": time.time()}, f)
                except OSError:
                    pass

            self.tg.answer_callback(cq_id, "Compacting context...")
            thread_id = self.session_threads.get(target_sid)
            if thread_id:
                self.tg.send_message("📦 Compacting context...", thread_id=thread_id)

        elif action == "clear":
            target_sid = event_id
            ipc_dir = IPC_DIR / target_sid

            stop_event_id = None
            for eid, info in self.pending_events.items():
                if info["session_id"] == target_sid and info["type"] == "stop":
                    stop_event_id = eid
                    break

            if stop_event_id:
                self._write_response(ipc_dir, stop_event_id, {"instruction": "/clear"})
                msg_id = self.pending_events[stop_event_id]["message_id"]
                self.tg.edit_message(msg_id, f"▶️ Running /clear")
                del self.pending_events[stop_event_id]
            else:
                queued_path = ipc_dir / "queued_instruction.json"
                try:
                    with open(queued_path, "w") as f:
                        json.dump({"instruction": "/clear", "timestamp": time.time()}, f)
                except OSError:
                    pass

            # Always write force_clear as backup
            force_clear_path = IPC_DIR / target_sid / "force_clear"
            try:
                with open(force_clear_path, "w") as f:
                    f.write(str(time.time()))
                log.info(f"[CLEAR] Wrote force_clear for session {target_sid[:8]}")
            except OSError:
                pass

            self.tg.answer_callback(cq_id, "Clearing context...")
            thread_id = self.session_threads.get(target_sid)
            if thread_id:
                self.tg.send_message("🗑 Clearing context...", thread_id=thread_id)

            # Reset interaction counter
            self.interaction_counts[target_sid] = 0
            self.context_warning_sent[target_sid] = 0
            self.trusted_sessions.pop(target_sid, None)
            self.approval_counts.pop(target_sid, None)

        elif action == "dismiss_ctx":
            self.tg.answer_callback(cq_id, "Dismissed")

    def _handle_message(self, msg):
        text = msg.get("text", "").strip()
        chat_id = str(msg.get("chat", {}).get("id", ""))

        # Extract topic thread ID from message
        msg_thread_id = msg.get("message_thread_id")

        if chat_id != self.tg.chat_id or not text:
            return

        # Strip @botname suffix from commands (Telegram adds it in groups)
        # e.g. "/clear@Clade_motyl_ai_bot" -> "/clear"
        if text.startswith("/") and "@" in text.split()[0]:
            text = text.split("@")[0]

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

        # Handle /end — terminate AFK session from Telegram
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

        # Intercept context management commands
        COMPACT_INSTRUCTION = (
            "Summarize and compress this conversation to preserve key context while reducing token usage. "
            "Keep: current task state, key decisions, file paths, active errors. "
            "Drop: completed tool outputs, verbose logs, resolved discussions."
        )
        COMMAND_MAP = {
            "/clear": "/clear",
            "/compact": COMPACT_INSTRUCTION,
        }
        if text.lower() in COMMAND_MAP:
            command = text.lower().lstrip("/")
            instruction = COMMAND_MAP[text.lower()]
            # Find which session this topic belongs to
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
                ipc_dir = IPC_DIR / target_session

                # Find pending stop event to route command immediately
                stop_event_id = None
                for eid, info in self.pending_events.items():
                    if info["session_id"] == target_session and info["type"] == "stop":
                        stop_event_id = eid
                        break

                if stop_event_id:
                    self._write_response(ipc_dir, stop_event_id, {"instruction": instruction})
                    msg_id = self.pending_events[stop_event_id]["message_id"]
                    self.tg.edit_message(msg_id, f"▶️ Running /{command}")
                    del self.pending_events[stop_event_id]
                else:
                    queued_path = ipc_dir / "queued_instruction.json"
                    try:
                        with open(queued_path, "w") as f:
                            json.dump({"instruction": instruction, "timestamp": time.time()}, f)
                    except OSError:
                        pass

                # Always write force_clear as backup (bypasses stuck IPC)
                if command == "clear":
                    force_clear_path = IPC_DIR / target_session / "force_clear"
                    try:
                        with open(force_clear_path, "w") as f:
                            f.write(str(time.time()))
                        log.info(f"[CLEAR] Wrote force_clear for session {target_session[:8]}")
                    except OSError:
                        pass

                self.tg.send_message(
                    f"{'📦' if command == 'compact' else '🗑'} Sending /{command} to Claude...",
                    thread_id=msg_thread_id,
                )
                log.info(f"[CONTEXT] Intercepted /{command} for session {target_session[:8]}")

                # Reset counter on clear
                if command == "clear":
                    self.interaction_counts[target_session] = 0
                    self.context_warning_sent[target_session] = 0
                    self.trusted_sessions.pop(target_session, None)
                    self.approval_counts.pop(target_session, None)
            return

        # Find session assigned to this topic thread
        target_session = None
        for sid, t_id in self.session_threads.items():
            if t_id == msg_thread_id:
                target_session = sid
                break

        # Fallback — if no topic match, route to the only active session
        if not target_session:
            state = load_state()
            active = get_active_sessions(state)
            if len(active) == 1:
                target_session = list(active.keys())[0]
            else:
                return  # Ignore messages in main chat when multiple sessions active

        ipc_session_dir = IPC_DIR / target_session

        # Check if Claude is waiting for instruction (stop event pending)
        stop_event_id = None
        for eid, info in self.pending_events.items():
            if info["session_id"] == target_session and info["type"] == "stop":
                stop_event_id = eid
                break

        if stop_event_id:
            # Send instruction immediately — Claude is waiting
            self._write_response(ipc_session_dir, stop_event_id, {"instruction": text})
            self.typing_sessions[target_session] = True
            msg_id = self.pending_events[stop_event_id]["message_id"]
            self.tg.edit_message(msg_id, f"▶️ Continuing: <i>{escape_html(text[:200])}</i>")
            del self.pending_events[stop_event_id]
            self.tg.send_message(f"📨 Sent to Agent", thread_id=msg_thread_id)
            self._increment_interaction(target_session)
        else:
            # MESSAGE BUFFER: Claude is busy, queue the instruction
            queued_path = ipc_session_dir / "queued_instruction.json"
            existing_instruction = ""
            if queued_path.exists():
                try:
                    with open(queued_path, "r") as f:
                        data = json.load(f)
                        existing_instruction = data.get("instruction", "") + " "
                except Exception:
                    pass

            final_instruction = existing_instruction + text
            try:
                with open(queued_path, "w") as f:
                    json.dump({"instruction": final_instruction, "timestamp": time.time()}, f)
                self.tg.send_message(f"📥 Queued instruction (agent busy).", thread_id=msg_thread_id)
                self._increment_interaction(target_session)
            except OSError:
                pass

    def _write_response(self, ipc_dir, event_id, response):
        response_path = ipc_dir / f"response-{event_id}.json"
        try:
            with open(response_path, "w") as f:
                json.dump(response, f)
        except OSError as e:
            log.error("Failed to write response %s: %s", response_path, e)

    def _kill_session(self, session_id, reason="topic deleted"):
        """Write kill file, delete topic, and clean up session state."""
        ipc_session_dir = IPC_DIR / session_id
        kill_path = ipc_session_dir / "kill"
        try:
            with open(kill_path, "w") as f:
                f.write(reason)
            log.info(f"[KILL] Wrote kill file for session {session_id[:8]}: {reason}")
        except OSError as e:
            log.error(f"[KILL] Failed to write kill file: {e}")

        # Delete the forum topic
        topic_id = self.session_threads.get(session_id)
        if topic_id:
            log.info(f"[KILL] Deleting topic {topic_id} for session {session_id[:8]}")
            self.tg.delete_forum_topic(topic_id)

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

    def _send_to_session(self, text, session_id, reply_markup=None):
        """Send message to session's thread, handling deleted topics."""
        thread_id = self.session_threads.get(session_id)
        result = self.tg.send_message(text, thread_id=thread_id, reply_markup=reply_markup)

        if result and result.get("topic_deleted"):
            log.warning(f"[ZOMBIE] Topic deleted for session {session_id[:8]}, killing")
            self._kill_session(session_id, "topic deleted by user")
            return None

        return result

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
                    continue
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
                    continue

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


if __name__ == "__main__":
    config = load_config()
    if not config.get("bot_token") or not config.get("chat_id"):
        print("Bot not configured.", file=sys.stderr)
        sys.exit(1)

    daemon = BridgeDaemon()
    daemon.run()
