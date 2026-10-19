/**
 * 模板预览的行为测试。
 *
 * 下拉里只有模板名，用户看不到这个模板会要哪些内容。预览按钮把每节的标题和说明
 * 摊开。这里驱动真实组件，断言展开/收起两条路径的渲染树。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = new URL('../client.js', import.meta.url)

const HOST = {
  templates: {
    items: [
      { id: 'task', name: '任务（通用）', sections: ['目标', '要求'], hints: ['说清目标', '列条目'] },
      { id: 'bugfix', name: '缺陷修复', sections: ['现象'], hints: ['哪里不对'] },
    ],
  },
  templateId: 'task',
}

/** 在渲染树里按 className 找节点。 */
function findByClass(node, className, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (node.props && node.props.className === className) out.push(node)
  for (const child of node.children ?? []) findByClass(child, className, out)
  return out
}

/** 载入 client.js 的 factory，返回 `render(storePatch)`。 */
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
    // 第一个 useState 是 hostState（初值 null）。喂真实数据，等价于 fetchState 已返回。
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
    const store = {
      active: true, draft: '', templateId: 'task', phase: 'idle',
      result: null, error: '', contextInfo: null, meta: null, previewOpen: false,
      ...patch,
    }
    return entry.component({ sessionId: 'session-1', useStore: (selector) => selector(store), actions: {} })
  }
}

test('收起时不渲染预览面板，按钮文案是「看模板」', async () => {
  const render = await buildDialog()
  const tree = render({ previewOpen: false })
  const buttons = findByClass(tree, 'si-preview-toggle')
  assert.equal(buttons.length, 1, '应当有一个预览按钮')
  assert.deepEqual(buttons[0].children, ['看模板'])
  assert.equal(findByClass(tree, 'si-preview').length, 0, '收起时不应渲染面板')
})

test('展开时逐个渲染小节，按钮文案变成「收起」', async () => {
  const render = await buildDialog()
  const tree = render({ previewOpen: true })
  const buttons = findByClass(tree, 'si-preview-toggle')
  assert.equal(buttons.length, 1)
  assert.deepEqual(buttons[0].children, ['收起'])
  assert.equal(findByClass(tree, 'si-preview').length, 1, '展开时应渲染面板')

  const template = HOST.templates.items[0]
  assert.equal(findByClass(tree, 'si-preview-item').length, template.sections.length, '每个小节一项')
  const titles = findByClass(tree, 'si-preview-title').map((node) => node.children[0])
  assert.deepEqual(titles, template.sections, '小节标题应与模板一致')
  const hints = findByClass(tree, 'si-preview-hint').map((node) => node.children[0])
  assert.deepEqual(hints, template.hints, '小节说明应与模板一致')
})

test('切换模板时预览跟着换', async () => {
  const render = await buildDialog()
  const tree = render({ previewOpen: true, templateId: 'bugfix' })
  const titles = findByClass(tree, 'si-preview-title').map((node) => node.children[0])
  assert.deepEqual(titles, HOST.templates.items[1].sections, '应显示 bugfix 模板的小节')
})

test('模板列表为空时不渲染预览按钮', async () => {
  const render = await buildDialog({ templates: { items: [] } })
  const tree = render({ previewOpen: true, templateId: '' })
  assert.equal(findByClass(tree, 'si-preview-toggle').length, 0, '没有模板就没有可预览的东西')
  assert.equal(findByClass(tree, 'si-preview').length, 0)
})
