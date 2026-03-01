#!/usr/bin/env node
/**
 * @module cli
 * CLI entry point for activate/deactivate commands.
 * Usage: node cli.js activate <sessionId> <project> [topicName]
 *        node cli.js deactivate <sessionId>
 */

import * as E from 'fp-ts/Either'
import { activate } from './activate'
import { deactivate } from './deactivate'
import { errorMessage } from '../types/errors'

const configDir = process.env['TELEGRAM_BRIDGE_CONFIG'] || `${process.env['HOME']}/.claude/hooks/telegram-bridge`

const args = process.argv.slice(2)
const command = args[0]

const run = async (): Promise<void> => {
  switch (command) {
    case 'activate': {
      const verbose = args.includes('--verbose')
      const positionalArgs = args.slice(1).filter(a => !a.startsWith('--'))
      const sessionId = positionalArgs[0]
      const project = positionalArgs[1]
      const topicName = positionalArgs[2] || project

      if (!sessionId || !project) {
        console.error('Usage: cli.js activate <sessionId> <project> [topicName] [--verbose]')
        process.exit(1)
        return
      }

      const result = await activate(configDir, sessionId, project, topicName ?? project, verbose)()

      if (E.isLeft(result)) {
        console.error(`Activation failed: ${errorMessage(result.left)}`)
        process.exit(1)
      }

      const r = result.right
      console.log(`AFK mode activated!`)
      console.log(`  Slot: ${r.slotNum}`)
      console.log(`  Session: ${r.sessionId}`)
      console.log(`  Topic: ${r.topicName}`)
      if (verbose) console.log(`  Verbose: enabled`)
      if (r.threadId) console.log(`  Thread: ${r.threadId} (reattached)`)
      console.log(`  Daemon PID: ${r.daemonPid}`)
      break
    }

    case 'deactivate': {
      const sessionId = args[1]

      if (!sessionId) {
        console.error('Usage: cli.js deactivate <sessionId>')
        process.exit(1)
      }

      const result = await deactivate(configDir, sessionId)()

      if (E.isLeft(result)) {
        console.error(`Deactivation failed: ${errorMessage(result.left)}`)
        process.exit(1)
      }

      console.log('AFK mode deactivated.')
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.error('Usage: cli.js <activate|deactivate> [args...]')
      process.exit(1)
  }
}

run().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
