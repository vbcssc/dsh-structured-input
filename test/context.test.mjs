import assert from 'node:assert/strict'
import { test } from 'node:test'

import { composeUserContent, messageText, projectTranscript, DEFAULT_MAX_CHARS } from '../lib/context.js'

/** 造一条消息。 */
const msg = (role, text) => ({ role, content: [{ type: 'text', text }] })

test('messageText 只取文本块，工具调用压成一行', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '这是思考过程，不该出现' },
      { type: 'text', text: '我来看看' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
    ],
  }
  const line = messageText(message)
  assert.match(line, /^【助手】/)
  assert.match(line, /我来看看/)
  assert.match(line, /\[调用工具 read\]/)
  assert.doesNotMatch(line, /思考过程/)
  assert.doesNotMatch(line, /a\.ts/, '工具参数不应外泄')
})

test('messageText 保留图片/文件占位，丢弃纯推理块', () => {
  // 占位是有用的：用户说"改这个图"时，模型至少要知道这里确实有图。
  assert.equal(messageText({ role: 'user', content: [{ type: 'image' }] }), '【用户】[图片]')
  assert.equal(messageText({ role: 'user', content: [{ type: 'file' }] }), '【用户】[文件附件]')
  // 纯推理块对结构化生成没有价值，丢掉。
  assert.equal(messageText({ role: 'assistant', content: [{ type: 'reasoning', text: '想' }] }), '')
  assert.equal(messageText({ role: 'user', content: [] }), '')
  assert.equal(messageText(null), '')
  assert.equal(messageText({ role: 'user' }), '')
})

test('projectTranscript 从新到旧挑，超预算的丢掉旧的', () => {
  const messages = []
  for (let i = 0; i < 10; i += 1) messages.push(msg('user', `第${i}条`))
  const result = projectTranscript(messages, { maxChars: 40 })
  assert.ok(result.usedMessages > 0)
  assert.ok(result.usedMessages < 10, '应该裁掉了旧消息')
  assert.ok(result.omittedMessages > 0)
  assert.match(result.text, /更早的 \d+ 条对话已省略/)
  // 最新的那一条一定在。
  assert.match(result.text, /第9条/)
})

test('projectTranscript 预算足够时不裁剪', () => {
  const messages = [msg('user', 'a'), msg('assistant', 'b')]
  const result = projectTranscript(messages, { maxChars: 1000 })
  assert.equal(result.omittedMessages, 0)
  assert.equal(result.usedMessages, 2)
  assert.doesNotMatch(result.text, /已省略/)
})

test('projectTranscript 空历史返回空串', () => {
  const result = projectTranscript([], { maxChars: 1000 })
  assert.equal(result.text, '')
  assert.equal(result.usedMessages, 0)
})

test('projectTranscript 默认预算', () => {
  const messages = [msg('user', 'x'.repeat(100))]
  const result = projectTranscript(messages, undefined)
  assert.ok(result.chars > 0)
  assert.ok(DEFAULT_MAX_CHARS > 1000)
})

test('composeUserContent 把上下文放在需求前面', () => {
  const text = composeUserContent('改一下颜色', { text: '【用户】之前说要蓝色' })
  assert.ok(text.indexOf('会话上下文') < text.indexOf('这次的需求'))
  assert.match(text, /改一下颜色/)
  assert.match(text, /之前说要蓝色/)
})

test('composeUserContent 无上下文时只返回需求', () => {
  assert.equal(composeUserContent('  干活  ', { text: '' }), '干活')
  assert.equal(composeUserContent('干活', null), '干活')
})

test('projectTranscript 单条超预算时截断保留，而不是整条丢弃', () => {
  const huge = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }]
  const result = projectTranscript(huge, { maxChars: 100 })
  assert.equal(result.usedMessages, 1, '最新一条必须保住')
  assert.match(result.text, /条已截断/)
  assert.ok(result.chars <= 100, `预算是硬上限，实际 ${result.chars}`)
})

test('projectTranscript 预算小于截断标注时返回空串（合理降级）', () => {
  const huge = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }]
  for (const maxChars of [1, 7]) {
    const result = projectTranscript(huge, { maxChars })
    assert.equal(result.usedMessages, 0)
    assert.equal(result.text, '')
  }
})

test('projectTranscript 任何预算下都不超上限', () => {
  const messages = []
  for (let i = 0; i < 20; i += 1) messages.push(msg('user', '字'.repeat(i * 10)))
  for (const maxChars of [10, 50, 200, 1000]) {
    const result = projectTranscript(messages, { maxChars })
    assert.ok(result.chars <= maxChars, `maxChars=${maxChars} 却产出 ${result.chars}`)
  }
})

test('messageText 截断不劈开 emoji 代理对', () => {
  const message = { role: 'user', content: [{ type: 'text', text: 'a' + '😀'.repeat(1200) }] }
  assert.equal(messageText(message).isWellFormed(), true)
})

test('projectTranscript 的省略表头也计入预算', () => {
  const messages = []
  for (let i = 0; i < 20; i += 1) messages.push(msg('user', '字'.repeat(20)))
  for (const maxChars of [10, 20, 25, 35, 40, 100]) {
    const result = projectTranscript(messages, { maxChars })
    assert.ok(result.chars <= maxChars, `maxChars=${maxChars} 却产出 ${result.chars}`)
  }
})

test('messageText 不把原型链成员名当已知角色', () => {
  const line = messageText({ role: 'constructor', content: [{ type: 'text', text: 'a' }] })
  assert.equal(line, '【constructor】a')
  assert.doesNotMatch(line, /native code/)
  const line2 = messageText({ role: 'toString', content: [{ type: 'text', text: 'b' }] })
  assert.equal(line2, '【toString】b')
})
