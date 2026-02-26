# TypeScript Rewrite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite afk-claude-telegram-bridge from Python to TypeScript, eliminating the Python runtime dependency while keeping the IPC protocol identical and porting all 106 tests.

**Architecture:** Pragmatic FP — pure functions with `Result<T,E>` error handling, immutable `readonly` state, side effects isolated to `bridge/daemon.ts` and hook entry points. Each module is a folder of focused files; tests live in `__tests__/` next to source. esbuild bundles `src/hook/` and `src/bridge/daemon.ts` into `dist/hook.js` and `dist/bridge.js`, committed to git.

**Tech Stack:** TypeScript 5, Node.js stdlib (https, fs, path, child_process, os), esbuild (build only), Jest + ts-jest (tests only), Husky (pre-push build hook).

---

## Phase 1 — Tooling Setup

### Task 1: Rename branch + scaffold package.json

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `jest.config.ts`

**Step 1: Create package.json**

```json
{
  "name": "afk-claude-telegram-bridge",
  "version": "2.0.0",
  "description": "Remote-control Claude Code from Telegram when AFK",
  "bin": {
    "afk-claude-telegram-bridge": "dist/hook.js"
  },
  "scripts": {
    "build": "node build.mjs",
    "test": "jest",
    "test:watch": "jest --watch",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.0.0",
    "esbuild": "^0.20.0",
    "husky": "^9.0.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.4.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "lib": ["ES2022"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/__tests__/**"]
}
```

**Step 3: Create jest.config.ts**

```typescript
import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/__tests__/**'],
}

export default config
```

**Step 4: Create build.mjs**

```javascript
import * as esbuild from 'esbuild'

await Promise.all([
  esbuild.build({
    entryPoints: ['src/hook/index.ts'],
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/hook.js',
    banner: { js: '#!/usr/bin/env node' },
  }),
  esbuild.build({
    entryPoints: ['src/bridge/daemon.ts'],
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/bridge.js',
    banner: { js: '#!/usr/bin/env node' },
  }),
])
console.log('Build complete')
```

**Step 5: Install deps**

```bash
cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge
npm install
```

Expected: `node_modules/` created, no errors.

**Step 6: Setup Husky**

```bash
npx husky init
```

Then write `.husky/pre-push`:
```bash
#!/bin/sh
npm run build
git add dist/
```

**Step 7: Verify build runs**

```bash
npm run build
```

Expected: `dist/hook.js` and `dist/bridge.js` created (will be stubs until src exists — create empty `src/hook/index.ts` and `src/bridge/daemon.ts` first).

**Step 8: Commit**

```bash
git add package.json tsconfig.json jest.config.ts build.mjs .husky/ .gitignore
git commit -m "chore: add TypeScript + esbuild + Jest toolchain"
```

---

### Task 2: Create test helpers

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

**Step 2: Create mockTelegram.ts**

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

**Step 3: Create mockFs.ts**

```typescript
// src/__tests__/helpers/mockFs.ts
import * as fs from 'fs'
import * as path from 'path'
import { makeTmpDir } from './fixtures'

export type TmpBridgeDir = {
  bridgeDir: string
  ipcDir: string
  statePath: string
  configPath: string
  writeState: (state: object) => void
  readState: () => object
  cleanup: () => void
}

export const makeTmpBridgeDir = (): TmpBridgeDir => {
  const { dir, cleanup } = makeTmpDir()
  const bridgeDir = path.join(dir, '.claude', 'hooks', 'telegram-bridge')
  const ipcDir = path.join(bridgeDir, 'ipc')
  fs.mkdirSync(ipcDir, { recursive: true })

  const statePath = path.join(bridgeDir, 'state.json')
  const configPath = path.join(bridgeDir, 'config.json')

  fs.writeFileSync(configPath, JSON.stringify({
    botToken: 'test-token', chatId: '-100123',
  }))

  return {
    bridgeDir, ipcDir, statePath, configPath,
    writeState: (state) => fs.writeFileSync(statePath, JSON.stringify(state)),
    readState: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    cleanup,
  }
}
```

**Step 4: Run typecheck to confirm helpers compile**

```bash
npx tsc --noEmit
```

Expected: Errors about missing types (types don't exist yet) — that's fine, just ensure no syntax errors.

**Step 5: Commit**

```bash
git add src/__tests__/
git commit -m "test: add Jest test helpers (mockTelegram, mockFs, fixtures)"
```

---

## Phase 2 — Types + Core Modules (TDD)

### Task 3: Result type + pipe utility

**Files:**
- Create: `src/types/result.ts`
- Create: `src/types/result/__tests__/result.test.ts`

**Step 1: Write failing test**

```typescript
// src/types/__tests__/result.test.ts
import { ok, err, pipe, isOk, isErr, unwrap } from '../result'

describe('Result', () => {
  it('ok wraps a value', () => {
    const r = ok(42)
    expect(r).toEqual({ ok: true, value: 42 })
  })

  it('err wraps an error', () => {
    const r = err('oops')
    expect(r).toEqual({ ok: false, error: 'oops' })
  })

  it('isOk / isErr narrow type', () => {
    expect(isOk(ok(1))).toBe(true)
    expect(isErr(ok(1))).toBe(false)
    expect(isErr(err('x'))).toBe(true)
  })

  it('unwrap returns value or throws', () => {
    expect(unwrap(ok('hello'))).toBe('hello')
    expect(() => unwrap(err('bad'))).toThrow('bad')
  })

  it('pipe chains functions left to right', () => {
    const result = pipe(
      2,
      (x: number) => x + 1,
      (x: number) => x * 3,
    )
    expect(result).toBe(9)
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/types/__tests__/result.test.ts
```

Expected: `Cannot find module '../result'`

**Step 3: Implement result.ts**

```typescript
// src/types/result.ts
export type Result<T, E = Error> =
  | { ok: true;  value: T }
  | { ok: false; error: E }

export const ok  = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export const isOk  = <T, E>(r: Result<T, E>): r is { ok: true;  value: T } => r.ok
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok

export const unwrap = <T>(r: Result<T, unknown>): T => {
  if (r.ok) return r.value
  throw new Error(String((r as any).error))
}

export const pipe = <T>(value: T, ...fns: Array<(v: any) => any>): any =>
  fns.reduce((v, f) => f(v), value)
```

**Step 4: Run test — expect PASS**

```bash
npm test -- src/types/__tests__/result.test.ts
```

**Step 5: Commit**

```bash
git add src/types/
git commit -m "feat: add Result<T,E> type and pipe utility"
```

---

### Task 4: State + Config types

**Files:**
- Create: `src/types/state.ts`
- Create: `src/types/events.ts`
- Create: `src/types/telegram.ts`
- Create: `src/types/config.ts`

**Step 1: Create all type files (no tests — pure types)**

```typescript
// src/types/config.ts
export type Config = Readonly<{
  botToken:                    string
  chatId:                      string
  maxSlots?:                   number
  permissionTimeout?:          number
  keepAlivePollSeconds?:       number
  autoApproveTools?:           string[]
  autoApprovePaths?:           string[]
  idlePingHours?:              number
  contextWarningThreshold?:    number
  sessionTrustThreshold?:      number
  staleWarningSeconds?:        number
  permissionBatchWindowSeconds?: number
}>
```

```typescript
// src/types/state.ts
export type Slot = Readonly<{
  sessionId:  string
  project:    string
  topicName:  string
  started:    string
  threadId?:  number
}>

export type State = Readonly<{
  slots:            Readonly<Record<string, Slot>>
  daemonPid:        number | null
  daemonHeartbeat:  number
}>

export const emptyState = (): State => ({
  slots: {},
  daemonPid: null,
  daemonHeartbeat: 0,
})

// Pure state transitions
export const withSlot = (state: State, slotNum: string, slot: Slot): State => ({
  ...state, slots: { ...state.slots, [slotNum]: slot },
})

export const withoutSlot = (state: State, slotNum: string): State => ({
  ...state,
  slots: Object.fromEntries(Object.entries(state.slots).filter(([k]) => k !== slotNum)),
})

export const withDaemon = (state: State, pid: number, heartbeat: number): State => ({
  ...state, daemonPid: pid, daemonHeartbeat: heartbeat,
})

export const withHeartbeat = (state: State, heartbeat: number): State => ({
  ...state, daemonHeartbeat: heartbeat,
})
```

```typescript
// src/types/events.ts
export type ActivationEvent = Readonly<{
  id: string; type: 'activation'
  slot: string; project: string; topicName: string
  sessionId: string; timestamp: number
  reuseThreadId?: number
}>

export type DeactivationEvent = Readonly<{
  id: string; type: 'deactivation'
  slot: string; sessionId: string; timestamp: number
}>

export type PermissionEvent = Readonly<{
  id: string; type: 'permission_request'
  toolName: string; toolInput: Record<string, unknown>
  description: string; sessionId: string; timestamp: number
}>

export type StopEvent = Readonly<{
  id: string; type: 'stop'
  lastMessage: string; sessionId: string
  stopHookActive: boolean; timestamp: number
}>

export type NotificationEvent = Readonly<{
  id: string; type: 'notification'
  notificationType: string; message: string
  title: string; sessionId: string; timestamp: number
}>

export type KeepAliveEvent = Readonly<{
  id: string; type: 'keep_alive'
  sessionId: string; originalEventId: string; timestamp: number
}>

export type ResponseEvent = Readonly<{
  id: string; type: 'response'
  text: string; sessionId: string; timestamp: number
}>

export type IpcEvent =
  | ActivationEvent | DeactivationEvent | PermissionEvent
  | StopEvent | NotificationEvent | KeepAliveEvent | ResponseEvent
```

```typescript
// src/types/telegram.ts
export type TgResult<T> = { ok: true; result: T } | { ok: false; description: string; topic_deleted?: boolean }

export type TgMessage = Readonly<{ message_id: number; chat: { id: string }; message_thread_id?: number; text?: string }>
export type TgCallbackQuery = Readonly<{ id: string; data?: string; message?: TgMessage }>
export type TgUpdate = Readonly<{ update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery }>
export type TgForumTopic = Readonly<{ message_thread_id: number; name: string }>

export type TelegramClient = {
  readonly chatId: string
  createForumTopic: (name: string) => Promise<TgResult<TgForumTopic>>
  deleteForumTopic: (threadId: number) => Promise<TgResult<boolean>>
  sendMessage: (text: string, opts?: { threadId?: number; replyMarkup?: unknown; parseMode?: string }) => Promise<TgResult<TgMessage>>
  editMessage: (messageId: number, text: string, opts?: { replyMarkup?: unknown }) => Promise<TgResult<TgMessage>>
  answerCallback: (cqId: string, text?: string) => Promise<TgResult<boolean>>
  sendChatAction: (action: string, threadId?: number) => Promise<TgResult<boolean>>
  getUpdates: (timeout?: number) => Promise<TgUpdate[]>
  setMyCommands: () => Promise<TgResult<boolean>>
}
```

**Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: No errors (types only, nothing imports them yet).

**Step 3: Commit**

```bash
git add src/types/
git commit -m "feat: add core types (State, Slot, IpcEvent, TelegramClient, Config)"
```

---

### Task 5: State module — load/save

**Files:**
- Create: `src/state/load.ts`
- Create: `src/state/save.ts`
- Create: `src/state/__tests__/load.test.ts`
- Create: `src/state/__tests__/save.test.ts`

**Step 1: Write failing tests**

```typescript
// src/state/__tests__/load.test.ts
import * as fs from 'fs'
import * as path from 'path'
import { makeTmpBridgeDir } from '../../__tests__/helpers/mockFs'
import { loadState, loadConfig } from '../load'
import { emptyState } from '../../types/state'

describe('loadState', () => {
  it('returns emptyState when file missing', () => {
    const { bridgeDir, cleanup } = makeTmpBridgeDir()
    const result = loadState(path.join(bridgeDir, 'nonexistent.json'))
    expect(result).toEqual(emptyState())
    cleanup()
  })

  it('returns emptyState on malformed JSON', () => {
    const { bridgeDir, statePath, cleanup } = makeTmpBridgeDir()
    fs.writeFileSync(statePath, 'not json')
    expect(loadState(statePath)).toEqual(emptyState())
    cleanup()
  })

  it('loads valid state', () => {
    const { statePath, writeState, cleanup } = makeTmpBridgeDir()
    const state = { slots: { '1': { sessionId: 'abc', project: 'p', topicName: 't', started: 's' } }, daemonPid: 123, daemonHeartbeat: 999 }
    writeState(state)
    expect(loadState(statePath)).toEqual(state)
    cleanup()
  })
})

describe('loadConfig', () => {
  it('returns empty object when file missing', () => {
    expect(loadConfig('/nonexistent/path/config.json')).toEqual({})
  })

  it('loads valid config', () => {
    const { configPath, cleanup } = makeTmpBridgeDir()
    expect(loadConfig(configPath)).toMatchObject({ botToken: 'test-token' })
    cleanup()
  })
})
```

```typescript
// src/state/__tests__/save.test.ts
import * as fs from 'fs'
import * as path from 'path'
import { makeTmpBridgeDir } from '../../__tests__/helpers/mockFs'
import { saveState, atomicWrite } from '../save'
import { emptyState } from '../../types/state'

describe('atomicWrite', () => {
  it('writes file contents atomically', () => {
    const { bridgeDir, cleanup } = makeTmpBridgeDir()
    const target = path.join(bridgeDir, 'out.json')
    atomicWrite(target, '{"hello":1}')
    expect(fs.readFileSync(target, 'utf8')).toBe('{"hello":1}')
    cleanup()
  })

  it('no .tmp file left after write', () => {
    const { bridgeDir, cleanup } = makeTmpBridgeDir()
    const target = path.join(bridgeDir, 'out.json')
    atomicWrite(target, 'data')
    expect(fs.existsSync(target + '.tmp')).toBe(false)
    cleanup()
  })
})

describe('saveState', () => {
  it('saves state to file', () => {
    const { statePath, readState, cleanup } = makeTmpBridgeDir()
    saveState(statePath, emptyState())
    expect(readState()).toMatchObject({ slots: {}, daemonPid: null })
    cleanup()
  })
})
```

**Step 2: Run to verify failure**

```bash
npm test -- src/state/__tests__/
```

**Step 3: Implement load.ts**

```typescript
// src/state/load.ts
import * as fs from 'fs'
import { State, emptyState } from '../types/state'
import { Config } from '../types/config'

export const loadState = (statePath: string): State => {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as State
  } catch {
    return emptyState()
  }
}

export const loadConfig = (configPath: string): Partial<Config> => {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<Config>
  } catch {
    return {}
  }
}
```

**Step 4: Implement save.ts**

```typescript
// src/state/save.ts
import * as fs from 'fs'
import { State } from '../types/state'

export const atomicWrite = (filePath: string, content: string): void => {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
}

export const saveState = (statePath: string, state: State): void => {
  atomicWrite(statePath, JSON.stringify(state, null, 2))
}
```

**Step 5: Run tests — expect PASS**

```bash
npm test -- src/state/__tests__/
```

**Step 6: Commit**

```bash
git add src/state/
git commit -m "feat: add state load/save with atomic write (replaces fcntl.flock)"
```

---

### Task 6: State module — slots + cleanup (ports T-001–T-012)

**Files:**
- Create: `src/state/slots.ts`
- Create: `src/state/cleanup.ts`
- Create: `src/state/__tests__/slots.test.ts`
- Create: `src/state/__tests__/cleanup.test.ts`

**Step 1: Write slots tests (T-001–T-012)**

```typescript
// src/state/__tests__/slots.test.ts
import { makeTmpBridgeDir } from '../../__tests__/helpers/mockFs'
import { makeState, makeSlot, writeIpcSession } from '../../__tests__/helpers/fixtures'
import { isSlotActive, findSlotBySession, assignSlot } from '../slots'

describe('isSlotActive', () => {
  it('T-001: slot missing → false', () => {
    const { bridgeDir, ipcDir, cleanup } = makeTmpBridgeDir()
    const [active, reason] = isSlotActive(makeState(), '1', ipcDir, Date.now())
    expect(active).toBe(false)
    expect(reason).toBe('slot_not_in_state')
    cleanup()
  })

  it('T-002: sessionId null → false', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const state = makeState({ slots: { '1': { ...makeSlot(''), sessionId: '' } } })
    const [active, reason] = isSlotActive(state, '1', ipcDir, Date.now())
    expect(active).toBe(false)
    expect(reason).toBe('session_id_missing')
    cleanup()
  })

  it('T-003: IPC dir missing → false', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const state = makeState({ slots: { '1': makeSlot('abc123') } })
    const [active, reason] = isSlotActive(state, '1', ipcDir, Date.now())
    expect(active).toBe(false)
    expect(reason).toBe('ipc_dir_missing')
    cleanup()
  })

  it('T-004: meta.json missing → false', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    writeIpcSession(ipcDir, 'abc123', { meta: false })
    const state = makeState({ slots: { '1': makeSlot('abc123') } })
    const [active, reason] = isSlotActive(state, '1', ipcDir, Date.now())
    expect(active).toBe(false)
    expect(reason).toBe('meta_missing')
    cleanup()
  })

  it('T-005: kill file present → false', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    writeIpcSession(ipcDir, 'abc123', { kill: true })
    const state = makeState({ slots: { '1': makeSlot('abc123') } })
    const [active, reason] = isSlotActive(state, '1', ipcDir, Date.now(), () => false)
    expect(active).toBe(false)
    expect(reason).toBe('kill_file_present')
    cleanup()
  })

  it('T-006: daemon dead + heartbeat >60s → false', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    writeIpcSession(ipcDir, 'abc123')
    const now = Date.now() / 1000
    const state = makeState({ slots: { '1': makeSlot('abc123') }, daemonPid: 99999, daemonHeartbeat: now - 120 })
    const [active, reason] = isSlotActive(state, '1', ipcDir, now, () => false)
    expect(active).toBe(false)
    expect(reason).toBe('daemon_dead')
    cleanup()
  })

  it('T-007: daemon alive + all checks pass → true', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    writeIpcSession(ipcDir, 'abc123')
    const state = makeState({ slots: { '1': makeSlot('abc123') }, daemonPid: 12345 })
    const [active] = isSlotActive(state, '1', ipcDir, Date.now() / 1000, () => true)
    expect(active).toBe(true)
    cleanup()
  })

  it('T-008: daemon dead + heartbeat <60s → true (initializing)', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    writeIpcSession(ipcDir, 'abc123')
    const now = Date.now() / 1000
    const state = makeState({ slots: { '1': makeSlot('abc123') }, daemonPid: 99999, daemonHeartbeat: now - 10 })
    const [active] = isSlotActive(state, '1', ipcDir, now, () => false)
    expect(active).toBe(true)
    cleanup()
  })
})

describe('T-053: heartbeat boundary', () => {
  it('59s heartbeat → alive', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    writeIpcSession(ipcDir, 'sess')
    const now = Date.now() / 1000
    const state = makeState({ slots: { '1': makeSlot('sess') }, daemonHeartbeat: now - 59 })
    const [active] = isSlotActive(state, '1', ipcDir, now, () => false)
    expect(active).toBe(true)
    cleanup()
  })

  it('61s heartbeat → stale', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    writeIpcSession(ipcDir, 'sess')
    const now = Date.now() / 1000
    const state = makeState({ slots: { '1': makeSlot('sess') }, daemonHeartbeat: now - 61 })
    const [active, reason] = isSlotActive(state, '1', ipcDir, now, () => false)
    expect(active).toBe(false)
    expect(reason).toBe('daemon_dead')
    cleanup()
  })
})
```

```typescript
// src/state/__tests__/cleanup.test.ts
import { makeTmpBridgeDir } from '../../__tests__/helpers/mockFs'
import { makeState, makeSlot, writeIpcSession } from '../../__tests__/helpers/fixtures'
import { cleanupStaleSlots } from '../cleanup'

describe('cleanupStaleSlots', () => {
  it('T-009: stale slots removed from state', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const state = makeState({ slots: { '1': makeSlot('stale001') } })
    const next = cleanupStaleSlots(state, ipcDir)
    expect(next.slots['1']).toBeUndefined()
    cleanup()
  })

  it('T-010: IPC dirs deleted for stale slots', () => {
    const * as path from 'path'
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const sessionDir = writeIpcSession(ipcDir, 'stale002', { kill: true })
    const state = makeState({ slots: { '1': makeSlot('stale002') } })
    cleanupStaleSlots(state, ipcDir, { preserveIpc: false, isDaemonAlive: () => false })
    expect(require('fs').existsSync(sessionDir)).toBe(false)
    cleanup()
  })

  it('T-011: active slots untouched', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    writeIpcSession(ipcDir, 'active001')
    const state = makeState({ slots: { '1': makeSlot('active001') }, daemonPid: 123 })
    const next = cleanupStaleSlots(state, ipcDir, { isDaemonAlive: () => true })
    expect(next.slots['1']).toBeDefined()
    cleanup()
  })

  it('T-012: empty slots handled safely', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const state = makeState()
    expect(() => cleanupStaleSlots(state, ipcDir)).not.toThrow()
    cleanup()
  })
})
```

**Step 2: Run tests — expect FAIL**

```bash
npm test -- src/state/__tests__/
```

**Step 3: Implement slots.ts**

```typescript
// src/state/slots.ts
import * as fs from 'fs'
import * as path from 'path'
import { State, Slot, withSlot, withoutSlot } from '../types/state'

type SlotActiveResult = [active: boolean, reason: string | null]

export const isSlotActive = (
  state: State,
  slotNum: string,
  ipcDir: string,
  now: number,
  isDaemonAlive: (pid: number) => boolean = checkPidAlive,
): SlotActiveResult => {
  if (!state.slots[slotNum]) return [false, 'slot_not_in_state']
  const slot = state.slots[slotNum]!
  if (!slot.sessionId) return [false, 'session_id_missing']
  const sessionDir = path.join(ipcDir, slot.sessionId)
  if (!fs.existsSync(sessionDir)) return [false, 'ipc_dir_missing']
  if (!fs.existsSync(path.join(sessionDir, 'meta.json'))) return [false, 'meta_missing']
  if (fs.existsSync(path.join(sessionDir, 'kill'))) return [false, 'kill_file_present']
  if (state.daemonPid && isDaemonAlive(state.daemonPid)) return [true, null]
  const age = now - state.daemonHeartbeat
  if (age < 60) return [true, null]
  return [false, 'daemon_dead']
}

const checkPidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

export const findSlotBySession = (state: State, sessionId: string): string | null => {
  for (const [slotNum, slot] of Object.entries(state.slots)) {
    if (slot.sessionId === sessionId) return slotNum
  }
  return null
}

export const assignSlot = (state: State, maxSlots: number): string | null => {
  for (let i = 1; i <= maxSlots; i++) {
    if (!state.slots[String(i)]) return String(i)
  }
  return null
}
```

**Step 4: Implement cleanup.ts**

```typescript
// src/state/cleanup.ts
import * as fs from 'fs'
import * as path from 'path'
import { State, withoutSlot } from '../types/state'
import { isSlotActive } from './slots'

type CleanupOpts = {
  preserveIpc?: boolean
  isDaemonAlive?: (pid: number) => boolean
}

export const cleanupStaleSlots = (
  state: State,
  ipcDir: string,
  opts: CleanupOpts = {},
): State => {
  const { preserveIpc = false, isDaemonAlive } = opts
  const now = Date.now() / 1000
  let next = state

  for (const slotNum of Object.keys(state.slots)) {
    const [active] = isSlotActive(state, slotNum, ipcDir, now, isDaemonAlive)
    if (!active) {
      const sessionId = state.slots[slotNum]!.sessionId
      if (!preserveIpc) {
        const sessionDir = path.join(ipcDir, sessionId)
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true })
      }
      next = withoutSlot(next, slotNum)
    }
  }
  return next
}
```

**Step 5: Run tests — expect PASS**

```bash
npm test -- src/state/__tests__/
```

**Step 6: Commit**

```bash
git add src/state/
git commit -m "feat: add state/slots and state/cleanup (ports T-001–T-012, T-053)"
```

---

### Task 7: IPC module (ports B-001–B-011, T-052)

**Files:**
- Create: `src/ipc/bind.ts` + `src/ipc/__tests__/bind.test.ts`
- Create: `src/ipc/read.ts` + `src/ipc/__tests__/read.test.ts`
- Create: `src/ipc/write.ts` + `src/ipc/__tests__/write.test.ts`
- Create: `src/ipc/files.ts` + `src/ipc/__tests__/files.test.ts`

**Step 1: Write bind tests (B-001–B-007)**

```typescript
// src/ipc/__tests__/bind.test.ts
import * as fs from 'fs'
import * as path from 'path'
import { makeTmpBridgeDir } from '../../__tests__/helpers/mockFs'
import { writeIpcSession } from '../../__tests__/helpers/fixtures'
import { findBoundSession, findUnboundSlots, bindSession } from '../bind'

describe('findBoundSession', () => {
  it('B-001: finds IPC dir with matching bound_session', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const sessionDir = writeIpcSession(ipcDir, 'sess')
    fs.writeFileSync(path.join(sessionDir, 'bound_session'), 'claude-sess-001')
    expect(findBoundSession(ipcDir, 'claude-sess-001')).toBe(sessionDir)
    cleanup()
  })

  it('B-002: returns null when no match', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    writeIpcSession(ipcDir, 'sess')
    expect(findBoundSession(ipcDir, 'not-matching')).toBeNull()
    cleanup()
  })

  it('B-003: returns null when IPC dir missing', () => {
    expect(findBoundSession('/nonexistent/ipc', 'any')).toBeNull()
  })
})

describe('findUnboundSlots', () => {
  it('B-004: returns unbound dirs', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const d1 = writeIpcSession(ipcDir, 'sess1')
    const d2 = writeIpcSession(ipcDir, 'sess2')
    fs.writeFileSync(path.join(d1, 'bound_session'), 'x')
    const unbound = findUnboundSlots(ipcDir)
    expect(unbound).toContain(d2)
    expect(unbound).not.toContain(d1)
    cleanup()
  })

  it('B-005: excludes bound dirs', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const d = writeIpcSession(ipcDir, 'sess')
    fs.writeFileSync(path.join(d, 'bound_session'), 'bound')
    expect(findUnboundSlots(ipcDir)).not.toContain(d)
    cleanup()
  })

  it('B-006: returns empty when IPC dir missing', () => {
    expect(findUnboundSlots('/nonexistent')).toEqual([])
  })
})

describe('bindSession', () => {
  it('B-007: writes session_id to bound_session file', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const sessionDir = writeIpcSession(ipcDir, 'sess')
    bindSession(sessionDir, 'claude-abc')
    expect(fs.readFileSync(path.join(sessionDir, 'bound_session'), 'utf8')).toBe('claude-abc')
    cleanup()
  })
})
```

**Step 2: Write read test (T-052)**

```typescript
// src/ipc/__tests__/read.test.ts
import * as fs from 'fs'
import * as path from 'path'
import { makeTmpBridgeDir } from '../../__tests__/helpers/mockFs'
import { writeIpcSession } from '../../__tests__/helpers/fixtures'
import { readNewEvents } from '../read'

describe('readNewEvents', () => {
  it('T-052: does not re-process events on second scan', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const sessionDir = writeIpcSession(ipcDir, 'sess')
    const eventsFile = path.join(sessionDir, 'events.jsonl')
    fs.writeFileSync(eventsFile, JSON.stringify({ id: '1', type: 'notification' }) + '\n')

    const positions: Record<string, number> = {}
    const first = readNewEvents(eventsFile, 'sess', positions)
    expect(first).toHaveLength(1)
    const second = readNewEvents(eventsFile, 'sess', positions)
    expect(second).toHaveLength(0)
    cleanup()
  })

  it('picks up new events appended after first scan', () => {
    const { ipcDir, cleanup } = makeTmpBridgeDir()
    const sessionDir = writeIpcSession(ipcDir, 'sess')
    const eventsFile = path.join(sessionDir, 'events.jsonl')
    fs.writeFileSync(eventsFile, JSON.stringify({ id: '1', type: 'notification' }) + '\n')

    const positions: Record<string, number> = {}
    readNewEvents(eventsFile, 'sess', positions)
    fs.appendFileSync(eventsFile, JSON.stringify({ id: '2', type: 'notification' }) + '\n')
    const second = readNewEvents(eventsFile, 'sess', positions)
    expect(second).toHaveLength(1)
    expect(second[0]?.id).toBe('2')
    cleanup()
  })
})
```

**Step 3: Implement bind.ts, read.ts, write.ts, files.ts**

```typescript
// src/ipc/bind.ts
import * as fs from 'fs'
import * as path from 'path'

export const findBoundSession = (ipcDir: string, sessionId: string): string | null => {
  if (!fs.existsSync(ipcDir)) return null
  for (const name of fs.readdirSync(ipcDir)) {
    const dir = path.join(ipcDir, name)
    const boundFile = path.join(dir, 'bound_session')
    if (fs.existsSync(boundFile)) {
      try {
        if (fs.readFileSync(boundFile, 'utf8').trim() === sessionId) return dir
      } catch { /* skip */ }
    }
  }
  return null
}

export const findUnboundSlots = (ipcDir: string): string[] => {
  if (!fs.existsSync(ipcDir)) return []
  return fs.readdirSync(ipcDir)
    .map(name => path.join(ipcDir, name))
    .filter(dir => fs.statSync(dir).isDirectory() && !fs.existsSync(path.join(dir, 'bound_session')))
}

export const bindSession = (ipcDir: string, sessionId: string): void => {
  fs.writeFileSync(path.join(ipcDir, 'bound_session'), sessionId)
}
```

```typescript
// src/ipc/read.ts
import * as fs from 'fs'
import { IpcEvent } from '../types/events'

export const readNewEvents = (
  eventsFile: string,
  sessionId: string,
  positions: Record<string, number>,
): IpcEvent[] => {
  if (!fs.existsSync(eventsFile)) return []
  const pos = positions[sessionId] ?? 0
  const buf = Buffer.alloc(0)
  let fd: number
  try {
    fd = fs.openSync(eventsFile, 'r')
    const stat = fs.fstatSync(fd)
    const size = stat.size - pos
    if (size <= 0) { fs.closeSync(fd); return [] }
    const chunk = Buffer.alloc(size)
    fs.readSync(fd, chunk, 0, size, pos)
    positions[sessionId] = stat.size
    fs.closeSync(fd)
    return chunk.toString('utf8').split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean) as IpcEvent[]
  } catch {
    return []
  }
}
```

```typescript
// src/ipc/write.ts
import * as fs from 'fs'
import * as path from 'path'
import { IpcEvent } from '../types/events'
import { atomicWrite } from '../state/save'

export const writeEvent = (sessionDir: string, event: IpcEvent): void => {
  const file = path.join(sessionDir, 'events.jsonl')
  fs.appendFileSync(file, JSON.stringify(event) + '\n')
}

export const writeResponse = (sessionDir: string, eventId: string, response: object): void => {
  atomicWrite(path.join(sessionDir, `response-${eventId}.json`), JSON.stringify(response))
}

export const writeMeta = (sessionDir: string, meta: object): void => {
  atomicWrite(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2))
}
```

```typescript
// src/ipc/files.ts
import * as fs from 'fs'
import * as path from 'path'

export const writeKillFile      = (sessionDir: string, reason: string) =>
  fs.writeFileSync(path.join(sessionDir, 'kill'), reason)

export const writeForceFile     = (sessionDir: string) =>
  fs.writeFileSync(path.join(sessionDir, 'force_clear'), String(Date.now()))

export const writeDeactivationMarker = (sessionDir: string) =>
  fs.writeFileSync(path.join(sessionDir, 'deactivation_processed'), 'done')

export const readQueuedInstruction = (sessionDir: string): string | null => {
  const f = path.join(sessionDir, 'queued_instruction.json')
  if (!fs.existsSync(f)) return null
  try {
    const { instruction } = JSON.parse(fs.readFileSync(f, 'utf8'))
    return instruction?.trim() || null
  } catch { return null }
}

export const writeQueuedInstruction = (sessionDir: string, instruction: string) =>
  fs.writeFileSync(path.join(sessionDir, 'queued_instruction.json'),
    JSON.stringify({ instruction, timestamp: Date.now() / 1000 }))

export const removeQueuedInstruction = (sessionDir: string) => {
  try { fs.unlinkSync(path.join(sessionDir, 'queued_instruction.json')) } catch { /* ok */ }
}

export const hasKillFile = (sessionDir: string) => fs.existsSync(path.join(sessionDir, 'kill'))
export const hasForceFile = (sessionDir: string) => fs.existsSync(path.join(sessionDir, 'force_clear'))
export const removeForceFile = (sessionDir: string) => {
  try { fs.unlinkSync(path.join(sessionDir, 'force_clear')) } catch { /* ok */ }
}
```

**Step 4: Run tests — expect PASS**

```bash
npm test -- src/ipc/__tests__/
```

**Step 5: Commit**

```bash
git add src/ipc/
git commit -m "feat: add ipc module — bind, read, write, files (ports B-001–B-007, T-052)"
```

---

### Task 8: Telegram module (ports T-054–T-059)

**Files:**
- Create: `src/telegram/format.ts` + `src/telegram/__tests__/format.test.ts`
- Create: `src/telegram/client.ts`
- Create: `src/telegram/topics.ts`
- Create: `src/telegram/messages.ts`
- Create: `src/telegram/updates.ts`

**Step 1: Write format tests (T-054–T-059)**

```typescript
// src/telegram/__tests__/format.test.ts
import { escapeHtml, formatPermission, formatStop, formatNotification, formatToolDescription } from '../format'

describe('escapeHtml', () => {
  it('T-054: escapes <, >, &', () => {
    expect(escapeHtml('<b>&foo</b>')).toBe('&lt;b&gt;&amp;foo&lt;/b&gt;')
  })
})

describe('formatPermission (T-055)', () => {
  it('includes slot, tool, description', () => {
    const msg = formatPermission({ toolName: 'Bash', description: 'git status' }, '1')
    expect(msg).toContain('Bash')
    expect(msg).toContain('git status')
    expect(msg).toContain('Permission')
  })
})

describe('formatStop (T-056)', () => {
  it('truncates lastMessage at 600 chars', () => {
    const msg = formatStop({ lastMessage: 'x'.repeat(700) }, '1')
    expect(msg).toContain('...')
    expect(msg.length).toBeLessThan(750)
  })

  it('short message not truncated', () => {
    expect(formatStop({ lastMessage: 'Done!' }, '1')).toContain('Done!')
  })
})

describe('formatNotification (T-057)', () => {
  it('permission_prompt → 🔔', () => {
    expect(formatNotification({ notificationType: 'permission_prompt', message: 'x', title: 'T' }, '1')).toContain('🔔')
  })
  it('idle_prompt → 💤', () => {
    expect(formatNotification({ notificationType: 'idle_prompt', message: 'x', title: 'T' }, '1')).toContain('💤')
  })
  it('unknown → 📢', () => {
    expect(formatNotification({ notificationType: 'other', message: 'x', title: 'T' }, '1')).toContain('📢')
  })
})

describe('formatToolDescription', () => {
  it('T-058: Bash truncates command at 300 chars', () => {
    const result = formatToolDescription('Bash', { command: 'x'.repeat(500) })
    expect(result).toContain('Bash')
    expect(result.length).toBeLessThan(400)
  })

  it('T-059: unknown tool shows 2 key-values', () => {
    const result = formatToolDescription('Unknown', { key1: 'v1', key2: 'v2', key3: 'v3' })
    expect(result).toContain('key1')
    expect(result).toContain('key2')
    expect(result).not.toContain('key3')
  })
})
```

**Step 2: Run — expect FAIL**

```bash
npm test -- src/telegram/__tests__/format.test.ts
```

**Step 3: Implement format.ts**

```typescript
// src/telegram/format.ts
export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const formatPermission = (event: { toolName: string; description: string }, slot: string) =>
  `🔐 <b>Permission Request</b>\n\n<b>Tool:</b> ${escapeHtml(event.toolName)}\n\n<pre>${escapeHtml(event.description)}</pre>`

export const formatStop = (event: { lastMessage: string }, slot: string) => {
  let msg = escapeHtml(event.lastMessage)
  if (msg.length > 600) msg = msg.slice(0, 600) + '...'
  return `✅ <b>Task Complete</b>\n\n${msg}\n\n<i>Reply to give next instruction...</i>`
}

export const formatNotification = (event: { notificationType: string; message: string; title: string }, slot: string) => {
  const emoji = ({ permission_prompt: '🔔', idle_prompt: '💤' } as Record<string, string>)[event.notificationType] ?? '📢'
  return `${emoji} ${escapeHtml(event.title)}\n${escapeHtml(event.message)}`
}

export const formatToolDescription = (toolName: string, input: Record<string, unknown>): string => {
  if (toolName === 'Bash') {
    const cmd = String(input['command'] ?? '')
    const desc = String(input['description'] ?? '')
    return desc ? `Bash: ${desc}\n\`${cmd.slice(0, 200)}\`` : `Bash: \`${cmd.slice(0, 300)}\``
  }
  if (toolName === 'Write') return `Write: ${input['file_path'] ?? '?'}`
  if (toolName === 'Edit') return `Edit: ${input['file_path'] ?? '?'}\n\`${String(input['old_string'] ?? '').slice(0, 80)}...\``
  const parts = [`${toolName}:`]
  for (const [k, v] of Object.entries(input).slice(0, 2)) parts.push(`  ${k}: ${String(v).slice(0, 100)}`)
  return parts.join('\n')
}
```

**Step 4: Implement client.ts**

```typescript
// src/telegram/client.ts
import * as https from 'https'
import { TgResult, TelegramClient, TgMessage, TgForumTopic, TgUpdate } from '../types/telegram'

const request = (token: string, method: string, data?: object): Promise<any> =>
  new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : undefined
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }
    const req = https.request(options, res => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => { try { resolve(JSON.parse(buf)) } catch { reject(new Error('bad JSON')) } })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })

export const makeTelegramClient = (token: string, chatId: string): TelegramClient => ({
  chatId,
  createForumTopic: (name) => request(token, 'createForumTopic', { chat_id: chatId, name }),
  deleteForumTopic: (threadId) => request(token, 'deleteForumTopic', { chat_id: chatId, message_thread_id: threadId }),
  sendMessage: (text, opts = {}) => request(token, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    ...(opts.threadId ? { message_thread_id: opts.threadId } : {}),
    ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
  }),
  editMessage: (messageId, text, opts = {}) => request(token, 'editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
    ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
  }),
  answerCallback: (cqId, text) => request(token, 'answerCallbackQuery',
    { callback_query_id: cqId, ...(text ? { text } : {}) }),
  sendChatAction: (action, threadId) => request(token, 'sendChatAction', {
    chat_id: chatId, action, ...(threadId ? { message_thread_id: threadId } : {}),
  }),
  getUpdates: async (timeout = 30) => {
    const result = await request(token, 'getUpdates', { timeout, allowed_updates: ['message', 'callback_query'] })
    return result?.ok ? result.result : []
  },
  setMyCommands: () => request(token, 'setMyCommands', { commands: [
    { command: 'compact', description: 'Compress conversation context' },
    { command: 'clear', description: 'Clear conversation history' },
    { command: 'ping', description: 'Check if agent is alive' },
    { command: 'end', description: 'End AFK session from Telegram' },
  ]}),
})
```

**Step 5: Run format tests — expect PASS**

```bash
npm test -- src/telegram/__tests__/format.test.ts
```

**Step 6: Commit**

```bash
git add src/telegram/
git commit -m "feat: add telegram module — client, format, types (ports T-054–T-059)"
```

---

## Phase 3 — Hook + Bridge (TDD)

### Task 9: hook/activate + hook/deactivate (ports T-013–T-019, D-001–D-007)

**Files:**
- Create: `src/hook/activate.ts` + `src/hook/__tests__/activate.test.ts`
- Create: `src/hook/deactivate.ts` + `src/hook/__tests__/deactivate.test.ts`

**Step 1: Write activate tests (T-013–T-019)**

```typescript
// src/hook/__tests__/activate.test.ts
import * as path from 'path'
import * as fs from 'fs'
import { makeTmpBridgeDir } from '../../__tests__/helpers/mockFs'
import { makeState, makeSlot, writeIpcSession } from '../../__tests__/helpers/fixtures'
import { cmdActivate } from '../activate'

const makeActivateDeps = (opts: { bridgeDir: string; ipcDir: string; daemonAlive?: boolean }) => ({
  bridgeDir: opts.bridgeDir,
  ipcDir: opts.ipcDir,
  isDaemonAlive: () => opts.daemonAlive ?? false,
  startDaemon: jest.fn().mockReturnValue(1234),
})

describe('cmdActivate', () => {
  it('T-013: fresh activation creates slot + IPC dir + meta.json', () => {
    const { bridgeDir, ipcDir, statePath, writeState, readState, configPath, cleanup } = makeTmpBridgeDir()
    writeState(makeState())
    const deps = makeActivateDeps({ bridgeDir, ipcDir })

    cmdActivate('new-sess', 'myproject', '', statePath, configPath, deps)

    const state = readState() as any
    const slot = Object.values(state.slots)[0] as any
    expect(slot.sessionId).toBe('new-sess')
    expect(fs.existsSync(path.join(ipcDir, 'new-sess', 'meta.json'))).toBe(true)
    cleanup()
  })

  it('T-014: starts daemon when not running', () => {
    const { bridgeDir, ipcDir, statePath, writeState, configPath, cleanup } = makeTmpBridgeDir()
    writeState(makeState())
    const deps = makeActivateDeps({ bridgeDir, ipcDir, daemonAlive: false })

    cmdActivate('new-sess', 'myproject', '', statePath, configPath, deps)

    expect(deps.startDaemon).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('T-015: same session_id already active → idempotent', () => {
    const { bridgeDir, ipcDir, statePath, writeState, configPath, cleanup } = makeTmpBridgeDir()
    writeIpcSession(ipcDir, 'sess-015')
    writeState(makeState({ slots: { '1': makeSlot('sess-015') }, daemonPid: 123 }))
    const deps = makeActivateDeps({ bridgeDir, ipcDir, daemonAlive: true })

    // Should not throw, just return
    expect(() => cmdActivate('sess-015', 'myproject', '', statePath, configPath, deps)).not.toThrow()
    cleanup()
  })

  it('T-018: stale cleanup runs before slot assignment', () => {
    const { bridgeDir, ipcDir, statePath, writeState, readState, configPath, cleanup } = makeTmpBridgeDir()
    // Fill 4 slots with stale sessions (no IPC dirs)
    const slots = Object.fromEntries([1,2,3,4].map(i => [String(i), makeSlot(`stale-${i}`)]))
    writeState(makeState({ slots, daemonPid: 99999 }))
    const deps = makeActivateDeps({ bridgeDir, ipcDir, daemonAlive: false })

    cmdActivate('brand-new', 'myproject', '', statePath, configPath, deps)

    const state = readState() as any
    expect(Object.values(state.slots).some((s: any) => s.sessionId === 'brand-new')).toBe(true)
    cleanup()
  })

  it('T-019: all 4 slots genuinely occupied → throws', () => {
    const { bridgeDir, ipcDir, statePath, writeState, configPath, cleanup } = makeTmpBridgeDir()
    const slots = Object.fromEntries([1,2,3,4].map(i => {
      writeIpcSession(ipcDir, `active-${i}`)
      return [String(i), makeSlot(`active-${i}`)]
    }))
    writeState(makeState({ slots, daemonPid: 123 }))
    const deps = makeActivateDeps({ bridgeDir, ipcDir, daemonAlive: true })

    expect(() => cmdActivate('newbie', 'proj', '', statePath, configPath, deps)).toThrow()
    cleanup()
  })
})
```

**Step 2: Write deactivate tests (D-001–D-007)**

```typescript
// src/hook/__tests__/deactivate.test.ts
import { makeTmpBridgeDir } from '../../__tests__/helpers/mockFs'
import { makeState, makeSlot, writeIpcSession } from '../../__tests__/helpers/fixtures'
import { cmdDeactivate } from '../deactivate'
import * as fs from 'fs'
import * as path from 'path'

describe('cmdDeactivate', () => {
  it('D-001: removes slot from state', () => {
    const { ipcDir, statePath, writeState, readState, cleanup } = makeTmpBridgeDir()
    const sessionDir = writeIpcSession(ipcDir, 'sess-d001')
    fs.writeFileSync(path.join(sessionDir, 'deactivation_processed'), 'done')
    writeState(makeState({ slots: { '1': makeSlot('sess-d001') } }))

    cmdDeactivate('sess-d001', statePath, ipcDir, { stopDaemon: jest.fn() })

    expect((readState() as any).slots['1']).toBeUndefined()
    cleanup()
  })

  it('D-004: no sessions → no throw', () => {
    const { statePath, ipcDir, writeState, cleanup } = makeTmpBridgeDir()
    writeState(makeState())
    expect(() => cmdDeactivate('none', statePath, ipcDir, { stopDaemon: jest.fn() })).not.toThrow()
    cleanup()
  })

  it('D-006: last session → stopDaemon called', () => {
    const { ipcDir, statePath, writeState, cleanup } = makeTmpBridgeDir()
    const sessionDir = writeIpcSession(ipcDir, 'last-sess')
    fs.writeFileSync(path.join(sessionDir, 'deactivation_processed'), 'done')
    writeState(makeState({ slots: { '1': makeSlot('last-sess') }, daemonPid: 123 }))
    const stopDaemon = jest.fn()

    cmdDeactivate('last-sess', statePath, ipcDir, { stopDaemon })

    expect(stopDaemon).toHaveBeenCalled()
    cleanup()
  })

  it('D-007: multiple sessions → only matching removed', () => {
    const { ipcDir, statePath, writeState, readState, cleanup } = makeTmpBridgeDir()
    const d1 = writeIpcSession(ipcDir, 'sessA')
    writeIpcSession(ipcDir, 'sessB')
    fs.writeFileSync(path.join(d1, 'deactivation_processed'), 'done')
    writeState(makeState({ slots: { '1': makeSlot('sessA'), '2': makeSlot('sessB', { topicName: 'S2 - test-project' }) } }))

    cmdDeactivate('sessA', statePath, ipcDir, { stopDaemon: jest.fn() })

    const state = readState() as any
    expect(state.slots['1']).toBeUndefined()
    expect(state.slots['2']).toBeDefined()
    cleanup()
  })
})
```

**Step 3: Run — expect FAIL**

```bash
npm test -- src/hook/__tests__/
```

**Step 4: Implement activate.ts and deactivate.ts** (full implementation following Python logic, using pure state transitions from `state/` and IPC writers from `ipc/`)

Implementation follows same logic as `hook.py:cmd_activate` and `hook.py:cmd_deactivate` but:
- State transitions via `withSlot`, `withoutSlot` from `types/state`
- IPC writes via `writeEvent`, `writeMeta` from `ipc/write`
- Cleanup via `cleanupStaleSlots` from `state/cleanup`
- Deps injected: `isDaemonAlive`, `startDaemon`, `stopDaemon`

**Step 5: Run tests — expect PASS**

```bash
npm test -- src/hook/__tests__/
```

**Step 6: Commit**

```bash
git add src/hook/
git commit -m "feat: add hook/activate and hook/deactivate (ports T-013–T-019, D-001–D-007)"
```

---

### Task 10: hook/events — cmdHook entry point (ports H-001–H-012)

**Files:**
- Create: `src/hook/events.ts` + `src/hook/__tests__/events.test.ts`
- Create: `src/hook/poll.ts` (replaces poll.py — `pollResponse`, `pollResponseOrKill`)

**Step 1: Write tests (H-001–H-012) — full test file mirrors test_cmd_hook.py**

Same 12 scenarios, using Jest mocks:
- `jest.spyOn` on `pollResponse` to return allow/deny/null
- Write IPC session dirs to tmp bridge dir
- Capture stdout via `process.stdout.write` spy

**Step 2: Implement poll.ts**

```typescript
// src/hook/poll.ts
import * as fs from 'fs'
import * as path from 'path'
import { hasKillFile, hasForceFile, removeForceFile } from '../ipc/files'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export const pollResponse = async (sessionDir: string, eventId: string, timeoutSecs: number): Promise<object | null> => {
  const responsePath = path.join(sessionDir, `response-${eventId}.json`)
  const deadline = Date.now() + timeoutSecs * 1000
  let interval = 500

  while (Date.now() < deadline) {
    if (hasForceFile(sessionDir)) {
      removeForceFile(sessionDir)
      return { decision: 'allow' }
    }
    if (fs.existsSync(responsePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(responsePath, 'utf8'))
        fs.unlinkSync(responsePath)
        return data
      } catch { /* retry */ }
    }
    await sleep(interval)
    interval = Math.min(interval * 1.2, 2000)
  }
  return null
}

export const pollResponseOrKill = async (
  sessionDir: string, eventId: string, timeoutSecs: number
): Promise<object | null> => {
  const responsePath = path.join(sessionDir, `response-${eventId}.json`)
  const deadline = Date.now() + timeoutSecs * 1000
  let interval = 500

  while (Date.now() < deadline) {
    if (hasKillFile(sessionDir)) {
      const reason = (() => { try { return fs.readFileSync(path.join(sessionDir, 'kill'), 'utf8').trim() } catch { return 'unknown' } })()
      return { _killed: true, _reason: reason }
    }
    if (hasForceFile(sessionDir)) {
      removeForceFile(sessionDir)
      return { instruction: '/clear' }
    }
    if (fs.existsSync(responsePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(responsePath, 'utf8'))
        fs.unlinkSync(responsePath)
        return data
      } catch { /* retry */ }
    }
    await sleep(interval)
    interval = Math.min(interval * 1.2, 2000)
  }
  return null
}
```

**Step 3: Implement hook/events.ts** (full port of `cmd_hook` from Python):
- Read `process.stdin` as JSON
- Resolve IPC dir (direct / bound / unbound)
- Route: PermissionRequest → write event + `pollResponse` → print JSON
- Route: Stop → write event + `pollResponseOrKill` loop
- Route: Notification → write event + exit
- Unknown / no session → exit silently

**Step 4: Run tests — expect PASS**

```bash
npm test -- src/hook/__tests__/events.test.ts
```

**Step 5: Commit**

```bash
git add src/hook/
git commit -m "feat: add hook/events (cmdHook) and poll helpers (ports H-001–H-012)"
```

---

### Task 11: hook/index.ts — CLI entry point

**Files:**
- Create: `src/hook/index.ts`
- Create: `src/hook/status.ts`
- Create: `src/hook/setup.ts` (interactive, no unit tests)

**Step 1: Create index.ts**

```typescript
// src/hook/index.ts
import { cmdActivate }   from './activate'
import { cmdDeactivate } from './deactivate'
import { cmdStatus }     from './status'
import { cmdSetup }      from './setup'
import { cmdHook }       from './events'

const [,, cmd, ...args] = process.argv

switch (cmd) {
  case 'activate':   cmdActivate(args[0]!, args[1] ?? '', args[2] ?? ''); break
  case 'deactivate': cmdDeactivate(args[0]!); break
  case 'status':     cmdStatus(); break
  case 'setup':      cmdSetup(); break
  case 'hook':       cmdHook(); break
  default:
    console.error(`Unknown command: ${cmd}`)
    process.exit(1)
}
```

**Step 2: Build and smoke test**

```bash
npm run build
node dist/hook.js status
```

Expected: "No active AFK sessions." or similar.

**Step 3: Commit**

```bash
git add src/hook/
git commit -m "feat: add hook entry point (index.ts, status, setup)"
```

---

### Task 12: bridge — event processors (ports T-020–T-053, I-001–I-015)

**Files:**
- `src/bridge/activation.ts` + `__tests__/activation.test.ts`
- `src/bridge/permissions.ts` + `__tests__/permissions.test.ts`
- `src/bridge/messages.ts` + `__tests__/messages.test.ts`
- `src/bridge/callbacks.ts` + `__tests__/callbacks.test.ts`
- `src/bridge/typing.ts` + `__tests__/typing.test.ts`
- `src/bridge/stale.ts` + `__tests__/stale.test.ts`
- `src/bridge/events.ts` + `__tests__/events.test.ts`

**Pattern for each file:**

1. Write failing tests (port the corresponding Python test class)
2. Run `npm test -- src/bridge/__tests__/<file>.test.ts` — expect FAIL
3. Implement the pure function(s) with injected `TelegramClient`
4. Run test — expect PASS
5. Commit per file

**Activation tests (T-020–T-022, T-048–T-050):**
```typescript
// src/bridge/__tests__/activation.test.ts
import { makeMockTelegram } from '../../__tests__/helpers/mockTelegram'
import { makeTmpBridgeDir } from '../../__tests__/helpers/mockFs'
import { writeIpcSession, makeState, makeSlot } from '../../__tests__/helpers/fixtures'
import { handleActivation } from '../activation'
// ... tests mirror test_bridge_events.py TestProcessEvent T-020–T-022
// and test_edge_cases.py T-048–T-050
```

**Permissions tests (I-001–I-005, I-013):**
```typescript
// src/bridge/__tests__/permissions.test.ts
// mirrors test_daemon_internals.py TestFlushPermissionBatches
```

**Callbacks tests (T-036–T-047):**
```typescript
// src/bridge/__tests__/callbacks.test.ts
// mirrors test_bridge_events.py TestCallbacks
```

Each module receives `TelegramClient` as a parameter — no global state, fully testable.

**Commit after each file:**
```bash
git commit -m "feat: add bridge/<module> (ports T-0xx–T-0xx)"
```

---

### Task 13: bridge/daemon.ts — main loop

**Files:**
- Create: `src/bridge/daemon.ts`

No unit tests for the main loop (integration concern). Wire all modules together:

```typescript
// src/bridge/daemon.ts
import { makeTelegramClient } from '../telegram/client'
import { loadConfig, loadState } from '../state/load'
import { saveState } from '../state/save'
import { readNewEvents } from '../ipc/read'
import { processEvent } from './events'
// ... orchestrate heartbeat, scan, polling, update handling

export const run = async (bridgeDir: string): Promise<void> => {
  const configPath = path.join(bridgeDir, 'config.json')
  const statePath  = path.join(bridgeDir, 'state.json')
  const ipcDir     = path.join(bridgeDir, 'ipc')
  const config     = loadConfig(configPath)
  const tg         = makeTelegramClient(config.botToken!, config.chatId!)
  // ... main loop
}

run(process.env['BRIDGE_DIR'] ?? path.join(os.homedir(), '.claude', 'hooks', 'telegram-bridge'))
  .catch(e => { console.error(e); process.exit(1) })
```

**Step 1: Implement daemon.ts**

**Step 2: Build and verify**

```bash
npm run build
ls -la dist/
```

Expected: `dist/hook.js` and `dist/bridge.js` present.

**Step 3: Commit**

```bash
git add src/bridge/
git commit -m "feat: add bridge/daemon.ts — main loop wiring all modules"
```

---

## Phase 4 — Integration + Cleanup

### Task 14: Update hook.sh — remove all Python

**Files:**
- Modify: `hook.sh`

**Step 1: Replace hook.sh content**

```bash
#!/bin/bash
# telegram-bridge: Hook entry point — delegates to Node.js
set -uo pipefail

BRIDGE_DIR="${HOME}/.claude/hooks/telegram-bridge"
HOOK_JS="$BRIDGE_DIR/dist/hook.js"

case "${1:-}" in
  --activate)
    SESSION_ID="${2:-}"; PROJECT="${3:-}"; TOPIC="${4:-}"
    [ -z "$SESSION_ID" ] && { echo "Usage: hook.sh --activate <session_id> [project] [topic]" >&2; exit 1; }
    node "$HOOK_JS" activate "$SESSION_ID" "$PROJECT" "$TOPIC"
    ;;
  --deactivate)
    SESSION_ID="${2:-}"
    [ -z "$SESSION_ID" ] && { echo "Usage: hook.sh --deactivate <session_id>" >&2; exit 1; }
    node "$HOOK_JS" deactivate "$SESSION_ID"
    ;;
  --status)  node "$HOOK_JS" status  ;;
  --setup)   node "$HOOK_JS" setup   ;;
  --help|-h) node "$HOOK_JS" --help  ;;
  --*)
    echo "Unknown option: $1" >&2; exit 1
    ;;
  *)
    # Hook mode: pipe stdin
    INPUT=$(cat)
    echo "$INPUT" | node "$HOOK_JS" hook
    ;;
esac
exit $?
```

**Step 2: Verify zero Python references**

```bash
grep -r "python3\|python " hook.sh install.sh setup.sh README.md || echo "clean"
```

Expected: Only in docs/historical references, not in executable code.

**Step 3: Commit**

```bash
git add hook.sh
git commit -m "feat: update hook.sh — remove all Python, delegate to node dist/hook.js"
```

---

### Task 15: Remove Python files + finalize

**Step 1: Delete Python files**

```bash
cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge
rm hook.py bridge.py poll.py pytest.ini
rm -rf .venv __pycache__ tests/ .pytest_cache
```

**Step 2: Update .gitignore**

Add to `.gitignore`:
```
node_modules/
*.pyc
__pycache__/
.venv/
.pytest_cache/
```

**Step 3: Run full test suite**

```bash
npm test
```

Expected: All tests pass (106+ tests across state, ipc, telegram, hook, bridge).

**Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors.

**Step 5: Build dist and verify**

```bash
npm run build
node dist/hook.js status
```

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove Python files — full TypeScript rewrite complete"
```

---

### Task 16: Push + open PR

**Step 1: Push branch**

```bash
git push -u origin feature/ts-rewrite
```

**Step 2: Open PR**

```bash
gh pr create \
  --title "feat: TypeScript rewrite — eliminate Python dependency" \
  --body "Rewrites hook.py + bridge.py to TypeScript. Zero Python runtime dependency. esbuild bundles to dist/. 106+ Jest tests. IPC protocol unchanged."
```

---

## Success Checklist

- [ ] `python3` not referenced in any executable file
- [ ] `npm test` → all tests pass
- [ ] `npm run build` → dist/hook.js + dist/bridge.js created
- [ ] `node dist/hook.js status` runs without error
- [ ] `hook.sh` uses `node` only
- [ ] Husky pre-push builds dist/ automatically
- [ ] All Python files removed from repo
