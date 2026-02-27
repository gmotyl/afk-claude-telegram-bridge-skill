export interface Slot {
  readonly projectName: string
  readonly activatedAt: Date
  readonly lastHeartbeat: Date
}

export interface PendingStop {
  readonly eventId: string
  readonly slotNum: number
  readonly lastMessage: string
  readonly timestamp: string
  readonly telegramMessageId?: number
}

export interface State {
  readonly slots: Readonly<Record<number, Slot | undefined>>
  readonly pendingStops: Readonly<Record<string, PendingStop>>
}

export const initialState: State = {
  slots: { 1: undefined, 2: undefined, 3: undefined, 4: undefined },
  pendingStops: {}
}
