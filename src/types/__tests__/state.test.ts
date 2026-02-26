import { State, Slot, initialState } from '../state'

describe('State and Slot', () => {
  it('Slot has required fields', () => {
    const now = new Date()
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: now,
      lastHeartbeat: now
    }

    expect(slot.projectName).toBe('metro')
    expect(slot.activatedAt).toBe(now)
    expect(slot.lastHeartbeat).toBe(now)
  })

  it('Slot is readonly', () => {
    const slot: Slot = {
      projectName: 'metro',
      activatedAt: new Date(),
      lastHeartbeat: new Date()
    }

    // @ts-expect-error - readonly
    slot.projectName = 'modified'
    expect(true).toBe(true)
  })

  it('State has slots record with 4 slots', () => {
    const state: State = {
      slots: {
        1: undefined,
        2: undefined,
        3: undefined,
        4: undefined
      }
    }

    expect(Object.keys(state.slots)).toHaveLength(4)
    expect(state.slots[1]).toBeUndefined()
    expect(state.slots[4]).toBeUndefined()
  })

  it('State.slots is readonly', () => {
    const state: State = {
      slots: { 1: undefined, 2: undefined, 3: undefined, 4: undefined }
    }

    // @ts-expect-error - readonly
    state.slots[1] = { projectName: 'test', activatedAt: new Date(), lastHeartbeat: new Date() }
    expect(true).toBe(true)
  })

  it('initialState creates empty state', () => {
    expect(initialState.slots[1]).toBeUndefined()
    expect(initialState.slots[2]).toBeUndefined()
    expect(initialState.slots[3]).toBeUndefined()
    expect(initialState.slots[4]).toBeUndefined()
  })
})
