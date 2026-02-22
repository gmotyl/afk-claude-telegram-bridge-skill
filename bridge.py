#!/usr/bin/env python3
"""
telegram-bridge bridge.py — Telegram long-polling daemon.

Watches ipc/{session_id}/events.jsonl for new events from hooks,
sends formatted messages to Telegram with inline keyboards,
handles callback queries and text messages, writes response files.

Self-terminates when the last session deactivates.
Uses only Python stdlib (urllib.request, json).
"""

import json
import logging
import os
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BRIDGE_DIR = Path.home() / ".claude" / "hooks" / "telegram-bridge"
CONFIG_PATH = BRIDGE_DIR / "config.json"
STATE_PATH = BRIDGE_DIR / "state.json"
IPC_DIR = BRIDGE_DIR / "ipc"

HEARTBEAT_INTERVAL = 30  # seconds
POLL_TIMEOUT = 30  # Telegram long-poll timeout
EVENT_SCAN_INTERVAL = 0.5  # seconds between IPC scans

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [bridge] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("bridge")

# ─── Telegram API ────────────────────────────────────────────────────────────


class TelegramAPI:
    """Minimal Telegram Bot API client using urllib."""

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

    def send_message(self, text, reply_markup=None, parse_mode="HTML"):
        data = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": parse_mode,
        }
        if reply_markup:
            data["reply_markup"] = reply_markup
        return self._request("sendMessage", data)

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
    """Return dict of session_id → slot_num for all active sessions."""
    sessions = {}
    for slot_num, info in state.get("slots", {}).items():
        sid = info.get("session_id")
        if sid:
            sessions[sid] = slot_num
    return sessions


# ─── Message formatting ─────────────────────────────────────────────────────


def escape_html(text):
    """Escape HTML special chars for Telegram HTML parse mode."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def format_permission_message(event, slot):
    tool = event.get("tool_name", "?")
    desc = event.get("description", "")
    desc_escaped = escape_html(desc)

    return (
        f"🔐 <b>S{slot} — Permission Request</b>\n\n"
        f"<b>Tool:</b> {escape_html(tool)}\n"
        f"<pre>{desc_escaped}</pre>"
    )


def format_stop_message(event, slot):
    project = event.get("project", "")
    last_msg = event.get("last_message", "")
    if last_msg:
        last_msg = escape_html(last_msg)
        if len(last_msg) > 600:
            last_msg = last_msg[:600] + "..."
    return (
        f"✅ <b>S{slot} — Task Complete</b>\n\n"
        f"{last_msg}\n\n"
        f"<i>Reply with next instruction or let it timeout to stop.</i>"
    )


def format_notification_message(event, slot):
    ntype = event.get("notification_type", "")
    msg = escape_html(event.get("message", ""))
    title = escape_html(event.get("title", ""))

    emoji = {"permission_prompt": "🔔", "idle_prompt": "💤"}.get(ntype, "📢")
    return f"{emoji} <b>S{slot}</b> — {title}\n{msg}"


def format_activation_message(event):
    slot = event.get("slot", "?")
    project = event.get("project", "unknown")
    return f"📡 <b>S{slot} — AFK Activated</b>\nProject: {escape_html(project)}"


def format_deactivation_message(event):
    slot = event.get("slot", "?")
    return f"👋 <b>S{slot} — AFK Deactivated</b>"


def permission_keyboard(event_id):
    return {
        "inline_keyboard": [
            [
                {"text": "✅ Approve", "callback_data": f"allow:{event_id}"},
                {"text": "❌ Deny", "callback_data": f"deny:{event_id}"},
            ]
        ]
    }


def stop_keyboard(event_id):
    return {
        "inline_keyboard": [
            [
                {"text": "🛑 Let it stop", "callback_data": f"stop:{event_id}"},
            ]
        ]
    }


# ─── Daemon ──────────────────────────────────────────────────────────────────


class BridgeDaemon:
    def __init__(self):
        self.config = load_config()
        self.tg = TelegramAPI(self.config["bot_token"], self.config["chat_id"])
        self.running = True
        # Track file positions for each session's events.jsonl
        self.event_positions = {}
        # Map event_id → {session_id, type, message_id (telegram)}
        self.pending_events = {}
        # Map slot → session_id for text routing
        self.slot_sessions = {}
        # "Active reply target" — last session that sent a stop event
        self.reply_target_session = None

        signal.signal(signal.SIGTERM, self._handle_sigterm)
        signal.signal(signal.SIGINT, self._handle_sigterm)

    def _handle_sigterm(self, signum, frame):
        log.info("Received signal %d, shutting down", signum)
        self.running = False

    def run(self):
        log.info("Bridge daemon starting")

        # Flush any pending Telegram updates (skip old messages)
        self.tg.get_updates(timeout=0)

        last_heartbeat = 0
        last_event_scan = 0

        while self.running:
            now = time.time()

            # Heartbeat
            if now - last_heartbeat > HEARTBEAT_INTERVAL:
                self._heartbeat()
                last_heartbeat = now

            # Scan IPC events
            if now - last_event_scan > EVENT_SCAN_INTERVAL:
                self._scan_events()
                last_event_scan = now

            # Poll Telegram (this blocks for up to POLL_TIMEOUT seconds)
            try:
                updates = self.tg.get_updates(timeout=2)
                for update in updates:
                    self._handle_update(update)
            except Exception as e:
                log.error("Error polling Telegram: %s", e)
                time.sleep(2)

            # Check if any sessions still active
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
        except Exception as e:
            log.warning("Heartbeat failed: %s", e)

    def _scan_events(self):
        """Read new events from all active sessions' events.jsonl files."""
        if not IPC_DIR.exists():
            return

        state = load_state()
        active = get_active_sessions(state)

        # Update slot_sessions mapping
        self.slot_sessions = {}
        for sid, slot in active.items():
            self.slot_sessions[slot] = sid

        for session_id, slot in active.items():
            event_file = IPC_DIR / session_id / "events.jsonl"
            if not event_file.exists():
                continue

            # Read from last known position
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
                    log.warning("Invalid JSON in events: %s", line[:100])

    def _process_event(self, event, session_id, slot):
        etype = event.get("type", "")
        event_id = event.get("id", "")

        if etype == "activation":
            text = format_activation_message(event)
            self.tg.send_message(text)

        elif etype == "deactivation":
            text = format_deactivation_message(event)
            self.tg.send_message(text)

        elif etype == "permission_request":
            text = format_permission_message(event, slot)
            kb = permission_keyboard(event_id)
            result = self.tg.send_message(text, reply_markup=kb)
            if result and result.get("ok"):
                msg_id = result["result"]["message_id"]
                self.pending_events[event_id] = {
                    "session_id": session_id,
                    "type": "permission_request",
                    "message_id": msg_id,
                    "slot": slot,
                }

        elif etype == "stop":
            text = format_stop_message(event, slot)
            kb = stop_keyboard(event_id)
            result = self.tg.send_message(text, reply_markup=kb)
            if result and result.get("ok"):
                msg_id = result["result"]["message_id"]
                self.pending_events[event_id] = {
                    "session_id": session_id,
                    "type": "stop",
                    "message_id": msg_id,
                    "slot": slot,
                }
            self.reply_target_session = session_id

        elif etype == "notification":
            text = format_notification_message(event, slot)
            self.tg.send_message(text)

    def _handle_update(self, update):
        """Handle a Telegram update (callback query or text message)."""
        if "callback_query" in update:
            self._handle_callback(update["callback_query"])
        elif "message" in update:
            self._handle_message(update["message"])

    def _handle_callback(self, cq):
        """Handle inline keyboard button press."""
        data = cq.get("data", "")
        cq_id = cq.get("id", "")

        if ":" not in data:
            self.tg.answer_callback(cq_id, "Unknown action")
            return

        action, event_id = data.split(":", 1)
        pending = self.pending_events.get(event_id)

        if not pending:
            self.tg.answer_callback(cq_id, "Event expired")
            return

        session_id = pending["session_id"]
        msg_id = pending["message_id"]
        slot = pending["slot"]
        ipc_session_dir = IPC_DIR / session_id

        if action == "allow":
            # Write allow response
            response = {"decision": "allow"}
            self._write_response(ipc_session_dir, event_id, response)
            self.tg.answer_callback(cq_id, "Approved")
            self.tg.edit_message(msg_id, f"✅ <b>S{slot}</b> — Approved")
            del self.pending_events[event_id]

        elif action == "deny":
            response = {"decision": "deny", "message": "Denied via Telegram"}
            self._write_response(ipc_session_dir, event_id, response)
            self.tg.answer_callback(cq_id, "Denied")
            self.tg.edit_message(msg_id, f"❌ <b>S{slot}</b> — Denied")
            del self.pending_events[event_id]

        elif action == "stop":
            # Let it stop (write empty response so poll times out or stops cleanly)
            response = {"instruction": ""}
            self._write_response(ipc_session_dir, event_id, response)
            self.tg.answer_callback(cq_id, "Stopping")
            self.tg.edit_message(msg_id, f"🛑 <b>S{slot}</b> — Stopped")
            del self.pending_events[event_id]
            if self.reply_target_session == session_id:
                self.reply_target_session = None

    def _handle_message(self, msg):
        """Handle text message from Greg — route to correct session."""
        text = msg.get("text", "").strip()
        chat_id = str(msg.get("chat", {}).get("id", ""))

        # Only accept messages from configured chat
        if chat_id != self.tg.chat_id:
            return

        if not text:
            return

        # Check for explicit session targeting: "S1: do something"
        target_session = None
        instruction = text

        if len(text) > 2 and text[0].upper() == "S" and text[1].isdigit():
            # Parse "S1: instruction" or "S1 instruction"
            slot_char = text[1]
            rest = text[2:].lstrip(": ")
            if rest:
                target_session = self.slot_sessions.get(slot_char)
                instruction = rest

        # If no explicit target, use the last stop event session
        if not target_session and self.reply_target_session:
            target_session = self.reply_target_session

        # If still no target, use the only active session (if there's just one)
        if not target_session:
            state = load_state()
            active = get_active_sessions(state)
            if len(active) == 1:
                target_session = list(active.keys())[0]
            else:
                # Ambiguous — ask user to specify
                slots_info = []
                for sid, slot in active.items():
                    slots_info.append(f"S{slot}")
                self.tg.send_message(
                    f"Which session? Reply with: <b>S1:</b> your instruction\n"
                    f"Active: {', '.join(slots_info)}"
                )
                return

        if not target_session:
            self.tg.send_message("No active AFK sessions.")
            return

        # Find pending stop event for this session and write instruction
        stop_event_id = None
        for eid, info in self.pending_events.items():
            if info["session_id"] == target_session and info["type"] == "stop":
                stop_event_id = eid
                break

        ipc_session_dir = IPC_DIR / target_session

        if stop_event_id:
            # Respond to the stop event with Greg's instruction
            response = {"instruction": instruction}
            self._write_response(ipc_session_dir, stop_event_id, response)

            slot = self.pending_events[stop_event_id]["slot"]
            msg_id = self.pending_events[stop_event_id]["message_id"]
            self.tg.edit_message(
                msg_id,
                f"▶️ <b>S{slot}</b> — Continuing:\n<i>{escape_html(instruction[:200])}</i>",
            )
            del self.pending_events[stop_event_id]
            if self.reply_target_session == target_session:
                self.reply_target_session = None

            slot_num = get_slot_for_session(load_state(), target_session)
            self.tg.send_message(f"📨 Sent to S{slot_num or '?'}")
        else:
            # No pending stop — queue instruction as a generic event
            # The session will pick it up on next stop
            self.tg.send_message(
                "⏳ No pending stop event for that session. "
                "Instruction will be sent when the task completes."
            )
            # Write a queued instruction file
            queued_path = ipc_session_dir / "queued_instruction.json"
            try:
                with open(queued_path, "w") as f:
                    json.dump({"instruction": instruction, "timestamp": time.time()}, f)
            except OSError:
                pass

    def _write_response(self, ipc_dir, event_id, response):
        response_path = ipc_dir / f"response-{event_id}.json"
        try:
            with open(response_path, "w") as f:
                json.dump(response, f)
        except OSError as e:
            log.error("Failed to write response %s: %s", response_path, e)


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    config = load_config()
    if not config.get("bot_token") or not config.get("chat_id"):
        print("Bot not configured. Run: hook.sh --setup", file=sys.stderr)
        sys.exit(1)

    daemon = BridgeDaemon()
    daemon.run()
