/**
 * 上下文档位的状态规整与迁移守卫。
 *
 * 两个真实风险：
 *  - 档位 id 拼错（或旧版配置根本没有这个字段）时若回落到 `off`，用户会觉得
 *    "这插件读不懂我说的话"，却不会想到是档位名写错了。
 *  - 旧版 `state.json` 只有 `context.maxChars`。换档位后如果直接忽略它，
 *    用户配好的预算就无声失效了。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULTS, contextPresetOf, sanitizeState } from '../lib/state.js'

test('默认状态带一个合法档位', () => {
  const state = sanitizeState({}, DEFAULTS)
  assert.equal(state.context.preset, DEFAULTS.context.preset)
  assert.equal(typeof state.context.preset, 'string')
})

test('合法档位原样保留', () => {
  for (const preset of ['off', 'brief', 'standard', 'deep', 'full']) {
    assert.equal(sanitizeState({ context: { preset } }).context.preset, preset)
  }
})

test('非法/缺失档位回落默认档，绝不回落 off', () => {
  for (const preset of ['nonsense', '', null, undefined, 42, {}]) {
    const state = sanitizeState({ context: { preset } })
    assert.equal(state.context.preset, DEFAULTS.context.preset, `preset=${String(preset)} 应回落默认档`)
  }
})

test('defaults 局部覆盖时也能得到合法档位', () => {
  // apply() 会传一份不完整的 defaults（取自插件行配置），那条路径不能抛也不能给出非法值。
  const state = sanitizeState({}, { enabled: false })
  assert.equal(state.context.preset, DEFAULTS.context.preset)
  assert.equal(state.enabled, false)
})

test('contextPresetOf 认识旧版的 maxChars 并迁移到档位', () => {
  assert.equal(contextPresetOf({ context: { maxChars: 12000 } }), 'standard')
  assert.equal(contextPresetOf({ context: { maxChars: 4000 } }), 'brief')
  assert.equal(contextPresetOf({ context: { maxChars: 48000 } }), 'full')
  assert.equal(contextPresetOf({ context: { maxChars: 0 } }), 'off')
})

test('contextPresetOf 新字段优先于旧的 maxChars', () => {
  assert.equal(contextPresetOf({ context: { preset: 'deep', maxChars: 4000 } }), 'deep')
})

test('contextPresetOf 什么都没有时给默认档', () => {
  assert.equal(contextPresetOf({}), DEFAULTS.context.preset)
  assert.equal(contextPresetOf(null), DEFAULTS.context.preset)
  assert.equal(contextPresetOf({ context: null }), DEFAULTS.context.preset)
})
