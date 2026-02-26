#!/usr/bin/env node

import { initialState, State } from '../types/state'
import { isSlotActive, cleanupStaleSlots } from '../core/state'

/**
 * Bridge Daemon
 * Manages session state and message routing between Telegram and Claude Code
 */

const main = async (): Promise<void> => {
  try {
    // Initialize state
    let state: State = initialState

    // Log startup
    console.log('Bridge Daemon started')
    console.log('Initial slots:', Object.keys(state.slots).length)

    // Cleanup stale slots every minute (placeholder)
    const timeoutMs = 5 * 60 * 1000 // 5 minutes
    state = cleanupStaleSlots(state, timeoutMs, new Date())

    console.log('Daemon ready')

    // Keep process alive
    await new Promise(() => {})

  } catch (error) {
    console.error('Daemon error:', error)
    process.exit(1)
  }
}

main()
