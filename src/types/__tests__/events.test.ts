import * as events from '../events'

describe('IpcEvent', () => {
  it('SessionStart event has correct shape', () => {
    const event = events.sessionStart(1, 'metro')
    expect(event._tag).toBe('SessionStart')
    if (event._tag === 'SessionStart') {
      expect(event.slotNum).toBe(1)
      expect(event.projectName).toBe('metro')
    }
  })

  it('SessionEnd event has correct shape', () => {
    const event = events.sessionEnd(2)
    expect(event._tag).toBe('SessionEnd')
    if (event._tag === 'SessionEnd') {
      expect(event.slotNum).toBe(2)
    }
  })

  it('Heartbeat event has correct shape', () => {
    const event = events.heartbeat(3)
    expect(event._tag).toBe('Heartbeat')
    if (event._tag === 'Heartbeat') {
      expect(event.slotNum).toBe(3)
    }
  })

  it('Message event has correct shape', () => {
    const event = events.message('hello world', 4)
    expect(event._tag).toBe('Message')
    if (event._tag === 'Message') {
      expect(event.slotNum).toBe(4)
      expect(event.text).toBe('hello world')
    }
  })

  it('PermissionRequest event has correct shape', () => {
    const event = events.permissionRequest('uuid-123', 'Bash', 'npm install')
    expect(event._tag).toBe('PermissionRequest')
    if (event._tag === 'PermissionRequest') {
      expect(event.requestId).toBe('uuid-123')
      expect(event.tool).toBe('Bash')
      expect(event.command).toBe('npm install')
    }
  })

  it('SessionStart can be stringified to JSON', () => {
    const event = events.sessionStart(1, 'metro')
    const json = JSON.stringify(event)
    const parsed = JSON.parse(json)
    expect(parsed._tag).toBe('SessionStart')
    expect(parsed.slotNum).toBe(1)
    expect(parsed.projectName).toBe('metro')
  })
})
