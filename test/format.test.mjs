import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildStructured,
  describeTemplate,
  extractJson,
  matchSections,
  sectionTitles,
} from '../lib/format.js'

/** 一个两小节模板。 */
const template = {
  id: 'demo',
  name: '演示',
  sections: [
    { title: '目标', hint: '要干什么' },
    { title: '约束', hint: '不能干什么' },
  ],
}

test('extractJson 直接解析', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 })
})

test('extractJson 剥代码块围栏', () => {
  const raw = '好的，结果如下：\n```json\n{"a":1}\n```\n希望有帮助'
  assert.deepEqual(extractJson(raw), { a: 1 })
})

test('extractJson 抠首尾大括号', () => {
  assert.deepEqual(extractJson('前置废话 {"a":1} 后置废话'), { a: 1 })
})

test('extractJson 拒绝数组与非法内容', () => {
  assert.equal(extractJson('[1,2]'), null)
  assert.equal(extractJson('完全不是 JSON'), null)
  assert.equal(extractJson(''), null)
  assert.equal(extractJson(null), null)
})

test('sectionTitles 只保留有效标题', () => {
  assert.deepEqual(sectionTitles(template), ['目标', '约束'])
  assert.deepEqual(sectionTitles(null), [])
  assert.deepEqual(sectionTitles({ sections: [{ title: '  ' }, { title: '有' }] }), ['有'])
})

test('matchSections 精确匹配与归一化匹配', () => {
  const titles = ['目标', '约束']
  const exact = matchSections({ 目标: '做A', 约束: '别用B' }, titles).values
  assert.equal(exact['目标'], '做A')
  assert.equal(exact['约束'], '别用B')

  // 模型可能加冒号、星号、空格。
  const loose = matchSections({ '## 目标：': '做A', '**约束**': '别用B' }, titles).values
  assert.equal(loose['目标'], '做A')
  assert.equal(loose['约束'], '别用B')
})

test('matchSections 缺失的小节留空，不猜语义相近', () => {
  const values = matchSections({ 目的: '做A' }, ['目标', '约束']).values
  assert.equal(values['目标'], '')
  assert.equal(values['约束'], '')
})

test('matchSections 数组与对象值转成字符串', () => {
  const values = matchSections({ 目标: ['甲', '乙'], 约束: { a: 1 } }, ['目标', '约束']).values
  assert.equal(values['目标'], '甲\n乙')
  assert.match(values['约束'], /"a": 1/)
})

test('buildStructured 正常路径不降级', () => {
  const result = buildStructured('{"目标":"做A","约束":"别用B"}', template)
  assert.equal(result.degraded, false)
  assert.deepEqual(result.missing, [])
  assert.match(result.text, /## 目标\n\n做A/)
  assert.match(result.text, /## 约束\n\n别用B/)
})

test('buildStructured 标记缺失小节', () => {
  const result = buildStructured('{"目标":"做A"}', template)
  assert.equal(result.degraded, false)
  assert.deepEqual(result.missing, ['约束'])
  assert.match(result.text, /（未提供）/)
})

test('buildStructured 解析失败时降级但保留骨架', () => {
  const result = buildStructured('模型胡说八道没有 JSON', template)
  assert.equal(result.degraded, true)
  assert.match(result.text, /## 目标/)
  assert.match(result.text, /## 约束/)
  assert.match(result.text, /模型胡说八道没有 JSON/)
  assert.equal(result.raw, '模型胡说八道没有 JSON')
})

test('buildStructured 空输出也降级且不崩', () => {
  const result = buildStructured('', template)
  assert.equal(result.degraded, true)
  assert.match(result.text, /模型没有返回内容/)
})

test('buildStructured 模板无小节时退回原文', () => {
  const result = buildStructured('随便什么', { sections: [] })
  assert.equal(result.degraded, true)
  assert.equal(result.text, '随便什么')
})

test('describeTemplate 列出小节与要求', () => {
  const spec = describeTemplate(template)
  assert.match(spec, /只输出一个 JSON 对象/)
  assert.match(spec, /"目标"/)
  assert.match(spec, /要干什么/)
  assert.equal(describeTemplate(null), '')
})

test('extractJson 尾随散文里的 } 不影响解析', () => {
  assert.deepEqual(extractJson('{"目标":"A"}\n\n不需要时请返回 {}'), { 目标: 'A' })
  assert.deepEqual(extractJson('{"a":1} 备注：这个 } 很关键'), { a: 1 })
  assert.deepEqual(extractJson('{"a":1} 以及 {"b":2}'), { a: 1 })
  assert.deepEqual(extractJson('用 {} 表示空。结果：{"目标":"A"}'), { 目标: 'A' })
})

test('extractJson 配平扫描感知字符串与转义', () => {
  assert.deepEqual(extractJson('{"code":"if (x) { y() }"}'), { code: 'if (x) { y() }' })
  assert.deepEqual(extractJson('{"code":"a}b"}'), { code: 'a}b' })
  assert.deepEqual(extractJson('{"a":{"b":{"c":1}}}'), { a: { b: { c: 1 } } })
})

test('extractJson 多个围栏块时逐个尝试', () => {
  const raw = '```json\n{"a":\n```\n```json\n{"目标":"A"}\n```'
  assert.deepEqual(extractJson(raw), { 目标: 'A' })
})

test('matchSections 认得反引号与引用块装饰', () => {
  assert.equal(matchSections({ '`目标`': 'x' }, ['目标']).values['目标'], 'x')
  assert.equal(matchSections({ '> 目标': 'y' }, ['目标']).values['目标'], 'y')
})

test('buildStructured 键名全不匹配时降级并暴露模型用的键', () => {
  const result = buildStructured('{"详细目标":"非常重要的内容","限制":"别用 X"}', {
    sections: [{ title: '目标' }],
  })
  assert.equal(result.degraded, true, '不能说成功')
  assert.deepEqual(result.unconsumed, ['详细目标', '限制'])
  assert.match(result.text, /非常重要的内容/, '模型内容不能丢')
  assert.match(result.text, /别用 X/)
})

test('buildStructured 部分匹配时不误判降级', () => {
  const result = buildStructured('{"目标":"做A"}', {
    sections: [{ title: '目标' }, { title: '约束' }],
  })
  assert.equal(result.degraded, false)
  assert.deepEqual(result.missing, ['约束'])
})

test('matchSections 不污染 Object.prototype', () => {
  // 必须用 JSON.parse 构造：对象字面量里的 `__proto__:` 是设置原型的语法，
  // 根本不会变成普通键，那样测不到这条路径。
  const parsed = JSON.parse('{"__proto__":"x","目标":"做A"}')
  const result = matchSections(parsed, ['目标'])
  assert.equal({}.x, undefined)
  assert.equal(Object.prototype.x, undefined)
  assert.equal(result.values['目标'], '做A')
  assert.deepEqual(result.unconsumed, ['__proto__'])
})
