#!/bin/bash
# afk-claude-telegram-bridge installer (TypeScript version)
# Works both via `npx` / `curl | bash` (downloads from GitHub) and local clone
set -euo pipefail

GLOBAL_BASE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
INSTALL_DIR="$GLOBAL_BASE/hooks/telegram-bridge"
SETTINGS="$GLOBAL_BASE/settings.json"
REPO_BASE="https://raw.githubusercontent.com/gmotyl/afk-claude-telegram-bridge/main"

# --- Detect source (local clone or remote) ---
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" != "bash" ]; then
  CANDIDATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  # Local clone: check for dist/hook.js (built TS) or package.json
  if [ -f "$CANDIDATE/dist/hook.js" ]; then
    SCRIPT_DIR="$CANDIDATE"
  elif [ -f "$CANDIDATE/package.json" ]; then
    # Repo present but not built — build first
    echo "Building TypeScript..."
    (cd "$CANDIDATE" && npm run build > /dev/null 2>&1) || {
      echo "ERROR: npm run build failed. Run 'npm install && npm run build' first." >&2
      exit 1
    }
    SCRIPT_DIR="$CANDIDATE"
  fi
fi

# --- Detect update vs fresh install ---
UPDATING=false
if [ -f "$INSTALL_DIR/hook.js" ] || [ -f "$INSTALL_DIR/hook.py" ]; then
  UPDATING=true
fi

echo "=== afk-claude-telegram-bridge installer (TS) ==="
echo ""

if [ "$UPDATING" = true ]; then
  echo "Existing install found. Updating..."
else
  echo "Installing Telegram Bridge for Claude Code..."
fi

# --- Create install directory ---
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/ipc"

# --- Copy/download core files ---
if [ -n "$SCRIPT_DIR" ]; then
  echo "Installing from local clone: $SCRIPT_DIR"
  cp "$SCRIPT_DIR/dist/hook.js" "$INSTALL_DIR/hook.js"
  cp "$SCRIPT_DIR/dist/bridge.js" "$INSTALL_DIR/bridge.js"
  cp "$SCRIPT_DIR/dist/cli.js" "$INSTALL_DIR/cli.js"
  cp "$SCRIPT_DIR/scripts/hook-wrapper.sh" "$INSTALL_DIR/hook.sh"
else
  echo "Downloading from GitHub..."
  curl -fsSL "$REPO_BASE/dist/hook.js" -o "$INSTALL_DIR/hook.js"
  curl -fsSL "$REPO_BASE/dist/bridge.js" -o "$INSTALL_DIR/bridge.js"
  curl -fsSL "$REPO_BASE/dist/cli.js" -o "$INSTALL_DIR/cli.js"
  curl -fsSL "$REPO_BASE/scripts/hook-wrapper.sh" -o "$INSTALL_DIR/hook.sh"
fi

chmod +x "$INSTALL_DIR/hook.js" "$INSTALL_DIR/bridge.js" "$INSTALL_DIR/cli.js" "$INSTALL_DIR/hook.sh"

echo "Core files installed to $INSTALL_DIR"

# --- Install /afk and /back commands ---
COMMANDS_DIR="$GLOBAL_BASE/commands"
mkdir -p "$COMMANDS_DIR"

if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/skills" ]; then
  [ -f "$SCRIPT_DIR/skills/afk/SKILL.md" ] && cp "$SCRIPT_DIR/skills/afk/SKILL.md" "$COMMANDS_DIR/afk.md"
  [ -f "$SCRIPT_DIR/skills/back/SKILL.md" ] && cp "$SCRIPT_DIR/skills/back/SKILL.md" "$COMMANDS_DIR/back.md"
else
  curl -fsSL "$REPO_BASE/skills/afk/SKILL.md" -o "$COMMANDS_DIR/afk.md" 2>/dev/null || true
  curl -fsSL "$REPO_BASE/skills/back/SKILL.md" -o "$COMMANDS_DIR/back.md" 2>/dev/null || true
fi

echo "Commands installed: /afk, /back"

# --- Initialize state.json if missing ---
if [ ! -f "$INSTALL_DIR/state.json" ]; then
  echo '{"slots":{}}' > "$INSTALL_DIR/state.json"
  echo "Created state.json"
fi

# --- Register hooks in settings.json ---
echo ""
echo "Registering hooks in settings.json..."

python3 -c "
import json, os

settings_path = '$SETTINGS'
hook_cmd = '$INSTALL_DIR/hook.sh'

# Load existing settings
if os.path.exists(settings_path):
    with open(settings_path) as f:
        settings = json.load(f)
else:
    settings = {}

hooks = settings.setdefault('hooks', {})

# Hook configurations per event
hook_configs = {
    'Stop': {'timeout': 660},
    'Notification': {'timeout': 10},
    'PreToolUse': {'timeout': 360},
}

for event, cfg in hook_configs.items():
    event_hooks = hooks.get(event, [])

    # Remove any existing telegram-bridge entries (both Python and TS)
    event_hooks = [
        h for h in event_hooks
        if not any(
            'telegram-bridge' in hk.get('command', '')
            for hk in h.get('hooks', [])
        )
    ]

    # Add telegram-bridge hook
    entry = {
        'matcher': '',
        'hooks': [{
            'type': 'command',
            'command': hook_cmd,
            'timeout': cfg['timeout'],
        }]
    }
    event_hooks.append(entry)
    hooks[event] = event_hooks

settings['hooks'] = hooks

with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print('Hooks registered for: ' + ', '.join(hook_configs.keys()))
"

# --- Config setup ---
CONFIG_FILE="$INSTALL_DIR/config.json"

if [ -f "$CONFIG_FILE" ]; then
  echo ""
  echo "Existing bot configuration found."
  read -p "Re-run Telegram bot setup? [y/N]: " RERUN
  if [ "${RERUN,,}" != "y" ]; then
    # Skip setup, jump to done
    SKIP_SETUP=true
  else
    SKIP_SETUP=false
  fi
else
  SKIP_SETUP=false
fi

if [ "${SKIP_SETUP:-false}" = false ]; then
  echo ""
  echo "Bot Configuration"
  echo "-----------------"
  echo ""
  echo "Step 1: Bot Token"
  echo "  1. Open Telegram -> search @BotFather"
  echo "  2. Send /newbot and follow instructions"
  echo "  3. Copy the bot token"
  echo ""
  read -p "Enter bot token: " BOT_TOKEN

  if [ -z "$BOT_TOKEN" ]; then
    echo "ERROR: Bot token is required. Run install again." >&2
    exit 1
  fi

  echo ""
  echo "Step 2: Add Bot to Telegram Group"
  echo "  1. Create a Telegram group with Topics enabled"
  echo "  2. Add your bot as Administrator"
  echo "  3. Send any message in the group"
  echo ""
  read -p "Press Enter after you've done the above..."

  echo ""
  echo "Step 3: Detecting your group..."

  RESPONSE=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=5")

  if echo "$RESPONSE" | grep -q '"ok":false'; then
    echo "ERROR: Failed to fetch updates. Check your bot token." >&2
    exit 1
  fi

  CHATS=$(echo "$RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
chats = {}
for result in data.get('result', []):
    chat = result.get('message', {}).get('chat', {})
    chat_id = chat.get('id')
    chat_type = chat.get('type')
    title = chat.get('title', 'Private Chat')
    if chat_id:
        chats[chat_id] = {'type': chat_type, 'title': title}

for cid, info in sorted(chats.items()):
    print(f\"{cid}|{info['type']}|{info['title']}\")
" 2>/dev/null)

  if [ -z "$CHATS" ]; then
    echo "ERROR: No messages found. Ensure bot is admin in a group with a message." >&2
    exit 1
  fi

  echo ""
  echo "Available groups:"
  echo ""
  COUNT=0
  while IFS='|' read -r cid ctype ctitle; do
    COUNT=$((COUNT + 1))
    echo "  [$COUNT] $ctitle (ID: $cid)"
  done <<< "$CHATS"

  echo ""
  read -p "Select group number: " CHAT_NUM

  SELECTED=$(echo "$CHATS" | sed -n "${CHAT_NUM}p")
  if [ -z "$SELECTED" ]; then
    echo "ERROR: Invalid selection" >&2
    exit 1
  fi

  CHAT_ID=$(echo "$SELECTED" | cut -d'|' -f1)
  CHAT_TITLE=$(echo "$SELECTED" | cut -d'|' -f3)

  echo ""
  echo "Selected: $CHAT_TITLE (ID: $CHAT_ID)"

  # Write TS-format config
  cat > "$CONFIG_FILE" << EOF
{
  "telegramBotToken": "$BOT_TOKEN",
  "telegramGroupId": $CHAT_ID,
  "ipcBaseDir": "$INSTALL_DIR/ipc",
  "sessionTimeout": 900000
}
EOF

  echo "Config saved to $CONFIG_FILE"
fi

# --- Remove legacy Python files (no longer needed) ---
for old_file in hook.py bridge.py poll.py; do
  if [ -f "$INSTALL_DIR/$old_file" ]; then
    rm -f "$INSTALL_DIR/$old_file"
    echo "Removed legacy $old_file"
  fi
done
# Clean up old -ts directory if it exists and we're installing to main dir
OLD_TS_DIR="$GLOBAL_BASE/hooks/telegram-bridge-ts"
if [ -d "$OLD_TS_DIR" ] && [ "$INSTALL_DIR" != "$OLD_TS_DIR" ]; then
  echo "Note: Old telegram-bridge-ts directory found at $OLD_TS_DIR"
  echo "  You can remove it manually if no longer needed."
fi

# --- Done ---
echo ""
echo "============================================"
echo "  Installation complete!"
echo "============================================"
echo ""
echo "Files installed:"
echo "  $INSTALL_DIR/hook.js"
echo "  $INSTALL_DIR/bridge.js"
echo "  $INSTALL_DIR/cli.js"
echo "  $INSTALL_DIR/hook.sh"
echo "  $INSTALL_DIR/config.json"
echo "  $COMMANDS_DIR/afk.md"
echo "  $COMMANDS_DIR/back.md"
echo ""
echo "Hooks registered in:"
echo "  $SETTINGS"
echo ""
echo "Restart Claude Code to load the new /afk and /back commands."
echo ""
echo "Usage (after restart):"
echo "  /afk              Activate AFK mode"
echo "  /afk my-project   Activate with custom topic name"
echo "  /back             Deactivate AFK mode"
echo ""
