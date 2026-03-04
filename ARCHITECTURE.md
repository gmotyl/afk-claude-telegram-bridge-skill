# Architecture Documentation

## Overview

**afk-claude-telegram-bridge** is a remote-control system that enables controlling Claude Code from Telegram when away from keyboard (AFK). It consists of two main components:

1. **Hook** - Runs as a Claude Code hook, intercepts tool calls and sends permission requests to Telegram
2. **Daemon** - Long-running process that polls Telegram for responses and forwards them back to the hook

The system uses file-based IPC for communication between hook and daemon, with Telegram as the user interface.

## Functional Areas

### `src/hook/`
Claude Code hook implementation. Entry point for all hook events.

- **index.ts** - Main hook orchestrator: parses args, resolves session, dispatches to handlers
- **args.ts** - Parses CLI arguments and stdin JSON from Claude Code
- **permission.ts** - Handles permission request events, sends to daemon via IPC
- **stop.ts** - Handles stop events, polls daemon for instructions

### `src/bridge/`
Telegram bridge daemon. Long-running process that manages Telegram communication.

- **daemon.ts** - Main daemon loop: polls Telegram, processes updates, manages slots and state
- Handles permission batching, trust system, and queued instructions

### `src/services/`
Shared services used by both hook and daemon.

| Service | Purpose |
|---------|---------|
| **ipc.ts** | File-based IPC: writeEventAtomic, readEventQueue, writeResponse |
| **telegram.ts** | Telegram Bot API wrapper: sendMessage, answerCallbackQuery, etc. |
| **telegram-poller.ts** | Long-polling for Telegram updates |
| **state-persistence.ts** | Read/write persistent state.json |
| **session-binding.ts** | Bind AFK sessions to IPC directories |
| **daemon-health.ts** | Monitor daemon health, auto-restart if needed |
| **daemon-launcher.ts** | Spawn daemon process |
| **queued-instruction.ts** | Queue instructions for injection when Claude resumes |

### `src/core/`
Core domain logic.

- **state/** - Pure state transitions: addSlot, removeSlot, heartbeatSlot, etc.
- **config/** - Configuration loading and validation

### `src/types/`
TypeScript type definitions and error types.

- **config.ts** - Config interface
- **state.ts** - State, Slot, PendingStop types
- **events.ts** - IpcEvent, StopEvent types
- **errors.ts** - Error constructors (HookError, BridgeError, etc.)

### `src/cli/`
CLI entry points for activate/deactivate commands.

---

## Key Execution Flows

### 1. Permission Request Flow (RunHook → Telegram)

```
runHook
  → parseHookArgs           # Parse CLI/stdin
  → loadConfig              # Load bot token, group ID
  → ensureDaemonAlive       # Start daemon if needed
  → resolveSession          # Find bound session or create new
  → handlePermissionRequest
    → writeEventAtomic     # Write to event-{uuid}.jsonl (IPC)
    → pollForResponse      # Wait for response-{uuid}.json
    → return permission decision to Claude Code
```

### 2. Stop/Instruction Flow (Claude Stop → Telegram)

```
handleStop
  → handleStopRequest
    → writeEventAtomic     # Write stop event to IPC
    → pollForInstruction  # Poll for queued instructions
      → readQueuedInstruction
      → writeResponse     # Write response to daemon
```

### 3. Daemon Telegram Poll Loop

```
runDaemonIteration
  → pollAndRouteUpdates
    → pollTelegram        # Long-poll Telegram
    → processIncomingMessage  # New messages → create slot
    → handleCallbackQuery     # Button clicks → resolve permission/stop
  → processEventSideEffects
    → Permission batching
    → Auto-approve for trusted sessions
```

### 4. Session Binding Flow

```
resolveSession
  → findBoundSession      # Check if session already bound
  → findUnboundSession   # Find free slot if not
  → bindSession          # Create binding in state
```

---

## System Architecture Diagram

```mermaid
flowchart TB
    subgraph Claude["Claude Code"]
        Hook[Hook Script]
    end

    subgraph Bridge["Telegram Bridge"]
        Daemon[Daemon Process]
        State[State.json]
    end

    subgraph IPC["IPC Layer (File-based)"]
        Events[event-{uuid}.jsonl]
        Responses[response-{uuid}.json]
        Instructions[queued-instructions.json]
    end

    subgraph Telegram["Telegram"]
        BotAPI[Telegram Bot API]
        Group[Group Chat]
        Topics[Forum Topics]
    end

    Hook -->|1. Parse args| Hook
    Hook -->|2. Ensure alive| Daemon
    Hook -->|3. Write event| Events
    Events -->|4. Read events| Daemon
    Daemon -->|5. Poll updates| BotAPI
    BotAPI -->|6. Updates| Daemon
    Daemon -->|7. Write response| Responses
    Responses -->|8. Read response| Hook
    Daemon -->|9. Manage| State
    Daemon -->|10. Messages| Topics
    Topics -->|11. User input| BotAPI
```

### Data Flow Summary

| Step | Component | Action |
|------|-----------|--------|
| 1 | Hook | Claude Code triggers hook (PreToolUse, Stop, etc.) |
| 2 | Hook | Parse arguments, load config |
| 3 | Hook | Ensure daemon is running (start if not) |
| 4 | Hook | Write event to unique file (eliminates race conditions) |
| 5 | Daemon | Reads event files, processes permission/request |
| 6 | Daemon | Polls Telegram for user responses |
| 7 | Telegram | User approves/denies or sends instruction |
| 8 | Daemon | Writes response to response-{uuid}.json |
| 9 | Hook | Reads response, returns to Claude Code |

### Key Design Decisions

1. **File-based IPC** - Uses filesystem for hook↔daemon communication (simple, reliable)
2. **Atomic event writes** - Each event written to unique file to prevent race conditions
3. **Permission batching** - Multiple permissions buffered and sent as single Telegram message
4. **Session trust** - After N approvals, session becomes "trusted" (auto-approve)
5. **Forum topics** - Each slot gets its own Telegram forum topic for isolation
6. **Slot-based multi-session** - Single daemon manages multiple concurrent Claude sessions
