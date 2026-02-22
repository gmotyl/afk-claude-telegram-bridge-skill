#!/bin/bash
# telegram-bridge: Hook entry point for Claude Code ↔ Telegram bridge
# Thin bash wrapper — delegates all logic to hook.py
set -uo pipefail

BRIDGE_DIR="${HOME}/.claude/hooks/telegram-bridge"
CONFIG="$BRIDGE_DIR/config.json"
STATE="$BRIDGE_DIR/state.json"
HOOK_PY="$BRIDGE_DIR/hook.py"

# --- CLI subcommands (must come before stdin read) ---
case "${1:-}" in
  --activate)
    SESSION_ID="${2:-}"
    PROJECT="${3:-}"
    TOPIC_NAME="${4:-}"
    if [ -z "$SESSION_ID" ]; then
      echo "Usage: hook.sh --activate <session_id> [project_name] [topic_name]" >&2
      exit 1
    fi
    python3 "$HOOK_PY" activate "$SESSION_ID" "$PROJECT" "$TOPIC_NAME"
    exit $?
    ;;
  --deactivate)
    SESSION_ID="${2:-}"
    if [ -z "$SESSION_ID" ]; then
      echo "Usage: hook.sh --deactivate <session_id>" >&2
      exit 1
    fi
    python3 "$HOOK_PY" deactivate "$SESSION_ID"
    exit $?
    ;;
  --status)
    python3 "$HOOK_PY" status
    exit $?
    ;;
  --setup)
    python3 "$HOOK_PY" setup
    exit $?
    ;;
  --help|-h)
    cat <<'EOF'
Usage: hook.sh <command>

Commands:
  --activate <session_id> [project]  Enable AFK mode for a session
  --deactivate <session_id>          Disable AFK mode for a session
  --status                           Show active AFK sessions
  --setup                            Configure Telegram bot token and chat_id
  --help                             Show this help

When called without arguments (as a hook), reads JSON from stdin
and processes the hook event.
EOF
    exit 0
    ;;
  --*)
    echo "Unknown option: $1" >&2
    echo "Run 'hook.sh --help' for usage." >&2
    exit 1
    ;;
esac

# --- Hook mode: read stdin JSON, delegate to hook.py for processing ---
INPUT=$(cat)

# Extract session_id and hook event name
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
HOOK_EVENT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hook_event_name',''))" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  echo "DEBUG: No session_id in hook input" >> "$BRIDGE_DIR/hook-debug.log"
  exit 0
fi

# Check if this session should be routed to AFK
if [ -d "$BRIDGE_DIR/ipc/$SESSION_ID" ]; then
  # Direct match — this session IS the AFK session
  echo "DEBUG: Hook triggered for session $SESSION_ID (event: $HOOK_EVENT)" >> "$BRIDGE_DIR/hook-debug.log"
elif [ -z "$(ls "$BRIDGE_DIR/ipc" 2>/dev/null)" ]; then
  # No AFK sessions at all — fast exit
  echo "DEBUG: No AFK sessions active" >> "$BRIDGE_DIR/hook-debug.log"
  exit 0
else
  # Check if session is bound or if there's exactly one unbound slot to bind to
  python3 -c "
import os, sys
ipc = '$BRIDGE_DIR/ipc'
sid = '$SESSION_ID'
if not os.path.isdir(ipc):
    sys.exit(1)
for d in os.listdir(ipc):
    bp = os.path.join(ipc, d, 'bound_session')
    if os.path.isfile(bp):
        with open(bp) as f:
            if f.read().strip() == sid:
                sys.exit(0)
unbound = [d for d in os.listdir(ipc)
           if os.path.isdir(os.path.join(ipc, d))
           and not os.path.isfile(os.path.join(ipc, d, 'bound_session'))]
sys.exit(0 if len(unbound) == 1 else 1)
" 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "DEBUG: Session $SESSION_ID not bound to any AFK slot — skipping" >> "$BRIDGE_DIR/hook-debug.log"
    exit 0
  fi
  echo "DEBUG: Session $SESSION_ID bound or binding (event: $HOOK_EVENT)" >> "$BRIDGE_DIR/hook-debug.log"
fi

# Delegate to hook.py — handles binding and event processing
echo "$INPUT" | python3 "$HOOK_PY" hook
exit $?
