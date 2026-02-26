export interface Slot {
  readonly projectName: string
  readonly activatedAt: Date
  readonly lastHeartbeat: Date
}

export interface State {
  readonly slots: Readonly<Record<number, Slot | undefined>>
}

export const initialState: State = {
  slots: { 1: undefined, 2: undefined, 3: undefined, 4: undefined }
}
