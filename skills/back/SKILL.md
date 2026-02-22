---
name: back
description: "Deactivate Telegram Bridge and return to local control. Use when user is back at keyboard and wants to stop forwarding to Telegram."
user_invocable: true
allowed-tools: Bash
---

# Back — Deactivate Telegram Bridge

Disable AFK mode. Stop forwarding events to Telegram.

## Steps

1. Deactivate the active AFK session:
   ```bash
   python3 "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/hooks/telegram-bridge/hook.py deactivate "current"
   ```

2. Confirm to user: "AFK mode deactivated. Back to local control."
