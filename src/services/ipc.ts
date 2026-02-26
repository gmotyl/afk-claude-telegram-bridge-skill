/**
 * @module services/ipc
 * IPC (Inter-Process Communication) event queue module.
 * Handles reading/writing events to JSONL files for daemon-agent communication.
 * Uses fs/promises for async operations and TaskEither for functional error handling.
 */

import * as TE from 'fp-ts/TaskEither'
import * as fs from 'fs/promises'

/**
 * Convert an unknown error to a standardized Error instance
 * @param error - Any thrown error (can be Error, string, or unknown type)
 * @returns Standardized Error instance
 */
const convertError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error
  }
  return new Error(String(error))
}

/**
 * Read all events from a JSONL file.
 * Each line is a separate JSON object (newline-delimited JSON format).
 * Empty lines are skipped. Returns array of parsed JSON objects.
 *
 * Process:
 * 1. Read file as UTF-8 text
 * 2. Split by newlines
 * 3. Filter empty lines
 * 4. Parse each line as JSON
 *
 * @param eventsFile - Path to the JSONL events file
 * @returns TaskEither<Error, any[]> - Left(error) or Right(array of parsed events)
 *
 * @example
 * const result = await readEventQueue('/tmp/ipc/events.jsonl')()
 * if (E.isRight(result)) {
 *   console.log(result.right) // array of events
 * }
 */
export const readEventQueue = (eventsFile: string): TE.TaskEither<Error, any[]> => {
  return TE.tryCatch(
    async () => {
      // Read file as UTF-8 text
      const content = await fs.readFile(eventsFile, 'utf-8')

      // Split by newlines and filter empty lines
      const lines = content.split('\n').filter(line => line.trim().length > 0)

      // Parse each line as JSON
      const events = lines.map(line => JSON.parse(line))

      return events
    },
    convertError
  )
}

/**
 * Write a single event to a JSONL file by appending.
 * If file doesn't exist, creates it.
 * Appends the event as a JSON line (with newline terminator).
 *
 * @param eventsFile - Path to the JSONL events file
 * @param event - Event object to write (any serializable value)
 * @returns TaskEither<Error, void> - Left(error) or Right(void)
 *
 * @example
 * const event = { _tag: 'Heartbeat', slotNum: 1 }
 * const result = await writeEvent('/tmp/ipc/events.jsonl', event)()
 * if (E.isRight(result)) {
 *   console.log('Event written')
 * }
 */
export const writeEvent = (
  eventsFile: string,
  event: any
): TE.TaskEither<Error, void> => {
  return TE.tryCatch(
    async () => {
      // Serialize event to JSON and add newline
      const line = JSON.stringify(event) + '\n'

      // Append to file (creates if doesn't exist)
      await fs.appendFile(eventsFile, line, 'utf-8')
    },
    convertError
  )
}

/**
 * Delete a single event file.
 * Returns error if file doesn't exist or permission denied.
 *
 * @param eventFile - Path to the event file to delete
 * @returns TaskEither<Error, void> - Left(error) or Right(void)
 *
 * @example
 * const result = await deleteEventFile('/tmp/ipc/event-S1.jsonl')()
 * if (E.isRight(result)) {
 *   console.log('File deleted')
 * }
 */
export const deleteEventFile = (eventFile: string): TE.TaskEither<Error, void> => {
  return TE.tryCatch(
    async () => {
      await fs.unlink(eventFile)
    },
    convertError
  )
}

/**
 * List all files in an IPC directory.
 * Returns filenames (not full paths), sorted alphabetically.
 * Includes only files, excludes subdirectories.
 *
 * @param eventsDir - Path to the IPC directory
 * @returns TaskEither<Error, string[]> - Left(error) or Right(sorted filename array)
 *
 * @example
 * const result = await listEvents('/tmp/ipc/')()
 * if (E.isRight(result)) {
 *   console.log(result.right) // ['event-S1.jsonl', 'event-S2.jsonl']
 * }
 */
export const listEvents = (eventsDir: string): TE.TaskEither<Error, string[]> => {
  return TE.tryCatch(
    async () => {
      // Read directory contents
      const entries = await fs.readdir(eventsDir, { withFileTypes: true })

      // Filter to files only (exclude directories)
      const files = entries
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .sort()

      return files
    },
    convertError
  )
}
