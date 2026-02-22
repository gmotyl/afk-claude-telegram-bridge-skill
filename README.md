# AFK Claude Telegram Bridge

Remote-control Claude Code from your phone via Telegram when you're away from your keyboard.

## Use Case

You're working on code with Claude Code, but you need to leave your desk. With this bridge, you can:

- **Approve tool calls** from your phone (Write, Bash, Edit, etc.)
- **Send instructions** and see Claude's responses directly in Telegram
- **Continue conversations** — multiple back-and-forth exchanges without touching your laptop
- **Monitor progress** via Telegram notifications
- **Run multiple sessions** concurrently with automatic topic routing

Perfect for: working on the go, meetings, or just stepping away while keeping Claude running.

## Features

- **Session Isolation** — Only the terminal that called `/afk` publishes to Telegram. Other concurrent Claude sessions are completely isolated.
- **Telegram Topics** — Each session gets its own topic/thread in a Telegram group
- **Response Forwarding** — Claude's responses appear in Telegram as chat messages
- **Conversation Chain** — Send instructions, see responses, send more — stays alive until you stop
- **Message Buffer** — Queue instructions while Claude is working, auto-delivered when idle
- **Smart Routing** — Just type in the topic, no prefixes needed
- **Auto-approve** read-only tools (Read, Glob, Grep, WebSearch, WebFetch)
- **Multi-session** support (up to 4 concurrent sessions)
- **Zero dependencies** — Python stdlib only

## Requirements

- Python 3
- bash
- Telegram Group (not private chat) with **Topics enabled**
- Bot added to the group as **Administrator**

## Installation

### 1. Create Telegram Bot

1. Open Telegram, search **@BotFather**, send `/newbot`
2. Name it "Claude Bridge" (or your preference)
3. Copy the bot token

### 2. Create a Telegram Group

1. Create a new group in Telegram
2. Add your bot to the group
3. **Make bot an Administrator**
4. **Enable Topics** in group settings
5. Send a message in the group (so the bot can detect it)

### 3. Install

```bash
git clone https://github.com/gmotyl/afk-claude-telegram-bridge.git ~/.claude/hooks/telegram-bridge
```

### 4. Run Setup

```bash
~/.claude/hooks/telegram-bridge/hook.sh --setup
```

This will:
1. Ask for your bot token
2. Auto-detect your admin groups from Telegram API
3. Auto-select if only one group (or let you choose)
4. Save config to `~/.claude/hooks/telegram-bridge/config.json`

### 5. Add Hooks to Claude Code

Edit `~/.claude/settings.json` and add the hooks:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/telegram-bridge/hook.sh",
            "timeout": 660
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/telegram-bridge/hook.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/telegram-bridge/hook.sh",
            "timeout": 360
          }
        ]
      }
    ]
  }
}
```

### 6. Add Slash Commands

Create `~/.claude/commands/afk.md`:

```markdown
---
allowed-tools: Bash
---

# AFK Mode — Activate Telegram Bridge

Enable remote control of this Claude Code session via Telegram.

## Steps

1. Generate a session ID:
   ```bash
   SESSION_ID=$(python3 -c "import uuid; print(str(uuid.uuid4())[:12])")
   echo "Session: $SESSION_ID"
   ```

2. Get the topic name (use first argument if provided, otherwise default):
   ```bash
   TOPIC_NAME="${1:=$(basename "$PWD")}"
   ```

3. Activate AFK mode:
   ```bash
   ~/.claude/hooks/telegram-bridge/hook.sh --activate "$SESSION_ID" "$(basename "$PWD")" "$TOPIC_NAME"
   ```

4. Confirm to user: "AFK mode active! Topic: TOPIC_NAME. Use /back to deactivate."
```

Create `~/.claude/commands/back.md`:

```markdown
---
allowed-tools: Bash
---

# Back — Deactivate Telegram Bridge

## Steps

1. Deactivate the active AFK session:
   ```bash
   python3 ~/.claude/hooks/telegram-bridge/hook.py deactivate "current"
   ```

2. Confirm to user: "AFK mode deactivated. Back to local control."
```

## Usage

### Activate

```
/afk              # Topic: current directory name
/afk my-project   # Topic: "my-project"
```

A new Telegram topic is created (e.g., "S1 - my-project").

### While Away

**Permission requests** appear with inline buttons:
```
🔐 Permission Request
Tool: Bash
`npm install express`
[Approve] [Deny]
```

**Task completion** shows Claude's response and waits for instructions:
```
🤖 I've implemented the login form with validation...

Reply to give next instruction...
[Let it stop]
```

**Just reply with your next instruction** — Claude processes it and sends the response back to Telegram. The conversation continues until you press "Let it stop" or the timeout expires.

### Message Buffer

If you send instructions while Claude is still working, they're queued and automatically delivered when the current task completes.

### Multiple Sessions

Open multiple terminals, each with its own `/afk`:
- Terminal 1: `/afk frontend` → Topic "S1 - frontend"
- Terminal 2: `/afk backend` → Topic "S2 - backend"

Each session is fully isolated — messages in one topic only affect that terminal.

### Deactivate

```
/back
```

Topic is automatically cleaned up from the Telegram group.

## Architecture

```
Claude Code ←→ hook.sh/hook.py ←→ IPC (filesystem) ←→ bridge.py daemon ←→ Telegram API
```

- **hook.py**: Processes Claude Code hook events, manages session binding
- **bridge.py**: Long-polling Telegram daemon, routes messages between sessions
- **IPC**: File-based communication via `~/.claude/hooks/telegram-bridge/ipc/{session_id}/`
- **Session binding**: First hook event from a Claude session binds it to its AFK slot

## Auto-Approved Tools

These tools are approved automatically without Telegram notification:

Read, Glob, Grep, WebSearch, WebFetch, TaskList, TaskGet, TaskCreate, TaskUpdate

Configure in `config.json`:
```json
{
  "auto_approve_tools": ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No messages in Telegram | Check `daemon.log`: `cat ~/.claude/hooks/telegram-bridge/daemon.log` |
| Hook not firing | Check `hook-debug.log`: `cat ~/.claude/hooks/telegram-bridge/hook-debug.log` |
| Topic not created | Ensure bot is admin with Topics permission |
| Permission timeout | Increase timeout in `settings.json` (default: 360s) |
| Daemon crashed | Restart: `python3 ~/.claude/hooks/telegram-bridge/bridge.py` |
| Check status | `~/.claude/hooks/telegram-bridge/hook.sh --status` |
| Kill daemon | `kill $(jq -r '.daemon_pid' ~/.claude/hooks/telegram-bridge/state.json)` |

## CLI Commands

| Command | Description |
|---------|-------------|
| `hook.sh --activate <session> [project] [topic]` | Enable AFK mode |
| `hook.sh --deactivate <session>` | Disable AFK mode |
| `hook.sh --status` | Show active sessions |
| `hook.sh --setup` | Configure bot token and group |
| `hook.sh --help` | Show help |

## Credits

Built by [Greg Motyl](https://github.com/gmotyl)

## Support

If you find this useful, you can [buy me a coffee](https://buymeacoffee.com/motyl.dev)!
