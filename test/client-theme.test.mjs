/**
 * 主题变量守卫。
 *
 * CSS 变量写错名字**不会报错**：`color: var(--typo)` 只是回退到继承色，
 * `background: var(--typo)` 整条声明失效。表现是弹窗透明、按钮白底白字、
 * 警告没有颜色 —— 全靠肉眼在真机上发现，而且深浅色主题各坏一次。
 *
 * 这个用例把 client.js 里出现的每个 `--dsw-alias-*` 与 ui-theme 的定义表对一遍。
 *
 * 主题源码的位置通过 `DSH_CHECKOUT` 指定（默认尝试几个常见位置）。找不到时
 * **显式跳过并打印原因**，绝不在"没真查"的情况下假装通过 —— 那正是假绿的来源。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const CLIENT = new URL('../client.js', import.meta.url)
const THEME_RELATIVE = 'packages/client/ui-theme/src/styles/design-platform.css'

/** 候选的 harness 源码根。 */
const ROOTS = [
  process.env.DSH_CHECKOUT,
  'D:/docker_and_big_models/开源仓库-分析区/deepseek-harness',
].filter((value) => typeof value === 'string' && value.length > 0)

test('client.js 用到的每个 --dsw-alias-* 都在主题里定义', () => {
  const client = readFileSync(CLIENT, 'utf8')
  const used = new Set(client.match(/--dsw-alias-[a-z0-9-]+/gu) ?? [])
  assert.ok(used.size > 0, '应该至少用到一些主题变量')

  const themePath = ROOTS.map((root) => join(root, THEME_RELATIVE)).find((path) => existsSync(path))
  if (themePath === undefined) {
    throw new Error(
      `找不到 ${THEME_RELATIVE}。设 DSH_CHECKOUT 指向 harness 源码根再跑 —— `
      + '这条检查没有"跳过"档：不查就等于没测。',
    )
  }

  const theme = readFileSync(themePath, 'utf8')
  const missing = []
  for (const name of used) {
    // 只认真正的定义（`--name:`），避免把别处的引用当定义。
    if (!theme.includes(`${name}:`)) missing.push(name)
  }
  assert.deepEqual(missing, [], `这些变量在主题里没有定义：${missing.join(', ')}`)
})
