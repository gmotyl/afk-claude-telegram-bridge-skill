# Design: Dual-Deployment TypeScript Rewrite (Phases 3-5)

**Date:** 2026-02-26
**Branch:** `feature/ts-rewrite`
**Phase:** Completing full TypeScript rewrite with safe dual-deployment testing

---

## Overview

Complete the TypeScript rewrite (Phases 3, 4, 5) with a dual-deployment strategy that allows testing the new version independently without touching the current Python implementation. Once fully validated for feature parity, atomically switch to TypeScript.

---

## Goals

1. ✅ Implement daemon (Phase 3) with 100% Python feature parity
2. ✅ Implement hook (Phase 4) with 100% Python feature parity
3. ✅ Create deployment scripts (Phase 5) for safe testing and rollback
4. ✅ Run TS and Python simultaneously during validation
5. ✅ Zero-downtime switchover once validated

---

## Architecture

### Deployment Model

Two independent installations, testing in parallel:

```
~/.claude/hooks/telegram-bridge/          ← Python (current, stable)
  hook.sh → hook.py → bridge.py
  config.json, state.json (Python state)

~/.claude/hooks/telegram-bridge-ts/       ← TypeScript (new, being tested)
  hook.sh → dist/hook.js → dist/bridge.js
  config.json, state.json (TS state)
```

**Key principle:** Code is location-agnostic. No branching logic for "which version am I?" — both versions read from their respective directories and work identically.

### How Claude Code Switches Versions

The hook path in `~/.claude/settings.json` determines which version runs:

```json
{
  "hooks": {
    "PermissionRequest": {
      "hook": "~/.claude/hooks/telegram-bridge/hook.sh",  ← THIS PATH
      "timeout": 360
    }
  }
}
```

**During testing:** Points to `~/.claude/hooks/telegram-bridge/hook.sh` (Python)
**After switchover:** Points to `~/.claude/hooks/telegram-bridge-ts/hook.sh` (TypeScript)

---

## Phase Breakdown

### Phase 3: Full Daemon Implementation

**File:** `src/bridge/daemon.ts`

**Responsibilities (replicate `bridge.py` exactly):**
- Load config from JSON
- Connect to Telegram Bot API
- Process IPC event queue (events.jsonl)
- Send permission requests and notifications
- Handle Telegram message callbacks
- Persist state (config.json, state.json)
- Manage heartbeat loop (cleanup stale slots)
- Error recovery and logging

**Input/Output:**
- Reads: `~/.claude/hooks/telegram-bridge-ts/config.json`
- Reads/Writes: `~/.claude/hooks/telegram-bridge-ts/state.json`
- Reads: `~/.claude/hooks/telegram-bridge-ts/ipc/events.jsonl`
- Writes: Telegram API calls
- Logs: `~/.claude/hooks/telegram-bridge-ts/daemon.log`

**Testing:** Daemon starts, processes events, responds to Telegram

### Phase 4: Full Hook Implementation

**File:** `src/hook/index.ts`

**Responsibilities (replicate `hook.py` exactly):**
- Parse Claude Code hook invocation
- Handle three hook types: PermissionRequest, Stop, Notification
- Write to IPC event queue (events.jsonl)
- Format permission request and send via daemon
- Wait for approval/denial response
- Exit with appropriate status code

**Input/Output:**
- Reads: Claude Code hook environment/stdin
- Reads/Writes: `~/.claude/hooks/telegram-bridge-ts/ipc/events.jsonl`
- Communicates: With daemon via IPC
- Returns: Exit code + response

**Testing:** Hook intercepts Claude calls, sends permissions, returns responses

### Phase 5: Deployment & Switching Scripts

**Scripts to create:**

1. **`scripts/install-ts.sh`**
   - Build TypeScript: `npm run build`
   - Create `~/.claude/hooks/telegram-bridge-ts/` directory
   - Copy dist/hook.js, dist/bridge.js, hook.sh wrapper
   - Copy config.json template (same structure as Python version)
   - Creates empty state.json and ipc/ directory
   - Does NOT modify settings.json yet

2. **`scripts/switch-to-ts.sh`**
   - Verify TS version is installed
   - Update `~/.claude/settings.json`: change hook path to telegram-bridge-ts
   - Print: "⚠️  Switched to TypeScript. Monitor daemon.log for errors."

3. **`scripts/switch-to-python.sh`**
   - Update `~/.claude/settings.json`: change hook path back to telegram-bridge
   - Print: "✅ Reverted to Python version."

**No automatic config migration** — both versions read from their own directories

---

## Testing & Validation

### Pre-Switchover (Python Active)

1. Install TS version: `scripts/install-ts.sh`
2. Python version continues running normally
3. Manually test TS version:
   - `~/.claude/hooks/telegram-bridge-ts/hook.sh --status`
   - Send test messages via Telegram
   - Verify daemon log: `tail -f ~/.claude/hooks/telegram-bridge-ts/daemon.log`

### Switchover (Atomic)

```bash
scripts/switch-to-ts.sh
# Next Claude Code session uses TS version
```

### Post-Switchover (TS Active)

1. Run 1-2 hours of normal work
2. Monitor: `tail -f ~/.claude/hooks/telegram-bridge-ts/daemon.log`
3. Test all scenarios:
   - Permission approval via Telegram
   - Permission denial
   - Error recovery
   - Multi-session slot management

### Rollback (If Issues)

```bash
scripts/switch-to-python.sh
# Instant revert to Python
# Next Claude Code session uses Python again
```

---

## Feature Parity Checklist

**Daemon (Phase 3):**
- [ ] Config loading (bot token, chat_id)
- [ ] Telegram API connection
- [ ] Event queue processing (events.jsonl)
- [ ] Permission request formatting and sending
- [ ] Response handling (approve/deny)
- [ ] State persistence
- [ ] Heartbeat loop
- [ ] Cleanup stale slots
- [ ] Error logging

**Hook (Phase 4):**
- [ ] PermissionRequest hook handling
- [ ] Stop hook handling
- [ ] Notification hook handling
- [ ] IPC event writing
- [ ] Slot management (reserve/release)
- [ ] Status codes and exit handling

**Deployment (Phase 5):**
- [ ] Install script creates proper directory structure
- [ ] Config template matches Python version
- [ ] Switch scripts update settings.json correctly
- [ ] Rollback works instantly

---

## File Structure (After Phase 5)

```
repo/
  src/
    bridge/
      daemon.ts          ← Phase 3 (full implementation)
      __tests__/
        daemon.test.ts   ← Comprehensive tests
    hook/
      index.ts           ← Phase 4 (full implementation)
      __tests__/
        index.test.ts    ← Comprehensive tests
    types/
      (already complete from Phase 2)

  scripts/
    install-ts.sh        ← Phase 5
    switch-to-ts.sh      ← Phase 5
    switch-to-python.sh  ← Phase 5

  dist/
    hook.js              ← Built from src/hook/index.ts
    bridge.js            ← Built from src/bridge/daemon.ts
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| TS version breaks permission flow | Dual deployment — Python still runs |
| State corruption during migration | Separate state.json files (no migration) |
| Telegram API changes | Both versions isolated (easy to revert) |
| Unknown edge cases | 1-2 hours of live testing before full commitment |
| Accidental settings.json corruption | Version control + atomic switch scripts |

---

## Success Criteria

✅ **Phase 3 Complete:**
- Daemon runs without errors
- Processes events correctly
- Sends Telegram messages
- 100% test coverage

✅ **Phase 4 Complete:**
- Hook intercepts Claude calls
- Permission requests appear on Telegram
- Approvals/denials work
- 100% test coverage

✅ **Phase 5 Complete:**
- Install script runs without errors
- Switch script updates settings.json
- TS version runs for 1+ hours without issues
- Rollback works instantly

✅ **Feature Parity Validated:**
- All scenarios from Python version work in TS
- No functional regressions
- Ready for permanent switchover

---

## Next Steps

1. **Invoke writing-plans skill** to create detailed implementation plan
2. **Execute Phase 3** (daemon implementation)
3. **Execute Phase 4** (hook implementation)
4. **Execute Phase 5** (deployment scripts)
5. **Run full validation** (1-2 hours parallel testing)
6. **Switchover** (atomic update to TS version)
7. **Commit and cleanup** (merge feature/ts-rewrite to main)

---

**Approved:** 2026-02-26
**Status:** Ready for implementation planning
