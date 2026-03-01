import * as E from 'fp-ts/Either'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  readQueuedInstruction,
  writeQueuedInstruction,
  deleteQueuedInstruction
} from '../queued-instruction'

describe('Queued Instruction Service', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queued-instr-test-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('readQueuedInstruction', () => {
    it('returns null when no queued instruction exists', async () => {
      const result = await readQueuedInstruction(tempDir)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right).toBeNull()
      }
    })

    it('reads an existing queued instruction', async () => {
      const instruction = { text: 'run tests', timestamp: '2026-01-01T00:00:00.000Z' }
      await fs.writeFile(
        path.join(tempDir, 'queued_instruction.json'),
        JSON.stringify(instruction),
        'utf-8'
      )

      const result = await readQueuedInstruction(tempDir)()

      expect(E.isRight(result)).toBe(true)
      if (E.isRight(result)) {
        expect(result.right).toEqual(instruction)
      }
    })

    it('returns Left error for parse failures', async () => {
      await fs.writeFile(
        path.join(tempDir, 'queued_instruction.json'),
        'not valid json',
        'utf-8'
      )

      const result = await readQueuedInstruction(tempDir)()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        expect(result.left._tag).toBe('IpcReadError')
      }
    })
  })

  describe('writeQueuedInstruction', () => {
    it('writes a queued instruction file', async () => {
      const result = await writeQueuedInstruction(tempDir, 'fix the bug')()

      expect(E.isRight(result)).toBe(true)

      const content = await fs.readFile(
        path.join(tempDir, 'queued_instruction.json'),
        'utf-8'
      )
      const parsed = JSON.parse(content)
      expect(parsed.text).toBe('fix the bug')
      expect(parsed.timestamp).toBeDefined()
    })

    it('overwrites existing queued instruction', async () => {
      await writeQueuedInstruction(tempDir, 'first')()
      await writeQueuedInstruction(tempDir, 'second')()

      const content = await fs.readFile(
        path.join(tempDir, 'queued_instruction.json'),
        'utf-8'
      )
      const parsed = JSON.parse(content)
      expect(parsed.text).toBe('second')
    })

    it('returns Left error for invalid directory', async () => {
      const result = await writeQueuedInstruction('/nonexistent/dir', 'test')()

      expect(E.isLeft(result)).toBe(true)
      if (E.isLeft(result)) {
        expect(result.left._tag).toBe('IpcWriteError')
      }
    })
  })

  describe('deleteQueuedInstruction', () => {
    it('deletes an existing queued instruction', async () => {
      await fs.writeFile(
        path.join(tempDir, 'queued_instruction.json'),
        '{}',
        'utf-8'
      )

      const result = await deleteQueuedInstruction(tempDir)()

      expect(E.isRight(result)).toBe(true)
      const exists = await fs.access(path.join(tempDir, 'queued_instruction.json'))
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(false)
    })

    it('succeeds even when no file exists (idempotent)', async () => {
      const result = await deleteQueuedInstruction(tempDir)()

      expect(E.isRight(result)).toBe(true)
    })
  })
})
