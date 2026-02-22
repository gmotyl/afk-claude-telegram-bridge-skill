# AFK Claude Telegram Bridge

Remote-control Claude Code from your phone via Telegram when you're away from your keyboard.

## Use Case

You're working on code with Claude Code, but you need to leave your desk or close your laptop. With this bridge, you can:

- **Approve tool calls** from your phone (Write, Bash, Edit, etc.)
- **Continue working** by sending new instructions when Claude finishes a task
- **Monitor progress** via Telegram notifications
- **Run multiple sessions** concurrently with automatic topic routing

Perfect for: working on the go, meetings, or just stepping away while keeping Claude running.

## Features

- 🔐 Permission approval via Telegram inline keyboards
- 📂 **Telegram Topics** — Each session gets its own topic/thread in a Telegram group
- 🚫 **No prefixes needed** — Just type in the topic, bot knows which session to send to
- 📥 **Message Buffer** — Queue instructions while Claude is working, delivered when task completes
- 🤖 Auto-approve read-only tools (Read, Glob, Grep, WebSearch, WebFetch)
- 👥 Multi-session support (up to 4 concurrent sessions)
- 📦 Zero Python dependencies (stdlib only)

## ⚠️ Requirements

- **Telegram Group** (not private chat) with Topics enabled
- Bot added to the group as **Administrator**
- Group chat ID (starts with `-100...`)

## Quick Start (One-Liner)

```bash
git clone https://github.com/gmotyl/afk-claude-telegram-bridge.git && cd afk-claude-telegram-bridge && ./setup.sh
```

Or if you prefer manual installation:

### 1. Clone or Copy

```bash
git clone https://github.com/gmotyl/afk-claude-telegram-bridge.git
cp -r afk-claude-telegram-bridge/* ~/.claude/hooks/telegram-bridge/
```

### 2. Create Telegram Bot

1. Open Telegram → search **@BotFather**
2. Send `/newbot`
3. Name it "Claude Bridge" (or your preference)
4. Copy the bot token

### 3. Create a Telegram Group

1. Create a new group in Telegram
2. Add your bot to the group
3. **Make bot an Administrator**
4. **Enable Topics** in group settings
5. Send a message to the group

### 4. Get Your Group Chat ID

1. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
2. Find `"chat":{"id":-100...}` — that's your group chat_id (starts with -100)
3. Copy the full ID (including the -100 prefix)

### 5. Configure

```bash
~/.claude/hooks/telegram-bridge/hook.sh --setup
```

Enter your bot token and the group chat ID (starts with -100).

### 6. Add Hooks

Edit `~/.claude/settings.json`:

```json
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
```

### 7. Create Commands

`~/.claude/commands/afk.md`:
```markdown
# AFK Mode

Enable AFK mode to forward Claude Code events to Telegram.

/afk
```

`~/.claude/commands/back.md`:
```markdown
# Back from AFK

Disable AFK mode and return to local control.

/back
```

## How It Works

### Auto-Topics
When you activate `/afk`, the bot automatically creates a new Topic in your Telegram group (e.g., "S1 - myproject"). All communication for that session happens in that topic.

### Smart Routing
No need to type "S1: do this". Just open the topic and type your instruction — the bot knows which session it belongs to.

### Message Buffer
If Claude is still working on a task and you send multiple instructions, the bot queues them and delivers all at once when Claude finishes the current task.

## Usage

### Activate
```
/afk
```
Bot creates a new topic: "S1 - projectname"

### While Away

When Claude needs approval (in the topic):
```
🔐 Permission Request
Tool: Bash
`npm install express`
[✅ Approve] [❌ Deny]
```

When task completes (in the topic):
```
✅ Task Complete
I've implemented the login form...
[🛑 Let it stop]
```

**Just reply with instructions** — no prefix needed!

### Multiple Sessions
Each session automatically gets its own topic:
- Session 1 → Topic "S1 - projectname"
- Session 2 → Topic "S2 - anotherproject"

### Deactivate
```
/back
```

## Commands

| Command | Description |
|---------|-------------|
| `hook.sh --activate <session> [project]` | Enable AFK mode |
| `hook.sh --deactivate <session>` | Disable AFK mode |
| `hook.sh --status` | Show active sessions |
| `hook.sh --setup` | Configure bot |
| `hook.sh --help` | Help |

## Troubleshooting

- **Logs**: `cat ~/.claude/hooks/telegram-bridge/daemon.log`
- **Status**: `~/.claude/hooks/telegram-bridge/hook.sh --status`
- **Manual start**: `python3 ~/.claude/hooks/telegram-bridge/bridge.py`
- **Kill daemon**: `kill $(jq -r '.daemon_pid' ~/.claude/hooks/telegram-bridge/state.json)`

## Requirements

- Python 3 (stdlib only)
- bash
- Telegram bot token
- Telegram group with Topics enabled
- Bot must be group administrator

## Credits

Built by [Greg Motyl](https://github.com/gmotyl)

## Support

If you find this useful, you can [buy me a coffee](https://buymeacoffee.com/motyl.dev)!
