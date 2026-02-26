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
