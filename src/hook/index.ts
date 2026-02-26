#!/usr/bin/env node

import { initialState } from '../types/state'
import { topicName } from '../types/telegram'

/**
 * Claude Code AFK Hook
 * Handles permission requests and tool approvals from Telegram
 */

const main = async (): Promise<void> => {
  try {
    // Initialize state
    const state = initialState

    // Log startup
    console.log('AFK Hook initialized')
    console.log('Session slots available:', Object.keys(state.slots).length)

    // Example: Generate topic name for S1
    const topic = topicName(1, 'claude-code')
    console.log('Primary topic:', topic)

  } catch (error) {
    console.error('Hook error:', error)
    process.exit(1)
  }
}

main()
