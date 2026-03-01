# TypeScript Rewrite Implementation Plan (FP-Corrected)

> **This is the corrected plan incorporating fp-ts backend, error handling, and side effect isolation patterns.**

**Goal:** Rewrite afk-claude-telegram-bridge from Python to TypeScript using **functional programming with fp-ts**, following pragmatic patterns from backend, side effects management, refactoring, and error handling skills.

**Architecture:**
- **Pure Core** (`src/core/`) - Business logic, state transitions, validation (100% pure)
- **Impure Adapters** (`src/adapters/`) - IPC, Telegram, filesystem (wrapped in TaskEither)
- **Orchestration** (`src/bridge/daemon.ts`, `src/hook/index.ts`) - ReaderTaskEither layer coordinating effects
- **Distribution** - Source in TS, compiled+minified to `dist/`, committed to git, npx-installable

**Tech Stack:** TypeScript 5, Node.js stdlib, esbuild, Jest + ts-jest, Husky (pre-push build)

---

## Phase 1 — Tooling Setup (COMPLETED)

✅ Task 1: Scaffold package.json, tsconfig.json, jest.config.js, build.mjs, Husky — DONE

---

## Phase 2 — Types & Error Handling

### Task 2: Create Test Helpers

**Files:**
- Create: `src/__tests__/helpers/fixtures.ts`
- Create: `src/__tests__/helpers/mockTelegram.ts`
- Create: `src/__tests__/helpers/mockFs.ts`

**Step 1: Create fixtures.ts**

```typescript
// src/__tests__/helpers/fixtures.ts
import type { State, Slot, Config } from '../../types/state'
import type { IpcEvent } from '../../types/events'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export const makeConfig = (overrides: Partial<Config> = {}): Config => ({
  botToken: 'test-token',
  chatId: '-100123',
  maxSlots: 4,
  permissionTimeout: 300,
  ...overrides,
})

export const makeSlot = (sessionId: string, overrides: Partial<Slot> = {}): Slot => ({
  sessionId,
  project: 'test-project',
  topicName: 'S1 - test-project',
  started: '2026-02-26 10:00:00',
  ...overrides,
})

export const makeState = (overrides: Partial<State> = {}): State => ({
  slots: {},
  daemonPid: null,
  daemonHeartbeat: 0,
  ...overrides,
})

export const makeTmpDir = (): { dir: string; cleanup: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bridge-test-'))
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

export const writeIpcSession = (ipcDir: string, sessionId: string, opts: {
  meta?: boolean
  kill?: boolean
  events?: IpcEvent[]
} = {}): string => {
  const sessionDir = path.join(ipcDir, sessionId)
  fs.mkdirSync(sessionDir, { recursive: true })

  if (opts.meta !== false) {
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({
      sessionId,
      slot: '1',
      project: 'test-project',
      topicName: 'S1 - test-project',
      started: '2026-02-26T10:00:00',
    }))
  }

  if (opts.kill) {
    fs.writeFileSync(path.join(sessionDir, 'kill'), 'test kill reason')
  }

  if (opts.events) {
    const lines = opts.events.map(e => JSON.stringify(e)).join('\n') + '\n'
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), lines)
  }

  return sessionDir
}
```

**Step 2: Create mockTelegram.ts** (same as before)

```typescript
// src/__tests__/helpers/mockTelegram.ts
import type { TelegramClient } from '../../types/telegram'

type Call = { method: string; args: Record<string, unknown> }

export const makeMockTelegram = (chatId = '-100123'): TelegramClient & {
  calls: Call[]
  getCalls: (method: string) => Record<string, unknown>[]
  setResponse: (method: string, response: unknown) => void
  reset: () => void
} => {
  const calls: Call[] = []
  const responses = new Map<string, unknown>()

  const defaultResponses: Record<string, unknown> = {
    createForumTopic: { ok: true, result: { message_thread_id: 1001 } },
    sendMessage:      { ok: true, result: { message_id: 2001 } },
    editMessageText:  { ok: true, result: {} },
    deleteForumTopic: { ok: true, result: true },
    answerCallbackQuery: { ok: true, result: true },
    getUpdates:       { ok: true, result: [] },
    setMyCommands:    { ok: true, result: true },
    sendChatAction:   { ok: true, result: true },
  }

  const record = (method: string, args: Record<string, unknown>) => {
    calls.push({ method, args })
    return responses.get(method) ?? defaultResponses[method] ?? { ok: true, result: {} }
  }

  return {
    chatId,
    calls,
    getCalls: (method) => calls.filter(c => c.method === method).map(c => c.args),
    setResponse: (method, response) => responses.set(method, response),
    reset: () => calls.splice(0),

    createForumTopic: (name) => record('createForumTopic', { name }) as any,
    deleteForumTopic: (threadId) => record('deleteForumTopic', { threadId }) as any,
    sendMessage: (text, opts) => record('sendMessage', { text, ...opts }) as any,
    editMessage: (messageId, text, opts) => record('editMessageText', { messageId, text, ...opts }) as any,
    answerCallback: (cqId, text) => record('answerCallbackQuery', { cqId, text }) as any,
    sendChatAction: (action, threadId) => record('sendChatAction', { action, threadId }) as any,
    getUpdates: (timeout) => record('getUpdates', { timeout }) as any,
    setMyCommands: () => record('setMyCommands', {}) as any,
  }
}
```

**Step 3: Create mockFs.ts** (same as before)

**Step 4: Commit**

```bash
git add src/__tests__/
git commit -m "test: add Jest test helpers (fixtures, mockTelegram, mockFs)"
```

---

### Task 3: Error Type Definitions (NEW - CRITICAL)

**Files:**
- Create: `src/types/errors.ts`

**Step 1: Write test first**

```typescript
// src/types/__tests__/errors.test.ts
import * as E from '../errors'

describe('Error Types', () => {
  it('IpcError has correct _tag discriminator', () => {
    const readErr = E.ipcReadError('path/to/file', new Error('ENOENT'))
    expect(readErr._tag).toBe('IpcReadError')
    expect('path' in readErr).toBe(true)
  })

  it('TelegramError has correct _tag discriminator', () => {
    const apiErr = E.telegramApiError(404, 'Chat not found')
    expect(apiErr._tag).toBe('TelegramApiError')
    expect(apiErr.status).toBe(404)
  })

  it('can fold over error union', () => {
    const errors: E.BridgeError[] = [
      E.ipcReadError('x', new Error('test')),
      E.telegramApiError(500, 'Internal'),
    ]
    const messages = errors.map(err =>
      E.errorMessage(err)
    )
    expect(messages.length).toBe(2)
  })
})
```

**Step 2: Implement errors.ts**

```typescript
// src/types/errors.ts
/**
 * @module Errors
 * Structured, tagged error types for the bridge.
 * All errors use discriminated unions with _tag field.
 */

// ============================================================================
// IPC Errors (Filesystem operations)
// ============================================================================

export type IpcReadError = {
  readonly _tag: 'IpcReadError'
  readonly path: string
  readonly cause: unknown
}

export type IpcWriteError = {
  readonly _tag: 'IpcWriteError'
  readonly path: string
  readonly cause: unknown
}

export type IpcParseError = {
  readonly _tag: 'IpcParseError'
  readonly path: string
  readonly content: string
  readonly cause: unknown
}

export type IpcError = IpcReadError | IpcWriteError | IpcParseError

export const ipcReadError = (path: string, cause: unknown): IpcReadError => ({
  _tag: 'IpcReadError',
  path,
  cause,
})

export const ipcWriteError = (path: string, cause: unknown): IpcWriteError => ({
  _tag: 'IpcWriteError',
  path,
  cause,
})

export const ipcParseError = (path: string, content: string, cause: unknown): IpcParseError => ({
  _tag: 'IpcParseError',
  path,
  content,
  cause,
})

// ============================================================================
// Telegram Errors
// ============================================================================

export type TelegramApiError = {
  readonly _tag: 'TelegramApiError'
  readonly status: number
  readonly message: string
}

export type TelegramTopicError = {
  readonly _tag: 'TelegramTopicError'
  readonly threadId: number
  readonly reason: 'deleted' | 'not_found' | 'forbidden'
}

export type TelegramError = TelegramApiError | TelegramTopicError

export const telegramApiError = (status: number, message: string): TelegramApiError => ({
  _tag: 'TelegramApiError',
  status,
  message,
})

export const telegramTopicError = (
  threadId: number,
  reason: 'deleted' | 'not_found' | 'forbidden'
): TelegramTopicError => ({
  _tag: 'TelegramTopicError',
  threadId,
  reason,
})

// ============================================================================
// State/Business Logic Errors
// ============================================================================

export type StateError = {
  readonly _tag: 'StateError'
  readonly message: string
  readonly details?: unknown
}

export type ValidationError = {
  readonly _tag: 'ValidationError'
  readonly field: string
  readonly message: string
}

export type SlotError = {
  readonly _tag: 'SlotError'
  readonly slotNum: string
  readonly message: string
}

export type BusinessError = StateError | ValidationError | SlotError

export const stateError = (message: string, details?: unknown): StateError => ({
  _tag: 'StateError',
  message,
  details,
})

export const validationError = (field: string, message: string): ValidationError => ({
  _tag: 'ValidationError',
  field,
  message,
})

export const slotError = (slotNum: string, message: string): SlotError => ({
  _tag: 'SlotError',
  slotNum,
  message,
})

// ============================================================================
// Bridge Error (Union of all error types)
// ============================================================================

export type BridgeError = IpcError | TelegramError | BusinessError

// ============================================================================
// Error Message Generation (for logging/response)
// ============================================================================

export const errorMessage = (error: BridgeError): string => {
  switch (error._tag) {
    case 'IpcReadError':
      return `Failed to read ${error.path}: ${String(error.cause)}`
    case 'IpcWriteError':
      return `Failed to write ${error.path}: ${String(error.cause)}`
    case 'IpcParseError':
      return `Failed to parse ${error.path}: ${String(error.cause)}`
    case 'TelegramApiError':
      return `Telegram API error (${error.status}): ${error.message}`
    case 'TelegramTopicError':
      return `Topic ${error.threadId} ${error.reason}`
    case 'StateError':
      return `State error: ${error.message}`
    case 'ValidationError':
      return `Validation failed on ${error.field}: ${error.message}`
    case 'SlotError':
      return `Slot ${error.slotNum} error: ${error.message}`
  }
}

export const errorStatusCode = (error: BridgeError): number => {
  switch (error._tag) {
    case 'IpcReadError':
    case 'IpcWriteError':
    case 'IpcParseError':
      return 500  // Internal error
    case 'TelegramApiError':
      return error.status
    case 'TelegramTopicError':
      return 404  // Topic deleted or not found
    case 'StateError':
      return 500
    case 'ValidationError':
      return 400
    case 'SlotError':
      return 400
  }
}
```

**Step 3: Run test**

```bash
npm test -- src/types/__tests__/errors.test.ts
```

Expected: PASS

**Step 4: Commit**

```bash
git add src/types/
git commit -m "feat: add structured error types with discriminators

- IpcError (read, write, parse)
- TelegramError (api, topic)
- BusinessError (state, validation, slot)
- BridgeError union covers all cases
- errorMessage() and errorStatusCode() helpers

All errors use _tag discriminator for type-safe pattern matching."
```

---

### Task 4: Core Types (Config, State, Events, Telegram)

Same as before, but now we import error types:

```typescript
// src/types/index.ts - Re-export all types
export * from './config'
export * from './state'
export * from './events'
export * from './telegram'
export * from './result'
export * from './errors'
```

---

### Task 5: Result Type + Pipe Utility

Same as original plan.

---

## Phase 3 — Pure Business Logic

### Task 6: State Module (Pure Functions)

State transitions, slot management, cleanup logic — all pure.

```typescript
// src/core/state/index.ts
import * as E from 'fp-ts/Either'
import type { State, Slot } from '../../types/state'
import * as Errors from '../../types/errors'

// Pure: Determine if slot is active
export const isSlotActive = (
  slot: Slot,
  heartbeatTimeoutMs: number,
  now: Date
): boolean => {
  const slotTime = new Date(slot.started).getTime()
  return (now.getTime() - slotTime) < heartbeatTimeoutMs
}

// Pure: Add slot to state
export const addSlot = (
  state: State,
  slotNum: string,
  slot: Slot
): E.Either<Errors.SlotError, State> =>
  slotNum in state.slots
    ? E.left(Errors.slotError(slotNum, `Slot ${slotNum} already occupied`))
    : E.right({
        ...state,
        slots: { ...state.slots, [slotNum]: slot },
      })

// Pure: Remove slot from state
export const removeSlot = (state: State, slotNum: string): State => ({
  ...state,
  slots: Object.fromEntries(
    Object.entries(state.slots).filter(([k]) => k !== slotNum)
  ),
})

// Pure: Cleanup stale slots
export const cleanupStaleSlots = (
  state: State,
  heartbeatTimeoutMs: number,
  now: Date
): State => ({
  ...state,
  slots: Object.fromEntries(
    Object.entries(state.slots)
      .filter(([, slot]) => isSlotActive(slot, heartbeatTimeoutMs, now))
  ),
})
```

---

## Phase 4 — Impure Adapters (Wrapped in TaskEither)

### Task 7: IPC Module (TaskEither)

```typescript
// src/adapters/ipc/index.ts
import * as TE from 'fp-ts/TaskEither'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as Errors from '../../types/errors'
import type { IpcEvent } from '../../types/events'

export interface IpcClient {
  readEvents: (sessionId: string) => TE.TaskEither<Errors.IpcError, IpcEvent[]>
  writeState: (data: unknown) => TE.TaskEither<Errors.IpcError, void>
  readState: () => TE.TaskEither<Errors.IpcError, unknown>
}

export const createIpcClient = (baseDir: string): IpcClient => ({
  readEvents: (sessionId) =>
    pipe(
      TE.tryCatch(
        () => fs.readFile(path.join(baseDir, sessionId, 'events.jsonl'), 'utf8'),
        (cause) => Errors.ipcReadError(path.join(baseDir, sessionId, 'events.jsonl'), cause)
      ),
      TE.chainEitherK((content) =>
        pipe(
          content.split('\n').filter(Boolean),
          A.traverse(E.Applicative)((line) =>
            E.tryCatch(
              () => JSON.parse(line),
              (cause) => Errors.ipcParseError(
                path.join(baseDir, sessionId, 'events.jsonl'),
                line,
                cause
              )
            )
          )
        )
      )
    ),

  writeState: (data) =>
    TE.tryCatch(
      () => fs.writeFile(path.join(baseDir, 'state.json'), JSON.stringify(data, null, 2)),
      (cause) => Errors.ipcWriteError(path.join(baseDir, 'state.json'), cause)
    ),

  readState: () =>
    pipe(
      TE.tryCatch(
        () => fs.readFile(path.join(baseDir, 'state.json'), 'utf8'),
        (cause) => Errors.ipcReadError(path.join(baseDir, 'state.json'), cause)
      ),
      TE.chainEitherK((content) =>
        E.tryCatch(
          () => JSON.parse(content),
          (cause) => Errors.ipcParseError(path.join(baseDir, 'state.json'), content, cause)
        )
      )
    ),
})
```

---

## Phase 5 — Orchestration Layer (ReaderTaskEither)

### Task 8: Daemon Orchestration (RTE)

```typescript
// src/bridge/daemon.ts
import * as RTE from 'fp-ts/ReaderTaskEither'
import * as TE from 'fp-ts/TaskEither'
import { pipe } from 'fp-ts/function'
import * as Errors from '../types/errors'
import type { IpcClient } from '../adapters/ipc'
import type { TelegramClient } from '../types/telegram'

// Dependencies injected at runtime
type DaemonDeps = {
  ipc: IpcClient
  telegram: TelegramClient
  clock: { now: () => Date }
  logger: { info: (msg: string) => void; error: (msg: string) => void }
}

type Daemon = RTE.ReaderTaskEither<DaemonDeps, Errors.BridgeError, void>

// One iteration of daemon loop
const processOnce: Daemon = pipe(
  RTE.ask<DaemonDeps>(),
  RTE.flatMap(deps =>
    pipe(
      // Read events
      deps.ipc.readEvents('session-1'),
      TE.map(events => ({
        count: events.length,
        events,
      })),
      // Log
      TE.tap(result =>
        TE.fromIO(() => deps.logger.info(`Processed ${result.count} events`))
      )
    )
  )
)

// Main loop (recursive)
const mainLoop = (iterations: number): Daemon =>
  iterations <= 0
    ? RTE.right(undefined)
    : pipe(
        processOnce,
        RTE.chain(() => mainLoop(iterations - 1))
      )

// Entry point for testing and execution
export const runDaemon = (deps: DaemonDeps, iterations: number): TE.TaskEither<Errors.BridgeError, void> =>
  mainLoop(iterations)(deps)
```

---

## Summary of Key Changes

| Aspect | Original Plan | FP-Corrected Plan |
|--------|---------------|-------------------|
| Error Handling | Mentions Result<T,E> | Explicit structured error types with discriminators |
| Async Operations | Promises implicit | All wrapped in TaskEither |
| Dependency Injection | Mentioned but vague | Explicit RTE pattern with DaemonDeps |
| Side Effect Isolation | Isolated to boundaries | Clear adapters/ vs core/ structure |
| Error Propagation | Unclear | Type-tracked through Either/TaskEither chains |
| Testing | Possible | Trivial with injected mocks |

---

## Next Steps

1. ✅ Task 1: Toolchain — COMPLETE
2. → Task 2: Test helpers — START
3. → Task 3: Error types — NEW (CRITICAL)
4. → Tasks 4-5: Core types + Result
5. → Task 6: Pure state logic
6. → Task 7: IPC adapter (TaskEither)
7. → Task 8: Telegram adapter (TaskEither)
8. → Task 9: Daemon orchestration (RTE)
9. → Task 10: Hook orchestration (RTE)
10. → Integration + PR
