---
name: afk-claude-telegram-bridge
description: Remote-control Claude Code sessions from your phone via Telegram when AFK. Approve tool calls, send instructions, multi-session support.
---

# AFK Claude Telegram Bridge

Remote-control Claude Code sessions from your phone via Telegram when AFK (away from keyboard).

## When to Use

- "set up telegram bridge" / "configure telegram AFK"
- "enable remote control" / "activate AFK mode"
- "I want to control Claude from my phone"
- Installing this skill on a new machine

## What This Skill Does

Installs a complete Telegram ↔ Claude Code bridge that allows you to:

1. **Approve/deny tool calls** from Telegram inline keyboards
2. **Continue tasks** by sending new instructions when Claude finishes
3. **Auto-approve** read-only tools (Read, Glob, Grep, WebSearch, WebFetch)
4. **Multi-session support** — up to 4 concurrent sessions (S1-S4)
5. **Zero dependencies** — Python stdlib only

## Installation

### 1. Copy Bridge Files

```bash
# Create the bridge directory
mkdir -p ~/.claude/hooks/telegram-bridge

# Copy the skill files
cp -r <skill-dir>/* ~/.claude/hooks/telegram-bridge/
```

### 2. Configure Telegram Bot

1. Open Telegram → search **@BotFather** → send `/newbot`
2. Name it "Claude Bridge" (or your preferred name)
3. Copy the bot token

### 3. Get Your Chat ID

1. Send any message to your new bot
2. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Find `"chat":{"id":123456789}` in the response

### 4. Run Setup

```bash
~/.claude/hooks/telegram-bridge/hook.sh --setup
```

Enter your bot token and chat ID when prompted.

### 5. Add Hooks to settings.json

Add telegram-bridge to your `~/.claude/settings.json`:

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

### 6. Create Slash Commands

Create `~/.claude/commands/afk.md`:

```markdown
# AFK Mode

Enable AFK mode to forward Claude Code events to Telegram.

## Usage

/afk
```

Create `~/.claude/commands/back.md`:

```markdown
# Back from AFK

Disable AFK mode and return to local control.

## Usage

/back
```

## Usage

### Activate AFK Mode

In any Claude Code session:
```
/afk
```

You'll see a confirmation on Telegram: "📡 S1 — AFK Activated"

### Deactivate AFK Mode

```
/back
```

### From Telegram

When Claude needs approval for a tool call, you'll see:
```
🔐 S1 — Permission Request
Tool: Bash
`npm install express`
[✅ Approve] [❌ Deny]
```

When Claude finishes a task:
```
✅ S1 — Task Complete
I've implemented the login form...
[🛑 Let it stop]
```

Reply with text to send Claude a new instruction!

### Multi-Session

With multiple sessions, prefix instructions:
```
S1: now add unit tests
S2: push to remote
```

## File Structure

After installation:
```
~/.claude/hooks/telegram-bridge/
  hook.sh        — Bash entry point
  hook.py        — Hook logic
  bridge.py      — Telegram daemon
  config.json    — Bot token, chat_id, settings
  state.json     — Runtime state
  daemon.log     — Daemon log
  ipc/           — Per-session IPC

~/.claude/commands/
  afk.md         — /afk command
  back.md        — /back command
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `hook.sh --activate <session_id> [project]` | Activate AFK mode |
| `hook.sh --deactivate <session_id>` | Deactivate AFK mode |
| `hook.sh --status` | Show active sessions |
| `hook.sh --setup` | Configure bot token/chat_id |
| `hook.sh --help` | Show help |

## Troubleshooting

- **Daemon log**: `cat ~/.claude/hooks/telegram-bridge/daemon.log`
- **Status**: `~/.claude/hooks/telegram-bridge/hook.sh --status`
- **Manual start**: `python3 ~/.claude/hooks/telegram-bridge/bridge.py`
- **Kill daemon**: Check PID in `state.json`, then `kill <pid>`

## Dependencies

- Python 3 (stdlib only — no pip packages needed)
- bash
- Telegram bot token

## Credits

Originally built by Greg Motyl (@gmotyl).
