/**
 * 表单控件可读性守卫。
 *
 * 这条来自实机反馈：深色主题下模板下拉的选项看着是**空白**的，鼠标悬停才显出
 * 文字。成因是 `.si-select` 用了 `background: transparent` —— 原生 `<select>` 的
 * 弹层由**操作系统**绘制，不吃 CSS 背景，于是 option 落在系统浅色面板上，却继承了
 * 深色主题的白色文字：白字白底，只有系统高亮反白时才看得见。
 *
 * 规则：承载文字的输入控件必须有**实体**背景，不能靠透明继承。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = new URL('../client.js', import.meta.url)

/** 取出某个 CSS 规则块。 */
function ruleBlock(source, selector) {
  const at = source.indexOf(`${selector} {`)
  assert.notEqual(at, -1, `没找到 ${selector} 规则`)
  const end = source.indexOf('}', at)
  return source.slice(at, end)
}

test('下拉框与文本框都用实体背景', () => {
  const source = readFileSync(SOURCE, 'utf8')
  for (const selector of ['.si-select', '.si-textarea', '.si-out']) {
    const block = ruleBlock(source, selector)
    assert.doesNotMatch(block, /background:\s*transparent/u,
      `${selector} 不能是透明背景 —— 原生控件弹层不吃 CSS，会变成白字白底`)
    assert.match(block, /background:\s*var\(--dsw-alias-bg-layer-\d\)/u,
      `${selector} 应使用实体背景 token`)
  }
})

test('原生 option 显式指定背景与文字色', () => {
  const source = readFileSync(SOURCE, 'utf8')
  assert.match(source, /\.si-select option\s*\{/u, 'option 需要单独的样式规则')
  const block = ruleBlock(source, '.si-select option')
  assert.match(block, /background:/u, 'option 必须显式给背景')
  assert.match(block, /color:/u, 'option 必须显式给文字色')
})
