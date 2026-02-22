#!/bin/bash
# AFK Claude Telegram Bridge - Setup Script
# This script installs the bridge files and helps configure the bot

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
    echo "  2. Run this script: cd afk-claude-telegram-bridge && ./setup.sh"
    exit 1
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

# ============================================
# BOT CONFIGURATION
# ============================================
echo ""
echo "🤖 Bot Configuration"
echo "-------------------"

# Ask for bot token
echo ""
echo "Step 1: Bot Token"
echo "  1. Open Telegram → search @BotFather"
echo "  2. Send /newbot and follow instructions"
echo "  3. Copy the bot token"
echo ""
read -p "Enter bot token: " BOT_TOKEN

if [ -z "$BOT_TOKEN" ]; then
    echo "❌ Bot token is required. Run setup again with a valid token."
    exit 1
fi

# Ask user to add bot to group
echo ""
echo "Step 2: Add Bot to Telegram Group"
echo "  1. Create a new Telegram group (or use existing)"
echo "  2. Add your bot to the group"
echo "  3. Make the bot an ADMINISTRATOR"
echo "  4. Enable 'Topics' in group settings"
echo "  5. Send any message in the group"
echo ""
read -p "Press Enter after you've added the bot to the group and sent a message..."

# Fetch chats from Telegram API
echo ""
echo "Step 3: Detecting your group..."
echo "  Fetching recent messages..."

# Get updates from Telegram
RESPONSE=$(curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=5")

# Check if response is valid
if echo "$RESPONSE" | grep -q '"ok":false'; then
    echo "❌ Error fetching updates. Check your bot token."
    exit 1
fi

# Extract unique chats from updates
CHATS=$(echo "$RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
chats = {}
for result in data.get('result', []):
    chat = result.get('message', {}).get('chat', {})
    chat_id = chat.get('id')
    chat_type = chat.get('type')
    title = chat.get('title', 'Private Chat')
    username = chat.get('username', '')
    if chat_id:
        chats[chat_id] = {'type': chat_type, 'title': title, 'username': username}

for cid, info in sorted(chats.items()):
    print(f\"{cid}|{info['type']}|{info['title']}|{info['username']}\")
" 2>/dev/null)

if [ -z "$CHATS" ]; then
    echo "❌ No messages found. Make sure:"
    echo "   - Bot is added to your group"
    echo "   - Bot has administrator rights"
    echo "   - You've sent a message in the group"
    echo ""
    echo "   Then run: $BRIDGE_DIR/hook.sh --setup"
    exit 1
fi

# Show available chats
echo ""
echo "Available chats/groups:"
echo ""

CHAT_ARRAY=()
COUNT=0
while IFS='|' read -r ctype ctitle cusername; do
    COUNT=$((COUNT + 1))
    CHAT_ARRAY+=("$ctype")
    
    if [ "$ctype" = "group" ] || [ "$ctype" = "supergroup" ]; then
        echo "  [$COUNT] 👥 $ctitle (ID: $ctype)"
    else
        echo "  [$COUNT] 💬 $ctitle"
    fi
done <<< "$CHATS"

echo ""
echo "Select the group number: "
read -r CHAT_NUM

# Get selected chat
SELECTED=$(echo "$CHATS" | sed -n "${CHAT_NUM}p")

if [ -z "$SELECTED" ]; then
    echo "❌ Invalid selection"
    exit 1
fi

CHAT_ID=$(echo "$SELECTED" | cut -d'|' -f1)
CHAT_TITLE=$(echo "$SELECTED" | cut -d'|' -f3)

echo ""
echo "✅ Selected: $CHAT_TITLE"
echo "   Chat ID: $CHAT_ID"
echo ""

# Save config
cat > "$BRIDGE_DIR/config.json" << EOF
{
  "bot_token": "$BOT_TOKEN",
  "chat_id": "$CHAT_ID",
  "permission_timeout": 300,
  "stop_timeout": 600,
  "auto_approve_tools": [
    "Read",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "TaskList",
    "TaskGet",
    "TaskCreate",
    "TaskUpdate"
  ],
  "max_slots": 4
}
EOF

echo "✅ Config saved to $BRIDGE_DIR/config.json"

# Show hooks config
echo ""
echo "===================================="
echo "📋 Hooks Configuration"
echo "===================================="
echo ""
echo "Add this to your ~/.claude/settings.json:"
echo ""
cat << 'HOOKS'
{
  "hooks": {
    "Stop": {
      "hook": "~/.claude/hooks/telegram-bridge/hook.sh",
      "timeout": 660
    },
    "Notification": {
      "hook": "~/.claude/hooks/telegram-bridge/hook.sh",
      "timeout": 10
    },
    "PermissionRequest": {
      "hook": "~/.claude/hooks/telegram-bridge/hook.sh",
      "timeout": 360
    }
  }
}
HOOKS

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next:"
echo "  1. Add the hooks to ~/.claude/settings.json"
echo "  2. Restart Claude Code"
echo "  3. Run /afk in your session to test"
