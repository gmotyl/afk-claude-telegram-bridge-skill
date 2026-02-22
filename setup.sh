#!/bin/bash
# AFK Claude Telegram Bridge - Setup Script
# This script installs the bridge files and optionally runs the bot setup

set -e

BRIDGE_DIR="$HOME/.claude/hooks/telegram-bridge"
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🤖 AFK Claude Telegram Bridge Setup"
echo "===================================="
echo ""

# Check if running from skill directory or cloned repo
if [ -d "$SKILL_DIR/hooks" ]; then
    SOURCE_DIR="$SKILL_DIR/hooks/telegram-bridge"
else
    SOURCE_DIR="$SKILL_DIR"
fi

# Check if source exists
if [ ! -f "$SOURCE_DIR/bridge.py" ]; then
    echo "❌ Error: bridge.py not found in $SOURCE_DIR"
    echo ""
    echo "Usage:"
    echo "  1. Clone the repo: git clone https://github.com/gmotyl/afk-claude-telegram-bridge.git"
    echo "  2. Run this script: cd afelegram-bridge && ./setup.sh"
    exitk-claude-t 1
fi

# Create bridge directory
echo "📁 Creating bridge directory..."
mkdir -p "$BRIDGE_DIR"

# Copy files
echo "📦 Copying bridge files..."
cp -f "$SOURCE_DIR/hook.sh" "$BRIDGE_DIR/"
cp -f "$SOURCE_DIR/hook.py" "$BRIDGE_DIR/"
cp -f "$SOURCE_DIR/bridge.py" "$BRIDGE_DIR/"
cp -f "$SOURCE_DIR/config.json" "$BRIDGE_DIR/"

chmod +x "$BRIDGE_DIR/hook.sh"

echo "✅ Files copied to $BRIDGE_DIR"

# Create commands directory
mkdir -p "$HOME/.claude/commands"

# Create afk.md if it doesn't exist
if [ ! -f "$HOME/.claude/commands/afk.md" ]; then
    echo "📝 Creating /afk command..."
    cat > "$HOME/.claude/commands/afk.md" << 'EOF'
# AFK Mode

Enable AFK mode to forward Claude Code events to Telegram.

/afk
EOF
    echo "✅ Created ~/.claude/commands/afk.md"
fi

# Create back.md if it doesn't exist
if [ ! -f "$HOME/.claude/commands/back.md" ]; then
    echo "📝 Creating /back command..."
    cat > "$HOME/.claude/commands/back.md" << 'EOF'
# Back from AFK

Disable AFK mode and return to local control.

/back
EOF
    echo "✅ Created ~/.claude/commands/back.md"
fi

echo ""
echo "✅ Basic installation complete!"
echo ""
echo "📋 Next steps:"
echo "  1. Run bot setup: $BRIDGE_DIR/hook.sh --setup"
echo "  2. Add hooks to ~/.claude/settings.json (see README.md)"
echo ""
echo "Would you like to run the bot setup now? (y/n)"
read -r RUN_SETUP

if [ "$RUN_SETUP" = "y" ] || [ "$RUN_SETUP" = "Y" ]; then
    echo ""
    echo "🤖 Starting bot setup..."
    "$BRIDGE_DIR/hook.sh" --setup
fi
