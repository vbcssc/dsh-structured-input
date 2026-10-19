/**
 * 浏览器半边的 hook 顺序守卫。
 *
 * 为什么需要这条：弹窗组件在 `active === false` 时提前 `return null`。任何一个
 * hook 落到那个 return **之后**，`active` 从 false 变 true 时 hook 数量就会变，
 * React 抛 "Rendered more hooks than during the previous render" —— 表现是
 * "点了按钮没反应"（错误边界把条目隔离掉），而纯逻辑测试一条都抓不到。
 *
 * 这个用例把 client.js 的 factory 体单独求值，用带**钩子计数**的最小 React 模拟
 * 走一遍「关→开→关→开」，断言每次渲染的 hook 数量完全一致。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = new URL('../client.js', import.meta.url)

/** 载入 client.js 的 factory（剥掉浏览器外壳，factory 体一字不改）。 */
async function loadFactory() {
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args),
    setInterval: () => 0, clearInterval() {},
  }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild() {} },
    body: {},
    activeElement: null,
  }

  const source = readFileSync(SOURCE, 'utf8')
  const start = source.indexOf('factory(require) {')
  const body = source.slice(source.indexOf('{', start) + 1, source.lastIndexOf('  },'))
  const module = `export function factory(require){${body}\n}`
  const dataUrl = `data:text/javascript;base64,${Buffer.from(module, 'utf8').toString('base64')}`
  const { factory } = await import(dataUrl)
  return factory
}

test('弹窗组件的 hook 数量在开关循环中保持稳定', async () => {
  const factory = await loadFactory()

  let hookCalls = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    // 与真实 React 一致：传 null/undefined 直接抛。之前的宽松 mock 把
    // `cloneElement(null)` 的崩溃掩盖掉了 —— 那种 mock 让测试绿而线上崩。
    cloneElement: (element, props) => {
      if (element === null || typeof element !== 'object') {
        throw new TypeError(`React.cloneElement(...): The argument must be a React element, but you passed ${element}.`)
      }
      return { ...element, props: { ...element.props, ...props } }
    },
    useState: (initial) => { hookCalls += 1; return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useRef: (initial) => { hookCalls += 1; return { current: initial } },
    useEffect: () => { hookCalls += 1 },
    useCallback: (fn) => { hookCalls += 1; return fn },
    useLayoutEffect: () => { hookCalls += 1 },
  }
  const requireMock = (specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-store') {
      return { defineStore: (decl) => ({ spec: decl, create: () => ({ actions: {}, getSnapshot: () => decl.init(), subscribe: () => () => {} }) }) }
    }
    if (specifier === 'react-dom') return { createPortal: (element) => element }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      // 假实现也要**占一个 hook**：真实 useModalLayer 内部会调 useRef +
      // useLayoutEffect，不计数的话这条测试会漏掉 hook 数量变化的可能。
      return { useModalLayer: () => { hookCalls += 2 } }
    }
    throw new Error(`unexpected require: ${specifier}`)
  }

  const plugin = factory(requireMock)
  const registered = []
  const ctx = {
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    slots: { inject(_key, callback) { callback() }, register(options, component) { registered.push({ options, component }); return () => {} } },
    get: () => null,
  }
  plugin.apply(ctx, {})

  const dialog = registered.find((entry) => entry.options.name === 'conversation.input.dock')
  assert.ok(dialog, '弹窗必须注册到 conversation.input.dock')

  const store = { active: false, draft: '', templateId: '', phase: 'idle', result: null, error: '', contextInfo: null, meta: null }
  const render = (active) => {
    store.active = active
    hookCalls = 0
    dialog.component({ sessionId: 's1', useStore: (selector) => selector(store), actions: { close() {}, open() {} } })
    return hookCalls
  }

  const counts = [render(false), render(true), render(false), render(true)]
  for (const [index, count] of counts.entries()) {
    assert.equal(count, counts[0], `第 ${index + 1} 次渲染的 hook 数量 (${count}) 与首次 (${counts[0]}) 不一致 —— 有 hook 落在提前 return 之后`)
  }
})
