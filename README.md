# AFK Claude Telegram Bridge

Remote-control Claude Code from your phone via Telegram when you're away from your keyboard.

## Use Case

You're working on code with Claude Code, but you need to leave your desk or close your laptop. With this bridge, you can:

- **Approve tool calls** from your phone (Write, Bash, Edit, etc.)
- **Continue working** by sending new instructions when Claude finishes a task
- **Monitor progress** via Telegram notifications
- **Run multiple sessions** concurrently (S1-S4)

Perfect for: working on the go, meetings, or just stepping away while keeping Claude running.

## Features

- 🔐 Permission approval via Telegram inline keyboards
- 📱 Send new instructions from your phone
- 🤖 Auto-approve read-only tools (Read, Glob, Grep, WebSearch, WebFetch)
- 👥 Multi-session support (up to 4 concurrent sessions)
- 📦 Zero Python dependencies (stdlib only)

## Quick Start

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

### 3. Get Your Chat ID

1. Send any message to your new bot
2. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Find `"chat":{"id":123456789}` — that's your chat_id

### 4. Configure

```bash
~/.claude/hooks/telegram-bridge/hook.sh --setup
```

Enter your bot token and chat ID when prompted.

### 5. Add Hooks

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

### 6. Create Commands

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

## Usage

### Activate
```
/afk
```
Telegram confirms: "📡 S1 — AFK Activated"

### While Away

When Claude needs approval:
```
🔐 S1 — Permission Request
Tool: Bash
`npm install express`
[✅ Approve] [❌ Deny]
```

When task completes:
```
✅ S1 — Task Complete
I've implemented the login form...
[🛑 Let it stop]
```

Reply with instructions to continue, or tap "Let it stop".

### Multi-Session
```
S1: add unit tests
S2: push to remote
```

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
- Claude Code

## Credits

Built by [Greg Motyl](https://github.com/gmotyl)

## Support

If you find this useful, you can [buy me a coffee](https://buymeacoffee.com/motyl.dev)!
