#!/bin/bash
# Task 5.2: Hook Wrapper Script
# Executes JavaScript entry points from shell (Claude Code invokes this)
# Handles hook types, status, and setup operations

set -uo pipefail

# Determine config directory (same as where this script lives)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR"

# Validate that hook.js exists
if [ ! -f "$CONFIG_DIR/hook.js" ]; then
  echo "ERROR: hook.js not found in $CONFIG_DIR" >&2
  exit 127
fi

# Make sure hook.js is executable
chmod +x "$CONFIG_DIR/hook.js" 2>/dev/null || true

# Export config directory for Node.js to find config.json and state.json
export TELEGRAM_BRIDGE_CONFIG="$CONFIG_DIR"
export AFK_CONFIG_PATH="$CONFIG_DIR/config.json"

# Check if any AFK slots are active (hook.js resolves the exact session via binding)
# NOTE: We no longer hardcode a specific slot here — session binding in hook.js
# handles multi-session isolation by matching Claude Code's session_id to the
# correct IPC directory via bound_session files.
if [ -f "$CONFIG_DIR/state.json" ] && command -v node &> /dev/null; then
  _STATE_FILE="$CONFIG_DIR/state.json"
  _HAS_ACTIVE=$(node -e 'try { const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8")); const active = Object.values(s.slots || {}).filter(Boolean); if (active.length > 0) console.log("1"); } catch(e) {}' "$_STATE_FILE" 2>/dev/null)
  if [ -n "$_HAS_ACTIVE" ]; then
    # Signal that AFK is active — hook.js will resolve the exact session
    export AFK_ACTIVE=1
  fi
fi

# Handle special flags first (before stdin read)
case "${1:-}" in
  --status)
    # Show daemon status by reading state.json
    if [ -f "$CONFIG_DIR/state.json" ]; then
      echo "AFK Bridge Status:"
      echo "State file: $CONFIG_DIR/state.json"
      # Try to parse and display active slots
      if command -v jq &> /dev/null; then
        jq '.slots | length' "$CONFIG_DIR/state.json" 2>/dev/null | {
          read count
          echo "Active slots: ${count:-0}"
        }
      else
        # Fallback if jq not available
        grep -o '"slots"' "$CONFIG_DIR/state.json" > /dev/null 2>&1 && \
          echo "State file exists with slots" || echo "State file error"
      fi
    else
      echo "AFK Bridge not installed. Run: scripts/install-ts.sh"
      exit 1
    fi
    exit 0
    ;;
  --activate)
    # Activate AFK mode: claim slot, create IPC dir, start daemon
    # Passes through all args including --verbose
    shift
    exec node "$CONFIG_DIR/cli.js" activate "$@"
    ;;
  --deactivate)
    # Deactivate AFK mode: release slot, clean IPC, stop daemon if last
    shift
    exec node "$CONFIG_DIR/cli.js" deactivate "$@"
    ;;
  --reset)
    # Nuclear reset: kill daemons, delete Telegram topics, clear state, remove IPC dirs
    echo "Resetting AFK bridge..."

    # Delete Telegram topics for active slots before clearing state
    if [ -f "$CONFIG_DIR/config.json" ] && [ -f "$CONFIG_DIR/state.json" ]; then
      BOT_TOKEN=$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8")); console.log(c.telegramBotToken || c.bot_token || ""); } catch(e) {}' "$CONFIG_DIR/config.json" 2>/dev/null)
      CHAT_ID=$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8")); console.log(c.telegramGroupId || c.chat_id || ""); } catch(e) {}' "$CONFIG_DIR/config.json" 2>/dev/null)
      if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
        THREAD_IDS=$(node -e 'try { const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8")); Object.values(s.slots || {}).forEach(slot => { if (slot && slot.threadId) console.log(slot.threadId); }); } catch(e) {}' "$CONFIG_DIR/state.json" 2>/dev/null)
        for tid in $THREAD_IDS; do
          curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteForumTopic" \
            -H "Content-Type: application/json" \
            -d "{\"chat_id\":\"${CHAT_ID}\",\"message_thread_id\":${tid}}" > /dev/null 2>&1 \
            && echo "Deleted Telegram topic $tid" || echo "Failed to delete topic $tid"
        done
      fi
    fi

    # Kill all bridge.js daemon processes
    pkill -f "node.*bridge\.js" 2>/dev/null && echo "Killed daemon processes" || echo "No daemons running"
    # Clear IPC directories
    if [ -d "$CONFIG_DIR/ipc" ]; then
      rm -rf "$CONFIG_DIR/ipc"
      mkdir -p "$CONFIG_DIR/ipc"
      echo "Cleared IPC directories"
    fi
    # Reset state.json
    echo '{"slots":{}}' > "$CONFIG_DIR/state.json"
    echo "Reset state.json"
    # Clear daemon log
    > "$CONFIG_DIR/daemon.log" 2>/dev/null
    echo "Cleared daemon.log"
    echo "AFK bridge reset complete. Use --activate to start fresh."
    exit 0
    ;;
  --setup)
    # Interactive bot token + chat_id configuration
    echo "Run 'bash install.sh' to reconfigure Telegram bot setup." >&2
    exit 1
    ;;
  --help|-h)
    cat <<'EOF'
Usage: hook.sh [--activate|--deactivate|--status|--setup|--help] [hook-type]

Wrapper for TypeScript telegram-bridge hook.

Commands:
  --activate <session_id> <project> [topic]  Activate AFK mode
  --deactivate <session_id>                  Deactivate AFK mode
  --status      Show daemon status
  --setup       Configure Telegram credentials
  --help        Show this help message

Hook Types (when called without --flags):
  Reads JSON from stdin (Claude Code hook event) and processes
  permission_request, stop, or notification events.

Environment:
  TELEGRAM_BRIDGE_CONFIG  Set to config directory
EOF
    exit 0
    ;;
esac

# ── Hook mode: read stdin, gate on session binding, then delegate to hook.js ──

# No active AFK slots → exit silently (fast path)
if [ "${AFK_ACTIVE:-}" != "1" ]; then
  exit 0
fi

# Read stdin (Claude Code sends JSON event payload)
INPUT=$(cat)

# Extract session_id from stdin JSON
SESSION_ID=$(echo "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).session_id||"")}catch(e){console.log("")}})' 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Session gating: only proceed if this session is bound or can be bound
# (prevents non-AFK sessions from leaking into the bridge)
IPC_DIR="$CONFIG_DIR/ipc"
if [ -d "$IPC_DIR" ]; then
  # Check if session_id directly matches an IPC dir (AFK session itself)
  if [ -d "$IPC_DIR/$SESSION_ID" ]; then
    : # Direct match — this IS the AFK session
  else
    # Check if this session is already bound to an IPC dir
    _BOUND=""
    _UNBOUND_COUNT=0
    for _dir in "$IPC_DIR"/*/; do
      [ -d "$_dir" ] || continue
      if [ -f "${_dir}bound_session" ]; then
        _CONTENT=$(cat "${_dir}bound_session" 2>/dev/null)
        if [ "$_CONTENT" = "$SESSION_ID" ]; then
          _BOUND=1
          break
        fi
      else
        _UNBOUND_COUNT=$((_UNBOUND_COUNT + 1))
      fi
    done

    if [ -z "$_BOUND" ]; then
      # Not bound — proceed if at least 1 unbound slot exists (to bind on first contact).
      # The stop hook clears bound_session when delivering an instruction because
      # Claude Code may change session_id between the Stop and subsequent PreToolUse hooks.
      if [ "$_UNBOUND_COUNT" -lt 1 ]; then
        exit 0
      fi
    fi
  fi
else
  exit 0
fi

# Pipe the saved stdin to hook.js
echo "$INPUT" | "$CONFIG_DIR/hook.js" "$@"
exit $?
