/**
 * 槽位 order 守卫。
 *
 * ui-slots 对**相等的 order 保持注册顺序**（ui-slots/src/index.ts 的排序比较器），
 * 而注册顺序取决于插件物化次序 —— 撞车的两个条目谁在前是不确定的，只在两者同时
 * 可见时才看得出来。本插件曾用 `order: 20`，与 DSH 队列面板（QueueDock.tsx）相同。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = new URL('../client.js', import.meta.url)

/** 取出某个槽位注册语句里的 order。 */
function slotOrder(source, slot) {
  // 锚定 `slots.inject('<slot>'`：槽位名在注释里也出现过，直接 indexOf 会命中注释。
  const at = source.indexOf(`slots.inject('${slot}'`)
  assert.notEqual(at, -1, `没找到 ${slot} 的注册`)
  const match = source.slice(at, at + 600).match(/order:\s*(\d+)/u)
  assert.ok(match, `${slot} 的注册里没有 order`)
  return Number(match[1])
}

test('弹窗槽位的 order 不与 DSH 内置面板撞车', () => {
  const source = readFileSync(SOURCE, 'utf8')
  const dock = slotOrder(source, 'conversation.input.dock')
  // 内置：todo=0、queue=20。相等 order 会让相对位置取决于物化次序。
  assert.ok(![0, 20].includes(dock), `弹窗用了 order ${dock}，与内置面板（0=todo, 20=queue）撞车`)
})

test('药丸按钮排在硬邦邦（30）之后，位置固定', () => {
  const source = readFileSync(SOURCE, 'utf8')
  assert.equal(slotOrder(source, 'conversation.input.left'), 31, '药丸应紧邻硬邦邦插件右侧')
})

test('两个槽位都以 NS 作为 id', () => {
  const source = readFileSync(SOURCE, 'utf8')
  const ids = source.match(/\bid:\s*NS,/gu) ?? []
  assert.equal(ids.length, 2, '药丸与弹窗两个槽位都应以 NS 作为 id')
})
