---
name: afk
description: "Activate Telegram Bridge for remote Claude Code control. Use when user wants to go AFK, enable remote approval of permissions from phone, or forward Claude output to Telegram."
user_invocable: true
allowed-tools: Bash
---

# AFK Mode — Activate Telegram Bridge

Enable remote control of this Claude Code session via Telegram.
When AFK mode is active, permission requests will appear in Telegram for approval, and you can send instructions from your phone.

## Usage

```bash
/afk                    # Default: uses current directory name as topic
/afk custom-topic-name  # Custom: uses "custom-topic-name" as topic name
```

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
   "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/hooks/telegram-bridge/hook.sh --activate "$SESSION_ID" "$(basename "$PWD")" "$TOPIC_NAME"
   ```

4. Confirm to user: "AFK mode active! Permission requests will appear on Telegram. Topic: TOPIC_NAME. Use /back to deactivate."
