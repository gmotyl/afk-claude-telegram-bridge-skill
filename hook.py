#!/usr/bin/env python3
"""
telegram-bridge hook.py — Hook logic for Claude Code ↔ Telegram bridge.

Modes:
  activate   — Claim a slot, create IPC dir, start daemon, notify Telegram
  deactivate — Release slot, remove IPC dir, stop daemon if last session
  status     — Show active AFK sessions
  setup      — Interactive bot token + chat_id configuration
  hook       — Process hook events (stdin JSON) with IPC to bridge daemon
"""

import fcntl
import json
import logging
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [hook] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
    filename=os.path.expanduser("~/.claude/hooks/telegram-bridge/hook.log"),
)
log = logging.getLogger("hook")

BRIDGE_DIR = os.path.expanduser("~/.claude/hooks/telegram-bridge")
CONFIG_PATH = os.path.join(BRIDGE_DIR, "config.json")
STATE_PATH = os.path.join(BRIDGE_DIR, "state.json")
IPC_DIR = os.path.join(BRIDGE_DIR, "ipc")
BRIDGE_PY = os.path.join(BRIDGE_DIR, "bridge.py")
LOCK_PATH = os.path.join(BRIDGE_DIR, ".state.lock")


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
        return {"slots": {}, "daemon_pid": None, "daemon_heartbeat": None}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def locked_state_op(fn):
    """Execute fn(state) with an exclusive file lock on state.json."""
    os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
    lock_fd = open(LOCK_PATH, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        state = load_state()
        result = fn(state)
        save_state(state)
        return result
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()


def is_daemon_alive(state):
    pid = state.get("daemon_pid")
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def start_daemon():
    """Start the bridge daemon as a detached background process."""
    log_path = os.path.join(BRIDGE_DIR, "daemon.log")
    log_fd = open(log_path, "a")
    proc = subprocess.Popen(
        [sys.executable, BRIDGE_PY],
        stdout=log_fd,
        stderr=log_fd,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        cwd=BRIDGE_DIR,
    )
    log_fd.close()
    return proc.pid


def stop_daemon(state):
    pid = state.get("daemon_pid")
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    state["daemon_pid"] = None
    state["daemon_heartbeat"] = None


# ─── Setup ───────────────────────────────────────────────────────────────────

def cmd_setup():
    config = load_config()

    print("╔══════════════════════════════════════════════╗")
    print("║   Telegram Bridge Setup — Smart Config      ║")
    print("╚══════════════════════════════════════════════╝")
    print()

    # ─── Step 1: Bot Token ───────────────────────────────────────────────────
    print("📝 STEP 1: Bot Token")
    print()
    print("  1. Open Telegram → search @BotFather → /newbot")
    print('  2. Name it "Claude Bridge" (or your preferred name)')
    print("  3. Copy the token that @BotFather provides")
    print()

    if config.get("bot_token"):
        print(f"Current bot token: ...{config['bot_token'][-8:]}")
        skip = input("Keep this token? [Y/n]: ").strip().lower()
        if skip != 'n':
            token = config["bot_token"]
        else:
            token = input("Enter bot token (from @BotFather): ").strip()
    else:
        token = input("Enter bot token (from @BotFather): ").strip()

    if not token:
        print("❌ Setup cancelled.")
        return

    config["bot_token"] = token

    # ─── Step 2: Add Bot to Group ─────────────────────────────────────────────
    print()
    print("📱 STEP 2: Add Bot to Group")
    print()
    print("  1. Create a Telegram GROUP (not private chat)")
    print("  2. ADD YOUR BOT to the group (@BotFather gave you a link)")
    print("  3. Make the bot an ADMIN in the group")
    print("  4. Enable TOPICS in the group:")
    print("     • Group settings → Topics (✓ Turn on)")
    print("  5. Send ANY MESSAGE in the group")
    print()
    input("Press Enter when done...")

    # ─── Step 3: Fetch Available Chats ────────────────────────────────────────
    print()
    print("🔍 STEP 3: Finding your chats...")
    chats = _fetch_available_chats(token)

    if not chats:
        print()
        print("❌ No chats found. Make sure you:")
        print("   • Sent a message in the group where the bot is an admin")
        print("   • Enabled TOPICS in the group")
        print("   • Waited a moment for the message to process")
        print()
        print("Manual setup:")
        print(f"   Visit: https://api.telegram.org/bot{token}/getUpdates")
        print("   Look for 'chat': {'id': <YOUR_CHAT_ID>}")
        manual_id = input("Enter chat ID manually (or press Enter to cancel): ").strip()
        if manual_id:
            config["chat_id"] = manual_id
            with open(CONFIG_PATH, "w") as f:
                json.dump(config, f, indent=2)
            print()
            print("✓ Config saved (manual mode)")
        return

    # ─── Step 4: Select Chat ──────────────────────────────────────────────────
    print()
    print("✓ Found available chats:")
    print()
    chat_list = sorted(chats.items())
    for idx, (chat_id, info) in enumerate(chat_list, 1):
        chat_type_emoji = "👥" if info["type"] == "group" else "👤"
        print(f"  {idx}. {chat_type_emoji} {info['title']} (ID: {chat_id})")

    print()
    while True:
        try:
            choice = input("Select chat (enter number): ").strip()
            idx = int(choice) - 1
            if 0 <= idx < len(chat_list):
                selected_chat_id, selected_info = chat_list[idx]
                break
            else:
                print("❌ Invalid selection. Try again.")
        except ValueError:
            print("❌ Please enter a valid number.")

    config["chat_id"] = selected_chat_id

    # ─── Step 5: Save Config ──────────────────────────────────────────────────
    print()
    print("💾 STEP 4: Saving configuration...")
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2)

    # ─── Step 6: Show Final Config ─────────────────────────────────────────────
    print()
    print("╔══════════════════════════════════════════════╗")
    print("║   ✓ Setup Complete!                         ║")
    print("╚══════════════════════════════════════════════╝")
    print()
    print("Configuration:")
    print(f"  Bot Token:  ...{token[-8:]}")
    print(f"  Chat:       {selected_info['title']} ({selected_chat_id})")
    print(f"  Config:     {CONFIG_PATH}")
    print()
    print("Ready to use! Next steps:")
    print("  1. Copy hook files to ~/.claude/hooks/telegram-bridge/")
    print("  2. Run: /afk (to activate the bridge)")
    print("  3. Approve requests on Telegram!")
    print()


def _fetch_available_chats(token):
    """Fetch all chats that have sent messages to this bot."""
    chats = {}
    try:
        url = f"https://api.telegram.org/bot{token}/getUpdates"
        with urllib.request.urlopen(url, timeout=5) as response:
            data = json.loads(response.read().decode())
            if data.get("ok") and data.get("result"):
                # Collect all unique chats from messages
                for update in data.get("result", []):
                    msg = update.get("message", {})
                    if msg.get("chat"):
                        chat = msg["chat"]
                        chat_id = str(chat.get("id"))
                        chat_title = chat.get("title") or chat.get("first_name", "Unknown")
                        chat_type = chat.get("type", "private")
                        if chat_id not in chats:
                            chats[chat_id] = {
                                "title": chat_title,
                                "type": chat_type,
                            }
    except (urllib.error.URLError, json.JSONDecodeError, Exception) as e:
        pass
    return chats


# ─── Status ──────────────────────────────────────────────────────────────────

def cmd_status():
    state = load_state()
    config = load_config()
    slots = state.get("slots", {})

    configured = bool(config.get("bot_token") and config.get("chat_id"))
    daemon_alive = is_daemon_alive(state)

    print(f"Telegram Bridge Status")
    print(f"  Bot configured: {'yes' if configured else 'no — run hook.sh --setup'}")
    print(f"  Daemon: {'running (PID ' + str(state.get('daemon_pid')) + ')' if daemon_alive else 'stopped'}")
    print()

    if not slots:
        print("  No active AFK sessions.")
    else:
        for slot_num, info in sorted(slots.items(), key=lambda x: x[0]):
            sid = info.get("session_id", "?")
            project = info.get("project", "?")
            started = info.get("started", "?")
            print(f"  S{slot_num}: {project} (session: ...{sid[-8:]}, since: {started})")


# ─── Activate ────────────────────────────────────────────────────────────────

def cmd_activate(session_id, project):
    config = load_config()

    # Check bot is configured
    if not config.get("bot_token") or not config.get("chat_id"):
        print("Telegram bot not configured yet.")
        print()
        print("Setup steps:")
        print("  1. Open Telegram → search @BotFather → /newbot")
        print('  2. Name it "Claude Bridge" → copy the token')
        print("  3. Send any message to your new bot")
        print("  4. Visit: https://api.telegram.org/bot<TOKEN>/getUpdates")
        print("  5. Copy the chat_id from the response")
        print("  6. Run: ~/.claude/hooks/telegram-bridge/hook.sh --setup")
        sys.exit(1)

    max_slots = config.get("max_slots", 4)

    def do_activate(state):
        slots = state.setdefault("slots", {})

        # Check if already active
        for slot_num, info in slots.items():
            if info.get("session_id") == session_id:
                print(f"Session already active in slot S{slot_num}")
                return slot_num

        # Find next available slot
        assigned_slot = None
        for i in range(1, max_slots + 1):
            s = str(i)
            if s not in slots:
                assigned_slot = s
                break

        if assigned_slot is None:
            print(f"All {max_slots} slots are occupied:")
            for sn, info in sorted(slots.items()):
                print(f"  S{sn}: {info.get('project', '?')} (...{info.get('session_id', '?')[-8:]})")
            print("\nRun /back in one of those sessions first.")
            sys.exit(1)

        # Claim slot
        slots[assigned_slot] = {
            "session_id": session_id,
            "project": project or "unknown",
            "started": time.strftime("%Y-%m-%d %H:%M:%S"),
        }

        # Create IPC directory
        ipc_session_dir = os.path.join(IPC_DIR, session_id)
        os.makedirs(ipc_session_dir, exist_ok=True)
        with open(os.path.join(ipc_session_dir, "meta.json"), "w") as f:
            json.dump({
                "session_id": session_id,
                "slot": assigned_slot,
                "project": project or "unknown",
                "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }, f, indent=2)

        # Start daemon if not running
        if not is_daemon_alive(state):
            pid = start_daemon()
            state["daemon_pid"] = pid
            state["daemon_heartbeat"] = time.time()

        # Write activation event for daemon to pick up
        event_file = os.path.join(ipc_session_dir, "events.jsonl")
        event = {
            "id": str(uuid.uuid4())[:8],
            "type": "activation",
            "slot": assigned_slot,
            "project": project or "unknown",
            "session_id": session_id,
            "timestamp": time.time(),
        }
        with open(event_file, "a") as f:
            f.write(json.dumps(event) + "\n")

        print(f"AFK mode activated — slot S{assigned_slot}")
        print(f"Telegram bridge is watching this session.")
        return assigned_slot

    locked_state_op(do_activate)


# ─── Deactivate ──────────────────────────────────────────────────────────────

def cmd_deactivate(session_id):
    def do_deactivate(state):
        slots = state.setdefault("slots", {})

        # Find and remove this session's slot (handle both temp and real session_ids)
        removed_slot = None
        actual_session_id = session_id  # May be remapped to real id

        for slot_num, info in list(slots.items()):
            if info.get("session_id") == session_id:
                removed_slot = slot_num
                actual_session_id = session_id
                del slots[slot_num]
                break

        if removed_slot is None:
            # Try to find any slot that's currently active
            # (user might have called /back with wrong session_id)
            if slots:
                # Deactivate the first (or any) active session
                for slot_num, info in list(slots.items()):
                    removed_slot = slot_num
                    actual_session_id = info.get("session_id", session_id)
                    del slots[slot_num]
                    break

        if removed_slot is None:
            print("No active AFK sessions found.")
            return

        # Write deactivation event before removing IPC dir
        ipc_session_dir = os.path.join(IPC_DIR, actual_session_id)
        if os.path.isdir(ipc_session_dir):
            event_file = os.path.join(ipc_session_dir, "events.jsonl")
            event = {
                "id": str(uuid.uuid4())[:8],
                "type": "deactivation",
                "slot": removed_slot,
                "session_id": actual_session_id,
                "timestamp": time.time(),
            }
            with open(event_file, "a") as f:
                f.write(json.dumps(event) + "\n")
            # Give daemon a moment to pick up the event
            time.sleep(0.5)
            # Clean up IPC dir
            import shutil
            shutil.rmtree(ipc_session_dir, ignore_errors=True)

        # Stop daemon if no sessions remain
        if not slots:
            stop_daemon(state)

        print(f"AFK mode deactivated — slot S{removed_slot} released.")

    locked_state_op(do_deactivate)


# ─── Hook Mode ───────────────────────────────────────────────────────────────

def cmd_hook():
    event_data = json.load(sys.stdin)
    session_id = event_data.get("session_id", "")
    hook_event = event_data.get("hook_event_name", "")

    if not session_id:
        sys.exit(0)

    ipc_session_dir = os.path.join(IPC_DIR, session_id)

    # If exact session_id dir doesn't exist, check for single active AFK session (single-session mode)
    if not os.path.isdir(ipc_session_dir):
        try:
            active_sessions = [d for d in os.listdir(IPC_DIR) if os.path.isdir(os.path.join(IPC_DIR, d))]
            if len(active_sessions) == 1:
                # Single session mode: use whatever session is active, regardless of session_id
                ipc_session_dir = os.path.join(IPC_DIR, active_sessions[0])
                log.info(f"[SINGLE-SESSION MODE] Using active session {active_sessions[0]} for hook event {hook_event}")
            else:
                # Multiple sessions or none — not in AFK mode
                log.debug(f"Not in AFK mode: {len(active_sessions)} active sessions")
                sys.exit(0)
        except Exception as e:
            log.error(f"Error checking active sessions: {e}")
            sys.exit(0)

    if not os.path.isdir(ipc_session_dir):
        # Still no AFK session
        sys.exit(0)

    config = load_config()
    auto_approve = set(config.get("auto_approve_tools", []))

    # ── PermissionRequest ──
    if hook_event == "PermissionRequest":
        tool_name = event_data.get("tool_name", "")

        # Auto-approve read-only tools
        if tool_name in auto_approve:
            result = {
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "allow",
                    },
                },
            }
            json.dump(result, sys.stdout)
            sys.exit(0)

        # Write event for Telegram approval
        event_id = str(uuid.uuid4())[:8]
        tool_input = event_data.get("tool_input", {})

        # Build a human-readable description of the tool call
        description = _format_tool_description(tool_name, tool_input)

        event = {
            "id": event_id,
            "type": "permission_request",
            "tool_name": tool_name,
            "tool_input": tool_input,
            "description": description,
            "session_id": session_id,
            "timestamp": time.time(),
        }
        event_file = os.path.join(ipc_session_dir, "events.jsonl")
        try:
            with open(event_file, "a") as f:
                f.write(json.dumps(event) + "\n")
            log.info(f"[PERMISSION] Wrote event {event_id} for {tool_name} to {event_file}")
        except Exception as e:
            log.error(f"[PERMISSION] Failed to write event: {e}", exc_info=True)

        # Poll for response
        timeout = config.get("permission_timeout", 300)
        response = _poll_response(ipc_session_dir, event_id, timeout)

        if response:
            decision = response.get("decision", "deny")
            if decision == "allow":
                result = {
                    "hookSpecificOutput": {
                        "hookEventName": "PermissionRequest",
                        "decision": {"behavior": "allow"},
                    },
                }
            else:
                msg = response.get("message", "Denied via Telegram")
                result = {
                    "hookSpecificOutput": {
                        "hookEventName": "PermissionRequest",
                        "decision": {
                            "behavior": "deny",
                            "message": msg,
                        },
                    },
                }
        else:
            # Timeout — deny by default
            result = {
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "deny",
                        "message": "Telegram approval timed out",
                    },
                },
            }

        json.dump(result, sys.stdout)
        sys.exit(0)

    # ── Stop ──
    elif hook_event == "Stop":
        # Prevent infinite loop: if stop_hook_active, let Claude stop
        if event_data.get("stop_hook_active", False):
            sys.exit(0)

        event_id = str(uuid.uuid4())[:8]
        last_msg = event_data.get("last_assistant_message", "")
        # Truncate for Telegram (max ~4000 chars)
        if len(last_msg) > 800:
            last_msg = last_msg[:800] + "..."

        event = {
            "id": event_id,
            "type": "stop",
            "last_message": last_msg,
            "session_id": session_id,
            "timestamp": time.time(),
        }
        event_file = os.path.join(ipc_session_dir, "events.jsonl")
        with open(event_file, "a") as f:
            f.write(json.dumps(event) + "\n")

        # Poll for Greg's next instruction
        timeout = config.get("stop_timeout", 600)
        response = _poll_response(ipc_session_dir, event_id, timeout)

        if response and response.get("instruction"):
            # Block the stop and inject Greg's instruction
            result = {
                "decision": "block",
                "reason": response["instruction"],
            }
            json.dump(result, sys.stdout)
            sys.exit(0)
        else:
            # Timeout or no instruction — let Claude stop
            sys.exit(0)

    # ── Notification ──
    elif hook_event == "Notification":
        event_id = str(uuid.uuid4())[:8]
        event = {
            "id": event_id,
            "type": "notification",
            "notification_type": event_data.get("notification_type", ""),
            "message": event_data.get("message", ""),
            "title": event_data.get("title", ""),
            "session_id": session_id,
            "timestamp": time.time(),
        }
        event_file = os.path.join(ipc_session_dir, "events.jsonl")
        with open(event_file, "a") as f:
            f.write(json.dumps(event) + "\n")
        # Non-blocking — exit immediately
        sys.exit(0)

    # ── Other events (SessionStart, UserPromptSubmit) — pass through ──
    else:
        sys.exit(0)


def _format_tool_description(tool_name, tool_input):
    """Create a concise human-readable description for Telegram."""
    if tool_name == "Bash":
        cmd = tool_input.get("command", "")
        desc = tool_input.get("description", "")
        if desc:
            return f"Bash: {desc}\n`{cmd[:200]}`"
        return f"Bash: `{cmd[:300]}`"
    elif tool_name == "Write":
        path = tool_input.get("file_path", "?")
        return f"Write: {path}"
    elif tool_name == "Edit":
        path = tool_input.get("file_path", "?")
        old = (tool_input.get("old_string", ""))[:80]
        return f"Edit: {path}\n`{old}...`"
    elif tool_name == "NotebookEdit":
        path = tool_input.get("notebook_path", "?")
        return f"NotebookEdit: {path}"
    else:
        # Generic: show tool name and first key-value
        parts = [f"{tool_name}:"]
        for k, v in list(tool_input.items())[:2]:
            sv = str(v)[:100]
            parts.append(f"  {k}: {sv}")
        return "\n".join(parts)


def _poll_response(ipc_dir, event_id, timeout):
    """Poll for a response file written by the daemon. Returns dict or None."""
    response_path = os.path.join(ipc_dir, f"response-{event_id}.json")
    deadline = time.time() + timeout
    interval = 0.5

    while time.time() < deadline:
        if os.path.exists(response_path):
            try:
                with open(response_path) as f:
                    data = json.load(f)
                os.remove(response_path)
                return data
            except (json.JSONDecodeError, OSError):
                pass
        time.sleep(interval)
        # Gradually increase poll interval (0.5s → 1s → 2s)
        if interval < 2.0:
            interval = min(interval * 1.2, 2.0)

    return None


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: hook.py <activate|deactivate|status|setup|hook>", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "activate":
        session_id = sys.argv[2] if len(sys.argv) > 2 else ""
        project = sys.argv[3] if len(sys.argv) > 3 else ""
        cmd_activate(session_id, project)
    elif cmd == "deactivate":
        session_id = sys.argv[2] if len(sys.argv) > 2 else ""
        cmd_deactivate(session_id)
    elif cmd == "status":
        cmd_status()
    elif cmd == "setup":
        cmd_setup()
    elif cmd == "hook":
        cmd_hook()
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)
