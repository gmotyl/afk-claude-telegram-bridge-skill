import { TelegramMessage, TelegramTopic, topicName } from '../telegram'

describe('Telegram types', () => {
  it('TelegramMessage has required fields', () => {
    const msg: TelegramMessage = {
      messageId: 123,
      chatId: 456,
      topicId: 789,
      text: 'hello',
      timestamp: new Date('2024-01-01')
    }

    expect(msg.messageId).toBe(123)
    expect(msg.chatId).toBe(456)
    expect(msg.topicId).toBe(789)
    expect(msg.text).toBe('hello')
    expect(msg.timestamp).toEqual(new Date('2024-01-01'))
  })

  it('TelegramMessage is readonly', () => {
    const msg: TelegramMessage = {
      messageId: 123,
      chatId: 456,
      topicId: 789,
      text: 'hello',
      timestamp: new Date()
    }

    // @ts-expect-error - readonly
    msg.text = 'modified'
    expect(true).toBe(true)
  })

  it('TelegramTopic has required fields', () => {
    const topic: TelegramTopic = {
      topicId: 789,
      name: 'S1 - metro',
      description: 'Session 1: metro'
    }

    expect(topic.topicId).toBe(789)
    expect(topic.name).toBe('S1 - metro')
    expect(topic.description).toBe('Session 1: metro')
  })

  it('topicName generates correct format', () => {
    expect(topicName(1, 'metro')).toBe('S1 - metro')
    expect(topicName(2, 'alokai')).toBe('S2 - alokai')
    expect(topicName(3, 'ch')).toBe('S3 - ch')
    expect(topicName(4, 'doterra')).toBe('S4 - doterra')
  })

  it('topicName handles special characters in project name', () => {
    expect(topicName(1, 'my-project')).toBe('S1 - my-project')
    expect(topicName(1, 'project_name')).toBe('S1 - project_name')
  })
})
