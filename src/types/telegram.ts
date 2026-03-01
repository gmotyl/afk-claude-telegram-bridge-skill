export interface TelegramMessage {
  readonly messageId: number
  readonly chatId: number
  readonly topicId: number
  readonly text: string
  readonly timestamp: Date
}

export interface TelegramTopic {
  readonly topicId: number
  readonly name: string
  readonly description: string
}

export const topicName = (slotNum: number, projectName: string): string =>
  `S${slotNum} - ${projectName}`
