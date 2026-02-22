#!/bin/bash
# afk-claude-telegram-bridge installer
# Works both via `curl | bash` (downloads from GitHub) and local clone
set -euo pipefail

GLOBAL_BASE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
INSTALL_DIR="$GLOBAL_BASE/hooks/telegram-bridge"
SETTINGS="$GLOBAL_BASE/settings.json"
REPO_BASE="https://raw.githubusercontent.com/gmotyl/afk-claude-telegram-bridge-skill/main"

# --- Detect source (local clone or remote) ---
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" != "bash" ]; then
  CANDIDATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  if [ -f "$CANDIDATE/hook.py" ] && [ -f "$CANDIDATE/bridge.py" ]; then
    SCRIPT_DIR="$CANDIDATE"
  fi
fi

# --- Detect update vs fresh install ---
UPDATING=false
if [ -f "$INSTALL_DIR/hook.py" ]; then
  UPDATING=true
fi

echo "=== afk-claude-telegram-bridge installer ==="
echo ""

if [ "$UPDATING" = true ]; then
  echo "Existing install found. Updating..."
else
  echo "Installing Telegram Bridge for Claude Code..."
fi

# --- Create install directory ---
mkdir -p "$INSTALL_DIR"

# --- Copy core files ---
CORE_FILES="hook.py hook.sh bridge.py"

if [ -n "$SCRIPT_DIR" ]; then
  echo "Installing from local clone: $SCRIPT_DIR"
  for f in $CORE_FILES; do
    cp "$SCRIPT_DIR/$f" "$INSTALL_DIR/$f"
  done
else
  echo "Downloading from GitHub..."
  for f in $CORE_FILES; do
    curl -fsSL "$REPO_BASE/$f" -o "$INSTALL_DIR/$f"
  done
fi

chmod +x "$INSTALL_DIR/hook.sh"

echo "Core files installed to $INSTALL_DIR"

# --- Update settings.json with hooks ---
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
    'PermissionRequest': {'timeout': 360},
}

for event, cfg in hook_configs.items():
    event_hooks = hooks.get(event, [])

    # Remove any existing telegram-bridge entries
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

# --- Run setup if not configured ---
if [ -f "$INSTALL_DIR/config.json" ]; then
  echo ""
  echo "Existing bot configuration found."
  read -p "Re-run Telegram bot setup? [y/N]: " RERUN
  if [ "${RERUN,,}" = "y" ]; then
    python3 "$INSTALL_DIR/hook.py" setup
  fi
else
  echo ""
  echo "No bot configuration found. Running setup..."
  echo ""
  python3 "$INSTALL_DIR/hook.py" setup
fi

# --- Done ---
echo ""
echo "=== Installation complete ==="
echo ""
echo "Usage:"
echo "  /afk              Activate AFK mode (forward to Telegram)"
echo "  /afk my-project   Activate with custom topic name"
echo "  /back             Deactivate AFK mode"
echo ""
echo "Files installed:"
echo "  $INSTALL_DIR/hook.py"
echo "  $INSTALL_DIR/hook.sh"
echo "  $INSTALL_DIR/bridge.py"
echo ""
