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
import shutil
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


def is_slot_actually_active(state, slot_num, current_time=None):
    """
    Validate that a slot has an active, living session.

    A slot is considered ACTIVE if:
    - IPC directory exists
    - meta.json exists (proof of initialization)
    - No kill file present (daemon didn't intentionally terminate)
    - Daemon is alive OR heartbeat is recent (<60s)

    Returns: (is_active: bool, reason: str or None)
    reason is provided only if is_active is False
    """
    if current_time is None:
        current_time = time.time()

    if slot_num not in state.get("slots", {}):
        return False, "slot_not_in_state"

    info = state["slots"][slot_num]
    session_id = info.get("session_id")

    if not session_id:
        return False, "session_id_missing"

    ipc_session_dir = os.path.join(IPC_DIR, session_id)

    # Check if IPC directory exists
    if not os.path.isdir(ipc_session_dir):
        return False, "ipc_dir_missing"

    # Check if meta.json exists (proof of successful initialization)
    meta_path = os.path.join(ipc_session_dir, "meta.json")
    if not os.path.isfile(meta_path):
        return False, "meta_missing"

    # Check if kill file exists (daemon intentionally terminated this session)
    kill_file = os.path.join(ipc_session_dir, "kill")
    if os.path.exists(kill_file):
        return False, "kill_file_present"

    # Check daemon liveness
    daemon_alive = is_daemon_alive(state)
    if daemon_alive:
        return True, None

    # Daemon is not alive; check heartbeat freshness
    daemon_heartbeat = state.get("daemon_heartbeat", 0)
    heartbeat_age = current_time - daemon_heartbeat

    # If heartbeat is fresh (<60s), daemon might still be initializing
    if heartbeat_age < 60:
        return True, None

    # Both daemon dead and heartbeat stale
    return False, "daemon_dead"


def cleanup_stale_slots(state, preserve_ipc_dirs=False, verbose=False):
    """
    Remove stale slots from state.json and optionally clean IPC directories.

    Returns: List of (slot_num, session_id, reason) tuples for cleaned slots
    """
    cleaned = []
    # Ensure slots dict exists in state
    if "slots" not in state:
        state["slots"] = {}
    slots = state["slots"]

    for slot_num in list(slots.keys()):
        is_active, reason = is_slot_actually_active(state, slot_num)

        if not is_active:
            session_id = slots[slot_num].get("session_id", "unknown")
            cleaned.append((slot_num, session_id, reason))

            if verbose:
                log.info(f"Cleaning stale slot S{slot_num} "
                        f"(session: {session_id[:8]}..., reason: {reason})")

            # Optionally remove IPC directory
            if not preserve_ipc_dirs:
                ipc_session_dir = os.path.join(IPC_DIR, session_id)
                if os.path.isdir(ipc_session_dir):
                    try:
                        shutil.rmtree(ipc_session_dir)
                        if verbose:
                            log.info(f"Removed IPC directory for S{slot_num}")
                    except Exception as e:
                        log.warning(f"Failed to remove IPC dir for S{slot_num}: {e}")

            # Remove from state
            del slots[slot_num]

    return cleaned


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


def check_pending_telegram_instructions():
    """
    Actively check for pending Telegram instructions and display them.
    This runs continuously to enable real-time AFK mode.
    """
    try:
        state = load_state()
        slots = state.get("slots", {})

        if not slots:
            return

        # Check first active session
        for slot_num, info in slots.items():
            session_id = info.get("session_id")
            if not session_id:
                continue

            ipc_dir = os.path.join(IPC_DIR, session_id)
            instruction_file = os.path.join(ipc_dir, "queued_instruction.json")

            if os.path.isfile(instruction_file):
                try:
                    with open(instruction_file) as f:
                        data = json.load(f)
                    instruction = data.get("instruction", "").strip()

                    if instruction:
                        # Display to user
                        print(f"\n📱 **Telegram Instruction:**\n```\n{instruction}\n```\n")

                        # Clear instruction
                        try:
                            os.remove(instruction_file)
                            log.info(f"[TELEGRAM] Delivered instruction from session {session_id[:8]}")
                        except:
                            pass
                        return True
                except:
                    pass
    except:
        pass

    return False


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
    print("🔍 STEP 3: Finding your admin groups...")
    all_chats = _fetch_available_chats(token)

    # Filter to only groups (where bot should be admin)
    admin_groups = {
        cid: info for cid, info in all_chats.items()
        if info["type"] == "group"
    }

    if not admin_groups:
        print()
        print("❌ No groups found. Make sure you:")
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

    # Auto-select if only one group, otherwise ask user
    chat_list = sorted(admin_groups.items())

    if len(chat_list) == 1:
        # Auto-use the only admin group
        selected_chat_id, selected_info = chat_list[0]
        print()
        print(f"✓ Found your admin group: {selected_info['title']}")
        print(f"  Using: {selected_chat_id}")
    else:
        # Multiple groups — let user choose
        print()
        print("✓ Found available admin groups:")
        print()
        for idx, (chat_id, info) in enumerate(chat_list, 1):
            print(f"  {idx}. 👥 {info['title']} (ID: {chat_id})")

        print()
        while True:
            try:
                choice = input("Select group (enter number): ").strip()
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

def cmd_activate(session_id, project, topic_name=""):
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

        # Clean up any stale slots first (self-healing)
        cleaned = cleanup_stale_slots(state, preserve_ipc_dirs=False, verbose=False)
        if cleaned:
            for slot_num, sid, reason in cleaned:
                log.info(f"[ACTIVATE] Cleaned stale slot S{slot_num} "
                        f"(session: {sid[:8]}..., reason: {reason})")

        # Clean up orphaned IPC directories (dirs with no matching slot in state)
        active_session_ids = {info.get("session_id") for info in slots.values()}
        if os.path.isdir(IPC_DIR):
            for dirname in os.listdir(IPC_DIR):
                dirpath = os.path.join(IPC_DIR, dirname)
                if os.path.isdir(dirpath) and dirname not in active_session_ids:
                    try:
                        shutil.rmtree(dirpath)
                        log.info(f"[ACTIVATE] Removed orphaned IPC dir: {dirname[:12]}...")
                    except Exception as e:
                        log.warning(f"[ACTIVATE] Failed to remove orphaned IPC dir {dirname}: {e}")

        # Check if already active
        for slot_num, info in slots.items():
            if info.get("session_id") == session_id:
                print(f"Session already active in slot S{slot_num}")
                return slot_num


        # Check for duplicate project+topic (different session_id, same intent)
        for slot_num, info in slots.items():
            if (info.get("project") == (project or "unknown")
                    and info.get("topic_name") == (topic_name or f"S{slot_num} - {project or 'unknown'}")):
                # Found duplicate - check if it's truly active or stale
                dup_session_id = info.get("session_id")
                is_active, _ = is_slot_actually_active(state, slot_num)

                if is_active and dup_session_id == session_id:
                    # Same session already active - just return slot number
                    print(f"Session already active in slot S{slot_num}")
                    return slot_num
                elif is_active:
                    # Different session but same project - auto-deactivate old session
                    log.info(f"[ACTIVATE] Auto-deactivating old session {dup_session_id[:8]} for new {session_id[:8]}")
                    del slots[slot_num]
                    # Clean up IPC for old session
                    old_ipc = os.path.join(IPC_DIR, dup_session_id)
                    if os.path.isdir(old_ipc):
                        try:
                            shutil.rmtree(old_ipc)
                        except:
                            pass
                    break  # Continue with new activation
                else:
                    # Stale duplicate - clean it up
                    log.info(f"[ACTIVATE] Cleaning stale duplicate S{slot_num}")
                    del slots[slot_num]
                    break  # Continue with new activation
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
            "topic_name": topic_name or f"S{assigned_slot} - {project or 'unknown'}",
            "started": time.strftime("%Y-%m-%d %H:%M:%S"),
        }

        # Create IPC directory
        ipc_session_dir = os.path.join(IPC_DIR, session_id)
        os.makedirs(ipc_session_dir, exist_ok=True)

        # Calculate topic name: use custom if provided, else default to "S{slot} - {project}"
        calculated_topic_name = topic_name or f"S{assigned_slot} - {project or 'unknown'}"

        with open(os.path.join(ipc_session_dir, "meta.json"), "w") as f:
            json.dump({
                "session_id": session_id,
                "slot": assigned_slot,
                "project": project or "unknown",
                "topic_name": calculated_topic_name,
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
            "topic_name": calculated_topic_name,
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

        # Find this session's slot (handle both temp and real session_ids)
        removed_slot = None
        actual_session_id = session_id  # May be remapped to real id

        for slot_num, info in list(slots.items()):
            if info.get("session_id") == session_id:
                removed_slot = slot_num
                actual_session_id = session_id
                break

        if removed_slot is None:
            # Try to find any slot that's currently active
            # (user might have called /back with wrong session_id)
            if slots:
                # Deactivate the first (or any) active session
                for slot_num, info in list(slots.items()):
                    removed_slot = slot_num
                    actual_session_id = info.get("session_id", session_id)
                    break

        if removed_slot is None:
            print("No active AFK sessions found.")
            return

        # Write deactivation event BEFORE removing from state.json
        # This ensures daemon sees the session as active and scans the event
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

            # Wait for daemon to process deactivation (poll for marker file)
            processed_path = os.path.join(ipc_session_dir, "deactivation_processed")
            deadline = time.time() + 5.0
            while time.time() < deadline:
                if os.path.exists(processed_path):
                    break
                time.sleep(0.3)

            # Fallback: if daemon didn't process, delete topic directly
            if not os.path.exists(processed_path):
                thread_id = slots.get(removed_slot, {}).get("thread_id")
                if thread_id:
                    log.info(f"[DEACTIVATE] Daemon didn't process, deleting topic {thread_id} directly")
                    try:
                        config = load_config()
                        token = config.get("bot_token", "")
                        chat_id = config.get("chat_id", "")
                        if token and chat_id:
                            url = f"https://api.telegram.org/bot{token}/deleteForumTopic"
                            data = json.dumps({"chat_id": chat_id, "message_thread_id": thread_id}).encode()
                            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
                            urllib.request.urlopen(req, timeout=5)
                    except Exception as e:
                        log.error(f"[DEACTIVATE] Fallback topic delete failed: {e}")

        # NOW remove the slot from state.json (after daemon has processed the event)
        del slots[removed_slot]

        # Clean up IPC dir
        if os.path.isdir(ipc_session_dir):
            import shutil
            shutil.rmtree(ipc_session_dir, ignore_errors=True)

        # Stop daemon if no sessions remain
        if not slots:
            stop_daemon(state)
            # Clean ALL remaining IPC dirs when last session deactivated
            if os.path.isdir(IPC_DIR):
                for dirname in os.listdir(IPC_DIR):
                    dirpath = os.path.join(IPC_DIR, dirname)
                    if os.path.isdir(dirpath):
                        shutil.rmtree(dirpath, ignore_errors=True)

        print(f"AFK mode deactivated — slot S{removed_slot} released.")

    locked_state_op(do_deactivate)


# ─── Response sending (for Claude to send output back to Telegram) ──────────

def get_active_sessions(state):
    """Get dict of active session_id -> slot_num from state."""
    sessions = {}
    for slot_num, info in state.get("slots", {}).items():
        sid = info.get("session_id")
        if sid:
            sessions[sid] = slot_num
    return sessions


def send_response_to_telegram(text):
    """Send a response message back to Telegram for active AFK session."""
    try:
        state = load_state()
        active = get_active_sessions(state)
        if not active:
            return False

        # Send to first active session
        session_id = list(active.keys())[0]
        ipc_session_dir = os.path.join(IPC_DIR, session_id)
        event_file = os.path.join(ipc_session_dir, "events.jsonl")

        if not os.path.isdir(ipc_session_dir):
            return False

        event = {
            "id": str(uuid.uuid4())[:8],
            "type": "response",
            "text": text,
            "session_id": session_id,
            "timestamp": time.time(),
        }
        with open(event_file, "a") as f:
            f.write(json.dumps(event) + "\n")
        return True
    except Exception:
        return False


# ─── Hook Mode ───────────────────────────────────────────────────────────────

def _find_bound_session(session_id):
    """Find IPC dir where this session_id is bound."""
    if not os.path.isdir(IPC_DIR):
        return None
    for dirname in os.listdir(IPC_DIR):
        dirpath = os.path.join(IPC_DIR, dirname)
        bound_file = os.path.join(dirpath, "bound_session")
        if os.path.isfile(bound_file):
            try:
                with open(bound_file) as f:
                    if f.read().strip() == session_id:
                        return dirpath
            except OSError:
                pass
    return None


def _find_unbound_slots():
    """Find IPC dirs that don't have a bound_session file yet."""
    if not os.path.isdir(IPC_DIR):
        return []
    unbound = []
    for dirname in os.listdir(IPC_DIR):
        dirpath = os.path.join(IPC_DIR, dirname)
        if os.path.isdir(dirpath) and not os.path.isfile(os.path.join(dirpath, "bound_session")):
            unbound.append(dirpath)
    return unbound


def _bind_session(ipc_dir, session_id):
    """Bind a Claude session_id to an IPC directory."""
    with open(os.path.join(ipc_dir, "bound_session"), "w") as f:
        f.write(session_id)


def cmd_hook():
    event_data = json.load(sys.stdin)
    session_id = event_data.get("session_id", "")
    hook_event = event_data.get("hook_event_name", "")

    if not session_id:
        sys.exit(0)

    ipc_session_dir = os.path.join(IPC_DIR, session_id)

    if os.path.isdir(ipc_session_dir):
        # Direct match — this session IS the AFK session
        pass
    else:
        # Check if this session_id is bound to an existing IPC dir
        bound_dir = _find_bound_session(session_id)
        if bound_dir:
            ipc_session_dir = bound_dir
            log.debug(f"[BOUND] Session {session_id} bound to {bound_dir}")
        else:
            # Check for unbound slots — bind on first contact
            unbound = _find_unbound_slots()
            if len(unbound) == 1:
                _bind_session(unbound[0], session_id)
                ipc_session_dir = unbound[0]
                log.info(f"[BIND] Bound session {session_id} to {os.path.basename(unbound[0])}")
            else:
                # Zero or multiple unbound — not our session, exit silently
                log.debug(f"Not in AFK mode for session {session_id} ({len(unbound)} unbound slots)")
                sys.exit(0)

    if not os.path.isdir(ipc_session_dir):
        sys.exit(0)

    config = load_config()
    auto_approve = set(config.get("auto_approve_tools", []))

    # ── PermissionRequest ──
    if hook_event == "PermissionRequest":
        tool_name = event_data.get("tool_name", "")

        # Auto-approve: check tool name + optional path matching
        if tool_name in auto_approve:
            auto_paths = config.get("auto_approve_paths", [])
            should_approve = False

            if not auto_paths:
                # No path rules — auto-approve by tool name alone
                should_approve = True
            else:
                # Extract path from tool input
                tool_input = event_data.get("tool_input", {})
                file_path = (tool_input.get("file_path") or
                             tool_input.get("path") or
                             tool_input.get("notebook_path") or "")
                if not file_path:
                    # Tool has no path (e.g. WebSearch) — auto-approve by tool name alone
                    should_approve = True
                else:
                    import fnmatch
                    should_approve = any(fnmatch.fnmatch(file_path, pat) for pat in auto_paths)

            if should_approve:
                result = {
                    "hookSpecificOutput": {
                        "hookEventName": "PermissionRequest",
                        "decision": {"behavior": "allow"},
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
        stop_hook_active = event_data.get("stop_hook_active", False)

        event_id = str(uuid.uuid4())[:8]
        last_msg = event_data.get("last_assistant_message", "")
        # Truncate for Telegram (max ~4000 chars)
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
                reason = response.get("_reason", "topic deleted")
                print(f"\n🔚 AFK session ended from Telegram ({reason}). Returning control to local console.", file=sys.stderr)
                log.info(f"[STOP] Killed by daemon: {reason}")
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


def _check_kill_file(ipc_dir):
    """Check if daemon wrote a kill marker (topic deleted)."""
    kill_path = os.path.join(ipc_dir, "kill")
    return os.path.exists(kill_path)


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
            log.info("[POLL] force_clear detected, returning allow decision")
            return {"decision": "allow"}

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


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: hook.py <activate|deactivate|status|setup|respond|hook>", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "activate":
        session_id = sys.argv[2] if len(sys.argv) > 2 else ""
        project = sys.argv[3] if len(sys.argv) > 3 else ""
        topic_name = sys.argv[4] if len(sys.argv) > 4 else ""
        cmd_activate(session_id, project, topic_name)
    elif cmd == "deactivate":
        session_id = sys.argv[2] if len(sys.argv) > 2 else ""
        cmd_deactivate(session_id)
    elif cmd == "status":
        cmd_status()
    elif cmd == "setup":
        cmd_setup()
    elif cmd == "respond":
        text = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else ""
        if send_response_to_telegram(text):
            print("✓ Response sent to Telegram")
        else:
            print("✗ No active AFK session", file=sys.stderr)
    elif cmd == "hook":
        cmd_hook()
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)
