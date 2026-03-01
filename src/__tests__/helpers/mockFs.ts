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
