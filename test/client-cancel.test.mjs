/**
 * 取消语义守卫。
 *
 * 两条都踩过坑：
 *  - 用户主动关窗 → 触发 abort → 被当成"超时"报出来（一次自己取消的请求显示
 *    "等太久了，这次请求已中断"）。超时和主动取消都是 AbortError，必须靠别的东西区分。
 *  - 手写 Esc 监听抢先于 `useModalLayer`，且缺少 IME 守卫 —— 中文输入法按 Esc
 *    取消候选框时弹窗会被关掉。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = new URL('../client.js', import.meta.url)

test('超时与主动取消在代码里是分开判定的', () => {
  const source = readFileSync(SOURCE, 'utf8')
  // 必须有独立的超时标记，且只在超时定时器里置位。
  assert.match(source, /timedOutRef/, '缺少 timedOutRef 区分超时与主动取消')
  assert.match(source, /timedOutRef\.current = true[^}]*controller\.abort\(\)/,
    '超时标记必须在超时定时器里与 abort 一起置位')
  assert.match(source, /if \(timedOutRef\.current\) actions\.fail/, '超时才报超时')
  assert.match(source, /else actions\.setIdle\(\)/, '主动取消应回到 idle 而不是报错')
})

test('Esc 只交给 useModalLayer，不再有手写 capture 监听', () => {
  const source = readFileSync(SOURCE, 'utf8')
  assert.match(source, /useModalLayer\(dialogRef, active/, '必须用 useModalLayer 接管 Esc')
  // 手写版的特征：capture 阶段的 keydown 监听。用 [\s\S] 而不是 [^)]，
  // 因为箭头函数体里的括号会把 [^)] 截断，导致这条检查形同虚设（实测过）。
  assert.doesNotMatch(source, /addEventListener\('keydown',[\s\S]*?,\s*true\)/,
    '不应再有 capture 阶段的 keydown 监听 —— 它会绕开 useModalLayer 的 IME 守卫')
})
