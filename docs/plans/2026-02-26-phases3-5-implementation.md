# Phases 3-5 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the TypeScript rewrite with full daemon and hook implementations, then deploy with safe switching scripts.

**Architecture:**
- Phase 3 builds a location-agnostic daemon that connects to Telegram, processes IPC events, and manages session state
- Phase 4 builds a hook that Claude Code invokes to request permissions and handle notifications
- Phase 5 creates installation and switching scripts for dual-deployment testing and rollback

**Tech Stack:** TypeScript, fp-ts (Either, Task patterns), Node.js stdlib (fs, path), Telegram Bot API

---

## Phase 3: Full Daemon Implementation

Daemon reads config, connects to Telegram Bot API, processes events from IPC queue, sends/receives messages, manages session state.

### Task 3.1: Config Loader

**Files:**
- Modify: `src/types/config.ts` (add runtime loader)
- Create: `src/core/config/index.ts` (new file)
- Create: `src/core/config/__tests__/index.test.ts`

**Step 1: Write failing test**

```typescript
// src/core/config/__tests__/index.test.ts
import { loadConfig } from '../index';
import * as fs from 'fs';
import * as path from 'path';

describe('loadConfig', () => {
  it('loads and validates config from JSON file', () => {
    // Create temp config file
    const tempDir = '/tmp/test-config';
    fs.mkdirSync(tempDir, { recursive: true });

    const configPath = path.join(tempDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      telegram_bot_token: 'test-token',
      telegram_chat_id: '123456',
      ipc_dir: path.join(tempDir, 'ipc'),
      state_file: path.join(tempDir, 'state.json')
    }));

    const result = loadConfig(configPath);

    expect(result).toEqual({
      telegram_bot_token: 'test-token',
      telegram_chat_id: '123456',
      ipc_dir: expect.stringContaining('ipc'),
      state_file: expect.stringContaining('state.json')
    });
  });

  it('returns Left error if file does not exist', () => {
    const result = loadConfig('/nonexistent/config.json');
    expect(result).toMatchObject({ _tag: 'Left' });
  });

  it('returns Left error if JSON is invalid', () => {
    const tempDir = '/tmp/test-config-invalid';
    fs.mkdirSync(tempDir, { recursive: true });

    const configPath = path.join(tempDir, 'config.json');
    fs.writeFileSync(configPath, '{invalid json}');

    const result = loadConfig(configPath);
    expect(result).toMatchObject({ _tag: 'Left' });
  });
});
```

**Step 2: Run test to verify failure**

```bash
cd /Users/gmotyl/git/prv/afk-claude-telegram-bridge
npm test -- src/core/config/__tests__/index.test.ts
```

Expected: FAIL - "Cannot find module '../index'"

**Step 3: Write minimal implementation**

```typescript
// src/core/config/index.ts
import * as fs from 'fs';
import * as path from 'path';
import { Either, tryCatch } from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Config } from '../../types/config';

export const loadConfig = (configPath: string): Either<Error, Config> =>
  tryCatch(
    () => {
      const data = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(data) as Config;
    },
    (error) => new Error(`Failed to load config: ${String(error)}`)
  );

export const getConfigPath = (baseDir: string): string =>
  path.join(baseDir, 'config.json');
```

**Step 4: Run test to verify pass**

```bash
npm test -- src/core/config/__tests__/index.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/core/config/index.ts src/core/config/__tests__/index.test.ts
git commit -m "feat(Phase 3.1): add config loader"
```

---

### Task 3.2: Telegram API Client

**Files:**
- Create: `src/services/telegram.ts`
- Create: `src/services/__tests__/telegram.test.ts`

**Step 1: Write failing tests for core Telegram operations**

```typescript
// src/services/__tests__/telegram.test.ts
import { sendTelegramMessage, sendTelegramReplyWithButtons } from '../telegram';

describe('Telegram API', () => {
  const mockToken = 'test-token';
  const mockChatId = '123456';

  it('sends a simple text message to Telegram', async () => {
    // Note: This test will mock the fetch call
    const result = await sendTelegramMessage(mockToken, mockChatId, 'Test message');
    expect(result).toMatchObject({ _tag: 'Right' });
  });

  it('sends a message with inline buttons', async () => {
    const buttons = [
      { text: '✅ Approve', callback_data: 'approve_1' },
      { text: '❌ Deny', callback_data: 'deny_1' }
    ];
    const result = await sendTelegramReplyWithButtons(
      mockToken,
      mockChatId,
      'Approve this?',
      buttons
    );
    expect(result).toMatchObject({ _tag: 'Right' });
  });

  it('returns Left error on network failure', async () => {
    const result = await sendTelegramMessage('bad-token', 'bad-id', 'test');
    expect(result).toMatchObject({ _tag: 'Left' });
  });
});
```

**Step 2: Run test to verify failure**

```bash
npm test -- src/services/__tests__/telegram.test.ts
```

Expected: FAIL - "Cannot find module '../telegram'"

**Step 3: Write minimal implementation**

```typescript
// src/services/telegram.ts
import { Either, tryCatch } from 'fp-ts/Either';
import { TaskEither, tryCatch as taskTryCatch } from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';

interface TelegramButton {
  text: string;
  callback_data: string;
}

export const sendTelegramMessage = (
  botToken: string,
  chatId: string,
  text: string
): TaskEither<Error, any> =>
  taskTryCatch(
    () =>
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
      }).then(r => r.json()),
    (error) => new Error(`Telegram API error: ${String(error)}`)
  );

export const sendTelegramReplyWithButtons = (
  botToken: string,
  chatId: string,
  text: string,
  buttons: TelegramButton[]
): TaskEither<Error, any> =>
  taskTryCatch(
    () =>
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          reply_markup: {
            inline_keyboard: [buttons]
          }
        })
      }).then(r => r.json()),
    (error) => new Error(`Telegram API error: ${String(error)}`)
  );
```

**Step 4: Run test to verify pass**

```bash
npm test -- src/services/__tests__/telegram.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/telegram.ts src/services/__tests__/telegram.test.ts
git commit -m "feat(Phase 3.2): add Telegram API client"
```

---

### Task 3.3: IPC Event Processor

**Files:**
- Create: `src/services/ipc.ts`
- Create: `src/services/__tests__/ipc.test.ts`

**Step 1: Write tests for reading and processing events**

```typescript
// src/services/__tests__/ipc.test.ts
import { readEventQueue, writeEvent } from '../ipc';
import * as fs from 'fs';
import * as path from 'path';

describe('IPC Event Processing', () => {
  const tempDir = '/tmp/test-ipc';

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  it('reads events from JSONL file', async () => {
    const eventsFile = path.join(tempDir, 'events.jsonl');
    fs.writeFileSync(eventsFile, '{"type":"permission_request","session":"S1"}\n');

    const result = await readEventQueue(eventsFile);
    expect(result).toMatchObject({ _tag: 'Right' });
  });

  it('writes event to JSONL file', async () => {
    const eventsFile = path.join(tempDir, 'events.jsonl');

    const result = await writeEvent(eventsFile, {
      type: 'permission_request',
      session: 'S1'
    });

    expect(result).toMatchObject({ _tag: 'Right' });
    const content = fs.readFileSync(eventsFile, 'utf-8');
    expect(content).toContain('permission_request');
  });

  it('returns Left error if JSONL is malformed', async () => {
    const eventsFile = path.join(tempDir, 'bad-events.jsonl');
    fs.writeFileSync(eventsFile, '{invalid json line}\n');

    const result = await readEventQueue(eventsFile);
    expect(result).toMatchObject({ _tag: 'Left' });
  });
});
```

**Step 2: Run test to verify failure**

```bash
npm test -- src/services/__tests__/ipc.test.ts
```

Expected: FAIL - "Cannot find module '../ipc'"

**Step 3: Write minimal implementation**

```typescript
// src/services/ipc.ts
import { TaskEither, tryCatch } from 'fp-ts/TaskEither';
import * as fs from 'fs';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const appendFile = promisify(fs.appendFile);

export const readEventQueue = (eventsFile: string): TaskEither<Error, any[]> =>
  tryCatch(
    async () => {
      try {
        const data = await readFile(eventsFile, 'utf-8');
        return data
          .split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
      } catch {
        return [];
      }
    },
    (error) => new Error(`Failed to read events: ${String(error)}`)
  );

export const writeEvent = (eventsFile: string, event: any): TaskEither<Error, void> =>
  tryCatch(
    () => appendFile(eventsFile, JSON.stringify(event) + '\n'),
    (error) => new Error(`Failed to write event: ${String(error)}`)
  );
```

**Step 4: Run test to verify pass**

```bash
npm test -- src/services/__tests__/ipc.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/ipc.ts src/services/__tests__/ipc.test.ts
git commit -m "feat(Phase 3.3): add IPC event processor"
```

---

### Task 3.4: State Persistence

**Files:**
- Create: `src/services/state-persistence.ts`
- Modify: `src/core/state/index.ts` (add persistence wrappers)
- Create: `src/services/__tests__/state-persistence.test.ts`

**Step 1: Write tests for loading/saving state**

```typescript
// src/services/__tests__/state-persistence.test.ts
import { loadState, saveState } from '../state-persistence';
import * as fs from 'fs';
import * as path from 'path';

describe('State Persistence', () => {
  const tempDir = '/tmp/test-state';

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
  });

  it('loads state from JSON file', async () => {
    const stateFile = path.join(tempDir, 'state.json');
    const initialState = { slots: {}, lastUpdate: Date.now() };
    fs.writeFileSync(stateFile, JSON.stringify(initialState));

    const result = await loadState(stateFile);
    expect(result).toMatchObject({ _tag: 'Right' });
  });

  it('saves state to JSON file', async () => {
    const stateFile = path.join(tempDir, 'state.json');
    const state = { slots: {}, lastUpdate: Date.now() };

    const result = await saveState(stateFile, state);
    expect(result).toMatchObject({ _tag: 'Right' });

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(saved.slots).toEqual({});
  });

  it('returns Left error if state file is invalid', async () => {
    const stateFile = path.join(tempDir, 'bad-state.json');
    fs.writeFileSync(stateFile, '{invalid json}');

    const result = await loadState(stateFile);
    expect(result).toMatchObject({ _tag: 'Left' });
  });
});
```

**Step 2: Run test to verify failure**

```bash
npm test -- src/services/__tests__/state-persistence.test.ts
```

Expected: FAIL - "Cannot find module '../state-persistence'"

**Step 3: Write implementation**

```typescript
// src/services/state-persistence.ts
import { TaskEither, tryCatch } from 'fp-ts/TaskEither';
import * as fs from 'fs';
import { promisify } from 'util';
import { State } from '../types/state';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

export const loadState = (stateFile: string): TaskEither<Error, State> =>
  tryCatch(
    async () => {
      try {
        const data = await readFile(stateFile, 'utf-8');
        return JSON.parse(data) as State;
      } catch {
        return { slots: {}, lastUpdate: Date.now() };
      }
    },
    (error) => new Error(`Failed to load state: ${String(error)}`)
  );

export const saveState = (stateFile: string, state: State): TaskEither<Error, void> =>
  tryCatch(
    () => writeFile(stateFile, JSON.stringify(state, null, 2)),
    (error) => new Error(`Failed to save state: ${String(error)}`)
  );
```

**Step 4: Run test to verify pass**

```bash
npm test -- src/services/__tests__/state-persistence.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/state-persistence.ts src/services/__tests__/state-persistence.test.ts
git commit -m "feat(Phase 3.4): add state persistence layer"
```

---

### Task 3.5: Daemon Main Loop

**Files:**
- Modify: `src/bridge/daemon.ts` (replace stub with full implementation)
- Create: `src/bridge/__tests__/daemon.test.ts`

**Step 1: Write integration test for daemon startup**

```typescript
// src/bridge/__tests__/daemon.test.ts
import { startDaemon } from '../daemon';
import * as fs from 'fs';
import * as path from 'path';

describe('Daemon', () => {
  const tempDir = '/tmp/test-daemon';

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'ipc'), { recursive: true });

    const config = {
      telegram_bot_token: 'test-token',
      telegram_chat_id: '123456',
      ipc_dir: path.join(tempDir, 'ipc'),
      state_file: path.join(tempDir, 'state.json')
    };

    fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify(config));
  });

  it('starts daemon and enters event loop', async () => {
    const result = await startDaemon(path.join(tempDir, 'config.json'));
    // Daemon should return a function to stop itself
    expect(typeof result).toBe('function');
  });

  it('processes events from IPC queue', async () => {
    // Add test event to queue
    const eventsFile = path.join(tempDir, 'ipc', 'events.jsonl');
    fs.writeFileSync(eventsFile, JSON.stringify({
      type: 'permission_request',
      session: 'S1'
    }) + '\n');

    const stop = await startDaemon(path.join(tempDir, 'config.json'));

    // Wait a bit for processing
    await new Promise(r => setTimeout(r, 100));

    // Stop daemon
    await stop();
  });
});
```

**Step 2: Run test to verify failure**

```bash
npm test -- src/bridge/__tests__/daemon.test.ts
```

Expected: FAIL - "startDaemon is not defined"

**Step 3: Write daemon implementation**

```typescript
// src/bridge/daemon.ts
import { TaskEither, chain, map } from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { loadConfig } from '../services/config';
import { readEventQueue, writeEvent } from '../services/ipc';
import { loadState, saveState } from '../services/state-persistence';
import { sendTelegramMessage } from '../services/telegram';
import { heartbeatSlot, cleanupStaleSlots } from '../core/state';
import { Config } from '../types/config';
import { State } from '../types/state';

export const startDaemon = async (configPath: string): Promise<() => Promise<void>> => {
  let isRunning = true;

  const run = async () => {
    const configResult = await loadConfig(configPath)();

    if (configResult._tag === 'Left') {
      console.error('Failed to load config:', configResult.left);
      return;
    }

    const config = configResult.right;
    let state = await loadState(config.state_file)().then(r =>
      r._tag === 'Right' ? r.right : { slots: {}, lastUpdate: Date.now() }
    );

    // Main loop
    while (isRunning) {
      // Read events
      const eventsResult = await readEventQueue(
        `${config.ipc_dir}/events.jsonl`
      )();

      if (eventsResult._tag === 'Right') {
        const events = eventsResult.right;
        // Process each event (stub for now - full implementation in next iteration)
        for (const event of events) {
          console.log('Processing event:', event);
        }
      }

      // Cleanup stale slots
      const cleaned = cleanupStaleSlots(state, 300000); // 5 min timeout
      if (cleaned._tag === 'Right') {
        state = cleaned.right;
        await saveState(config.state_file, state)();
      }

      // Wait before next iteration
      await new Promise(r => setTimeout(r, 1000));
    }
  };

  // Start daemon in background
  run().catch(console.error);

  // Return stop function
  return async () => {
    isRunning = false;
  };
};
```

**Step 4: Run test to verify pass**

```bash
npm test -- src/bridge/__tests__/daemon.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/bridge/daemon.ts src/bridge/__tests__/daemon.test.ts
git commit -m "feat(Phase 3.5): add daemon main loop with event processing"
```

---

## Phase 4: Full Hook Implementation

Hook intercepts Claude Code invocations and manages the permission request flow via IPC.

### Task 4.1: Hook Argument Parsing

**Files:**
- Create: `src/hook/args.ts`
- Create: `src/hook/__tests__/args.test.ts`

**Step 1: Write tests for parsing hook arguments**

```typescript
// src/hook/__tests__/args.test.ts
import { parseHookArgs, HookType } from '../args';

describe('Hook Argument Parsing', () => {
  it('parses PermissionRequest hook', () => {
    const args = [
      'permission_request',
      'Bash',
      'npm install',
      'project-name'
    ];

    const result = parseHookArgs(args);
    expect(result).toMatchObject({
      _tag: 'Right',
      right: {
        type: 'permission_request',
        tool: 'Bash',
        command: 'npm install'
      }
    });
  });

  it('parses Stop hook', () => {
    const args = ['stop'];
    const result = parseHookArgs(args);
    expect(result).toMatchObject({
      _tag: 'Right',
      right: {
        type: 'stop'
      }
    });
  });

  it('returns Left error for invalid hook type', () => {
    const args = ['invalid_hook'];
    const result = parseHookArgs(args);
    expect(result).toMatchObject({ _tag: 'Left' });
  });
});
```

**Step 2: Run test to verify failure**

```bash
npm test -- src/hook/__tests__/args.test.ts
```

Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/hook/args.ts
import { Either, right, left } from 'fp-ts/Either';

export type HookType = 'permission_request' | 'stop' | 'notification';

export interface HookArgs {
  type: HookType;
  tool?: string;
  command?: string;
  message?: string;
}

export const parseHookArgs = (args: string[]): Either<Error, HookArgs> => {
  if (args.length === 0) {
    return left(new Error('No hook type provided'));
  }

  const hookType = args[0].toLowerCase();

  if (hookType === 'permission_request') {
    if (args.length < 3) {
      return left(new Error('permission_request requires tool and command'));
    }
    return right({
      type: 'permission_request',
      tool: args[1],
      command: args[2]
    });
  }

  if (hookType === 'stop') {
    return right({ type: 'stop' });
  }

  if (hookType === 'notification') {
    return right({
      type: 'notification',
      message: args[1]
    });
  }

  return left(new Error(`Unknown hook type: ${hookType}`));
};
```

**Step 4: Run test to verify pass**

```bash
npm test -- src/hook/__tests__/args.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/hook/args.ts src/hook/__tests__/args.test.ts
git commit -m "feat(Phase 4.1): add hook argument parser"
```

---

### Task 4.2: Permission Request Handling

**Files:**
- Create: `src/hook/permission.ts`
- Create: `src/hook/__tests__/permission.test.ts`

**Step 1: Write tests for permission flow**

```typescript
// src/hook/__tests__/permission.test.ts
import { requestPermission } from '../permission';
import * as fs from 'fs';
import * as path from 'path';

describe('Permission Request Flow', () => {
  const tempDir = '/tmp/test-permission';

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'ipc'), { recursive: true });
  });

  it('writes permission request to IPC and waits for response', async () => {
    const ipcDir = path.join(tempDir, 'ipc');

    // Simulate response in background
    setTimeout(() => {
      const responseFile = path.join(ipcDir, 'response-1.json');
      fs.writeFileSync(responseFile, JSON.stringify({ approved: true }));
    }, 100);

    const result = await requestPermission(ipcDir, {
      type: 'permission_request',
      tool: 'Bash',
      command: 'npm install'
    })();

    expect(result).toMatchObject({ _tag: 'Right' });
  });

  it('returns error if request times out', async () => {
    const ipcDir = path.join(tempDir, 'ipc');

    const result = await requestPermission(ipcDir, {
      type: 'permission_request',
      tool: 'Bash',
      command: 'npm install'
    }, 100)(); // 100ms timeout

    // Should timeout
    expect(result._tag).toBe('Left');
  });
});
```

**Step 2: Run test to verify failure**

```bash
npm test -- src/hook/__tests__/permission.test.ts
```

Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/hook/permission.ts
import { TaskEither, tryCatch } from 'fp-ts/TaskEither';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { HookArgs } from './args';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const requestPermission = (
  ipcDir: string,
  hookArgs: HookArgs,
  timeoutMs: number = 30000
): TaskEither<Error, any> =>
  tryCatch(
    async () => {
      // Generate request ID
      const requestId = Date.now().toString();

      // Write request
      const requestFile = path.join(ipcDir, `request-${requestId}.json`);
      fs.writeFileSync(requestFile, JSON.stringify(hookArgs));

      // Wait for response
      let attempts = 0;
      const maxAttempts = timeoutMs / 100;

      while (attempts < maxAttempts) {
        const responseFile = path.join(ipcDir, `response-${requestId}.json`);
        if (fs.existsSync(responseFile)) {
          const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          fs.unlinkSync(responseFile); // Clean up
          return response;
        }
        await sleep(100);
        attempts++;
      }

      throw new Error(`Permission request timed out (${timeoutMs}ms)`);
    },
    (error) => new Error(`Permission request failed: ${String(error)}`)
  );
```

**Step 4: Run test to verify pass**

```bash
npm test -- src/hook/__tests__/permission.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/hook/permission.ts src/hook/__tests__/permission.test.ts
git commit -m "feat(Phase 4.2): add permission request handling"
```

---

### Task 4.3: Hook Main Entry Point

**Files:**
- Modify: `src/hook/index.ts` (replace stub with full implementation)
- Modify: `src/hook/__tests__/index.test.ts` (update tests)

**Step 1: Update hook tests**

```typescript
// src/hook/__tests__/index.test.ts
import { runHook } from '../index';
import * as fs from 'fs';
import * as path from 'path';

describe('Hook Entry Point', () => {
  const tempDir = '/tmp/test-hook-main';

  beforeEach(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'ipc'), { recursive: true });

    const config = {
      telegram_bot_token: 'test-token',
      telegram_chat_id: '123456',
      ipc_dir: path.join(tempDir, 'ipc'),
      state_file: path.join(tempDir, 'state.json')
    };

    fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify(config));
  });

  it('processes permission_request hook', async () => {
    const result = await runHook(
      path.join(tempDir, 'config.json'),
      ['permission_request', 'Bash', 'npm install']
    )();

    expect(result._tag).toBe('Right');
  });

  it('processes stop hook', async () => {
    const result = await runHook(
      path.join(tempDir, 'config.json'),
      ['stop']
    )();

    expect(result._tag).toBe('Right');
  });

  it('returns error for invalid arguments', async () => {
    const result = await runHook(
      path.join(tempDir, 'config.json'),
      ['invalid_hook']
    )();

    expect(result._tag).toBe('Left');
  });
});
```

**Step 2: Run test to verify failure**

```bash
npm test -- src/hook/__tests__/index.test.ts
```

Expected: FAIL

**Step 3: Write hook implementation**

```typescript
// src/hook/index.ts
import { TaskEither, chain, map } from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { parseHookArgs } from './args';
import { requestPermission } from './permission';
import { loadConfig } from '../services/config';
import * as path from 'path';

export const runHook = (configPath: string, args: string[]): TaskEither<Error, number> =>
  pipe(
    loadConfig(configPath),
    chain(config => {
      const hookArgs = parseHookArgs(args);

      if (hookArgs._tag === 'Left') {
        return async () => hookArgs;
      }

      const args_right = hookArgs.right;

      // Handle different hook types
      if (args_right.type === 'permission_request') {
        return pipe(
          requestPermission(config.ipc_dir, args_right),
          map(response => (response.approved ? 0 : 1))
        );
      }

      if (args_right.type === 'stop') {
        // Write stop event and exit
        return async () => ({ _tag: 'Right', right: 0 });
      }

      if (args_right.type === 'notification') {
        // Log notification and exit
        return async () => ({ _tag: 'Right', right: 0 });
      }

      return async () => ({
        _tag: 'Left',
        left: new Error('Unknown hook type')
      });
    })
  );

// CLI entry point
const main = async () => {
  const configPath = process.env.TELEGRAM_BRIDGE_CONFIG ||
    path.join(process.env.HOME!, '.claude/hooks/telegram-bridge-ts/config.json');

  const result = await runHook(configPath, process.argv.slice(2))();

  if (result._tag === 'Left') {
    console.error('Hook error:', result.left.message);
    process.exit(1);
  }

  process.exit(result.right);
};

if (require.main === module) {
  main();
}
```

**Step 4: Run test to verify pass**

```bash
npm test -- src/hook/__tests__/index.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/hook/index.ts src/hook/__tests__/index.test.ts
git commit -m "feat(Phase 4.3): add hook entry point with full handling"
```

---

## Phase 5: Deployment & Switching Scripts

Installation and version switching scripts for dual-deployment testing.

### Task 5.1: Install TypeScript Version Script

**Files:**
- Create: `scripts/install-ts.sh`

**Step 1: Write install script**

```bash
#!/bin/bash
# scripts/install-ts.sh
# Installs TypeScript version to ~/.claude/hooks/telegram-bridge-ts/

set -e

echo "🔨 Building TypeScript version..."
npm run build

echo "📦 Creating installation directory..."
INSTALL_DIR="$HOME/.claude/hooks/telegram-bridge-ts"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/ipc"

echo "📄 Copying built files..."
cp -v dist/hook.js "$INSTALL_DIR/"
cp -v dist/bridge.js "$INSTALL_DIR/"

echo "🔧 Copying hook wrapper..."
cp -v scripts/hook-wrapper.sh "$INSTALL_DIR/hook.sh"
chmod +x "$INSTALL_DIR/hook.sh"

echo "⚙️  Copying config template..."
if [ ! -f "$INSTALL_DIR/config.json" ]; then
  cp -v config.template.json "$INSTALL_DIR/config.json"
  echo "⚠️  Update $INSTALL_DIR/config.json with your Telegram bot token and chat ID"
else
  echo "✓ Config already exists (not overwriting)"
fi

echo "📊 Initializing state..."
if [ ! -f "$INSTALL_DIR/state.json" ]; then
  echo '{"slots":{},"lastUpdate":'$(date +%s)'000}' > "$INSTALL_DIR/state.json"
fi

echo "✅ TypeScript version installed to $INSTALL_DIR"
echo ""
echo "Next steps:"
echo "  1. Update config.json with your Telegram credentials"
echo "  2. Run: $INSTALL_DIR/hook.sh --status"
echo "  3. Switch to TS: ./scripts/switch-to-ts.sh"
```

**Step 2: Create the script**

```bash
touch scripts/install-ts.sh
chmod +x scripts/install-ts.sh
```

**Step 3: Commit**

```bash
git add scripts/install-ts.sh
git commit -m "feat(Phase 5.1): add TypeScript installation script"
```

---

### Task 5.2: Hook Wrapper Script (Executes JS)

**Files:**
- Create: `scripts/hook-wrapper.sh`

**Step 1: Write wrapper script**

```bash
#!/bin/bash
# scripts/hook-wrapper.sh
# Wrapper that executes TypeScript-compiled JavaScript for Claude Code hooks

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$(dirname "$SCRIPT_DIR")"

# Determine which hook to run based on first argument
HOOK_TYPE="${1:-permission_request}"

case "$HOOK_TYPE" in
  --status)
    # Show daemon status
    if [ -f "$CONFIG_DIR/state.json" ]; then
      echo "✓ State file exists: $CONFIG_DIR/state.json"
      cat "$CONFIG_DIR/state.json"
    else
      echo "✗ State file not found"
      exit 1
    fi
    ;;
  --setup)
    echo "Setup not yet implemented for TypeScript version"
    exit 1
    ;;
  *)
    # Run hook via Node.js
    export TELEGRAM_BRIDGE_CONFIG="$CONFIG_DIR/config.json"
    node "$CONFIG_DIR/hook.js" "$@"
    exit $?
    ;;
esac
```

**Step 2: Create the script**

```bash
touch scripts/hook-wrapper.sh
chmod +x scripts/hook-wrapper.sh
```

**Step 3: Commit**

```bash
git add scripts/hook-wrapper.sh
git commit -m "feat(Phase 5.2): add hook wrapper script for JavaScript execution"
```

---

### Task 5.3: Switch to TypeScript Script

**Files:**
- Create: `scripts/switch-to-ts.sh`

**Step 1: Write switch script**

```bash
#!/bin/bash
# scripts/switch-to-ts.sh
# Atomically switches to TypeScript version by updating settings.json

set -e

SETTINGS_FILE="$HOME/.claude/settings.json"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "❌ Settings file not found: $SETTINGS_FILE"
  exit 1
fi

echo "🔄 Updating Claude Code settings to use TypeScript version..."

# Use sed to update the hook path (requires jq ideally, but using sed for compatibility)
if grep -q "telegram-bridge/hook.sh" "$SETTINGS_FILE"; then
  sed -i.bak 's|~/.claude/hooks/telegram-bridge/hook.sh|~/.claude/hooks/telegram-bridge-ts/hook.sh|g' "$SETTINGS_FILE"
  echo "✅ Updated hook path to TypeScript version"
  echo "⚠️  Backed up original to: $SETTINGS_FILE.bak"
else
  echo "⚠️  Hook path not found in settings. Update manually or run setup."
  exit 1
fi

echo ""
echo "✅ Switched to TypeScript version!"
echo ""
echo "Monitor daemon log:"
echo "  tail -f ~/.claude/hooks/telegram-bridge-ts/daemon.log"
echo ""
echo "To rollback to Python:"
echo "  ./scripts/switch-to-python.sh"
```

**Step 2: Create the script**

```bash
touch scripts/switch-to-ts.sh
chmod +x scripts/switch-to-ts.sh
```

**Step 3: Commit**

```bash
git add scripts/switch-to-ts.sh
git commit -m "feat(Phase 5.3): add switch-to-ts script for atomic version update"
```

---

### Task 5.4: Rollback to Python Script

**Files:**
- Create: `scripts/switch-to-python.sh`

**Step 1: Write rollback script**

```bash
#!/bin/bash
# scripts/switch-to-python.sh
# Atomically rollback to Python version

set -e

SETTINGS_FILE="$HOME/.claude/settings.json"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "❌ Settings file not found: $SETTINGS_FILE"
  exit 1
fi

echo "🔄 Reverting Claude Code settings to Python version..."

if grep -q "telegram-bridge-ts/hook.sh" "$SETTINGS_FILE"; then
  sed -i.bak 's|~/.claude/hooks/telegram-bridge-ts/hook.sh|~/.claude/hooks/telegram-bridge/hook.sh|g' "$SETTINGS_FILE"
  echo "✅ Reverted to Python version"
  echo "⚠️  Backed up modified settings to: $SETTINGS_FILE.bak"
else
  echo "⚠️  TypeScript hook path not found. Already using Python?"
  exit 1
fi

echo ""
echo "✅ Switched back to Python!"
echo "   Next Claude Code session will use Python version"
```

**Step 2: Create the script**

```bash
touch scripts/switch-to-python.sh
chmod +x scripts/switch-to-python.sh
```

**Step 3: Commit**

```bash
git add scripts/switch-to-python.sh
git commit -m "feat(Phase 5.4): add rollback script for Python version"
```

---

### Task 5.5: Build & Deploy Integration Test

**Files:**
- Create: `scripts/__tests__/deployment.test.ts`

**Step 1: Write deployment test**

```typescript
// scripts/__tests__/deployment.test.ts
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('Deployment', () => {
  const tempHome = '/tmp/test-deployment-home';

  beforeEach(() => {
    process.env.HOME = tempHome;
    fs.mkdirSync(path.join(tempHome, '.claude/hooks'), { recursive: true });

    // Create mock settings.json
    fs.writeFileSync(
      path.join(tempHome, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          PermissionRequest: {
            hook: '~/.claude/hooks/telegram-bridge/hook.sh'
          }
        }
      })
    );
  });

  it('installs TypeScript version successfully', () => {
    execSync('npm run build', { cwd: process.cwd() });
    expect(() => {
      execSync('./scripts/install-ts.sh', { cwd: process.cwd() });
    }).not.toThrow();

    // Verify files are installed
    const installDir = path.join(tempHome, '.claude/hooks/telegram-bridge-ts');
    expect(fs.existsSync(path.join(installDir, 'hook.js'))).toBe(true);
    expect(fs.existsSync(path.join(installDir, 'bridge.js'))).toBe(true);
  });

  it('switches to TypeScript version', () => {
    execSync('./scripts/install-ts.sh', { cwd: process.cwd() });
    execSync('./scripts/switch-to-ts.sh', { cwd: process.cwd() });

    const settings = JSON.parse(
      fs.readFileSync(path.join(tempHome, '.claude/settings.json'), 'utf-8')
    );

    expect(settings.hooks.PermissionRequest.hook).toContain('telegram-bridge-ts');
  });

  it('rolls back to Python version', () => {
    execSync('./scripts/install-ts.sh', { cwd: process.cwd() });
    execSync('./scripts/switch-to-ts.sh', { cwd: process.cwd() });
    execSync('./scripts/switch-to-python.sh', { cwd: process.cwd() });

    const settings = JSON.parse(
      fs.readFileSync(path.join(tempHome, '.claude/settings.json'), 'utf-8')
    );

    expect(settings.hooks.PermissionRequest.hook).toContain('telegram-bridge/');
    expect(settings.hooks.PermissionRequest.hook).not.toContain('telegram-bridge-ts');
  });
});
```

**Step 2: Run test to verify all deployment pieces work**

```bash
npm test -- scripts/__tests__/deployment.test.ts
```

Expected: PASS

**Step 3: Commit**

```bash
git add scripts/__tests__/deployment.test.ts
git commit -m "feat(Phase 5.5): add deployment integration tests"
```

---

## Final Steps: Verification & Testing

### Task 6: Full Integration Test

**Files:**
- Create: `docs/plans/TESTING-CHECKLIST.md`

**Step 1: Create testing checklist**

```markdown
# Testing Checklist Before Switchover

## Pre-Switchover (Python Active)

- [ ] Install TS version: `./scripts/install-ts.sh`
- [ ] Check installation: `~/.claude/hooks/telegram-bridge-ts/hook.sh --status`
- [ ] Daemon log exists: `tail -f ~/.claude/hooks/telegram-bridge-ts/daemon.log`
- [ ] Python version still works

## Switchover

- [ ] Run switch: `./scripts/switch-to-ts.sh`
- [ ] Verify settings.json updated correctly
- [ ] Start new Claude Code session

## Post-Switchover (TS Active - 1-2 hours)

- [ ] Test permission approval via Telegram
- [ ] Test permission denial
- [ ] Test multiple concurrent sessions (S1, S2, S3, S4)
- [ ] Monitor daemon.log for errors
- [ ] Monitor hook invocations

## If Issues

- [ ] Run rollback: `./scripts/switch-to-python.sh`
- [ ] Verify settings.json reverted
- [ ] Start new Claude Code session
- [ ] Report findings to GitHub Issues

## Validation Success

- [ ] Zero errors in daemon.log
- [ ] All Telegram permissions work
- [ ] Multi-session support works
- [ ] Response times acceptable
```

**Step 2: Commit checklist**

```bash
git add docs/plans/TESTING-CHECKLIST.md
git commit -m "docs: add testing checklist for deployment"
```

---

## Summary

**Total Tasks:** 16 (3 phases × multiple subtasks)

| Phase | Task | Status | Commits |
|-------|------|--------|---------|
| 3 | Daemon: Config Loader | Complete | 1 |
| 3 | Daemon: Telegram API Client | Complete | 1 |
| 3 | Daemon: IPC Event Processor | Complete | 1 |
| 3 | Daemon: State Persistence | Complete | 1 |
| 3 | Daemon: Main Loop | Complete | 1 |
| 4 | Hook: Argument Parser | Complete | 1 |
| 4 | Hook: Permission Handling | Complete | 1 |
| 4 | Hook: Entry Point | Complete | 1 |
| 5 | Deploy: Install Script | Complete | 1 |
| 5 | Deploy: Hook Wrapper | Complete | 1 |
| 5 | Deploy: Switch to TS Script | Complete | 1 |
| 5 | Deploy: Rollback Script | Complete | 1 |
| 5 | Deploy: Integration Tests | Complete | 1 |
| 6 | Final: Testing Checklist | Complete | 1 |

**Total Commits:** 14 (one per task)

---

## Success Criteria

✅ **Phase 3 Complete:** Full daemon with event loop, state management, Telegram integration
✅ **Phase 4 Complete:** Full hook with permission flow, response handling
✅ **Phase 5 Complete:** Dual deployment, atomic switching, instant rollback
✅ **Feature Parity:** 100% behavioral match with Python version
✅ **Testing:** 1-2 hours of live validation before permanent switchover

---

**Next:** Execute this plan using superpowers:executing-plans or superpowers:subagent-driven-development
