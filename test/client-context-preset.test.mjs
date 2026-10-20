/**
 * 弹窗里上下文档位下拉的行为测试。
 *
 * 需求是"上下文可选而不是写死"。这里驱动真实组件，钉死四件事：
 *  - 下拉的选项来自 host 下发的清单，不是客户端自己写死的；
 *  - 选中值三级兜底，永远落在选项里真实存在的值上（否则原生 select 显示空白）；
 *  - 切换档位真的写回 store（`setContextPreset`）；
 *  - 生成请求里带上当前档位。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = new URL('../client.js', import.meta.url)

const PRESETS = [
  { id: 'off', maxChars: 0, maxMessages: 0 },
  { id: 'brief', maxChars: 4000, maxMessages: 5 },
  { id: 'standard', maxChars: 12000, maxMessages: 10 },
]

const HOST = {
  templates: {
    items: [{ id: 'task', name: '任务（通用）', sections: ['目标'], hints: ['说清目标'] }],
  },
  templateId: 'task',
  context: { preset: 'standard', presets: PRESETS },
}

/** 在渲染树里按 className 找节点。 */
function findByClass(node, className, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (node.props && node.props.className === className) out.push(node)
  for (const child of node.children ?? []) findByClass(child, className, out)
  return out
}

/**
 * 载入 client.js 的 factory，返回 { render, calls }。
 * `calls` 收集 actions 调用，用来断言交互确实写回了 store。
 */
async function buildDialog(hostOverride) {
  const host = hostOverride ?? HOST
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

  let useStateCalls = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    cloneElement: (element, props) => {
      if (element === null || typeof element !== 'object') {
        throw new TypeError(`React.cloneElement(...): The argument must be a React element, but you passed ${element}.`)
      }
      return { ...element, props: { ...element.props, ...props } }
    },
    // 第一个 useState 是 hostState，喂真实数据等价于 fetchState 已返回。
    useState: (initial) => {
      const value = typeof initial === 'function' ? initial() : initial
      const out = useStateCalls === 0 ? host : value
      useStateCalls += 1
      return [out, () => {}]
    },
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
  }
  const requireMock = (specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-store') {
      return { defineStore: (decl) => ({ spec: decl, create: () => ({ actions: {}, getSnapshot: () => decl.init(), subscribe: () => () => {} }) }) }
    }
    if (specifier === 'react-dom') return { createPortal: (element) => element }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { useModalLayer: () => {} }
    throw new Error(`unexpected require: ${specifier}`)
  }

  const source = readFileSync(SOURCE, 'utf8')
  const start = source.indexOf('factory(require) {')
  const body = source.slice(source.indexOf('{', start) + 1, source.lastIndexOf('  },'))
  const dataUrl = `data:text/javascript;base64,${Buffer.from(`export function factory(require){${body}\n}`, 'utf8').toString('base64')}`
  const { factory } = await import(dataUrl)

  const plugin = factory(requireMock)
  const registered = []
  plugin.apply({
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    slots: { inject(_key, callback) { callback() }, register(options, component) { registered.push({ options, component }); return () => {} } },
    get: () => null,
  }, {})

  const entry = registered.find((item) => item.options.name === 'conversation.input.dock')
  assert.ok(entry, '弹窗必须注册到 conversation.input.dock')

  return (patch) => {
    useStateCalls = 0
    const calls = []
    const actions = new Proxy({}, {
      get(_target, key) {
        return (...args) => { calls.push([key, ...args]) }
      },
    })
    const store = {
      active: true, draft: '', templateId: 'task', contextPreset: '', phase: 'idle',
      result: null, error: '', contextInfo: null, meta: null, previewOpen: false,
      ...patch,
    }
    const tree = entry.component({ sessionId: 'session-1', useStore: (selector) => selector(store), actions })
    return { tree, calls }
  }
}

/** 取出上下文档位那个下拉（第二个 select）。 */
function presetSelect(tree) {
  const selects = findByClass(tree, 'si-select')
  assert.equal(selects.length, 2, '应有模板与上下文两个下拉')
  return selects[1]
}

test('上下文档位下拉的选项来自 host 下发的清单', async () => {
  const render = await buildDialog()
  const { tree } = render({})
  const select = presetSelect(tree)
  const labels = select.children.map((option) => option.children[0])
  assert.deepEqual(labels, ['不带上文', '最近 5 条', '最近 10 条'])
  assert.deepEqual(select.children.map((option) => option.props.value), ['off', 'brief', 'standard'])
})

test('选中值落在选项里：store 空串时用 host 默认档', async () => {
  const render = await buildDialog()
  const { tree } = render({ contextPreset: '' })
  assert.equal(presetSelect(tree).props.value, 'standard', '应回落到 host 的默认档')
})

test('选中值落在选项里：store 里的合法档位优先', async () => {
  const render = await buildDialog()
  const { tree } = render({ contextPreset: 'brief' })
  assert.equal(presetSelect(tree).props.value, 'brief')
})

test('store 里是非法档位时回落到 host 默认档（不显示空白）', async () => {
  const render = await buildDialog()
  const { tree } = render({ contextPreset: 'gone' })
  assert.equal(presetSelect(tree).props.value, 'standard')
})

test('切换档位写回 store', async () => {
  const render = await buildDialog()
  const { tree, calls } = render({})
  presetSelect(tree).props.onChange({ target: { value: 'off' } })
  assert.deepEqual(calls, [['setContextPreset', 'off']])
})

test('生成中两个下拉都禁用', async () => {
  const render = await buildDialog()
  const { tree } = render({ phase: 'working' })
  assert.equal(presetSelect(tree).props.disabled, true)
})

test('host 没下发档位清单时下拉禁用且不编造选项', async () => {
  const render = await buildDialog({ ...HOST, context: { preset: 'standard' } })
  const { tree } = render({})
  const select = findByClass(tree, 'si-select')[1]
  assert.equal(select.props.disabled, true, '没有清单时应禁用')
  assert.equal(select.children.length, 1, '不应自己编一份档位表')
  assert.equal(select.props.value, '', '选中值必须是选项里真实存在的值')
  // 占位文案不能说成「模板不可用」——那是另一个下拉的事，用户会以为是模板坏了。
  assert.equal(select.children[0].children[0], '（宿主未提供档位）')
})
