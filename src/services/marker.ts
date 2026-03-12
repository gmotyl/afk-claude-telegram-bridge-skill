import * as fs from 'fs'
import * as path from 'path'

const MARKER_FILE = 'active_count'

export const readActiveCount = (configDir: string): number => {
  try {
    const content = fs.readFileSync(path.join(configDir, MARKER_FILE), 'utf-8').trim()
    const n = parseInt(content, 10)
    return isNaN(n) ? 0 : n
  } catch {
    return 0
  }
}

export const writeActiveCount = (configDir: string, count: number): void => {
  const filePath = path.join(configDir, MARKER_FILE)
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, String(Math.max(0, count)), 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

export const incrementActiveCount = (configDir: string): void => {
  writeActiveCount(configDir, readActiveCount(configDir) + 1)
}

export const decrementActiveCount = (configDir: string): void => {
  writeActiveCount(configDir, readActiveCount(configDir) - 1)
}
