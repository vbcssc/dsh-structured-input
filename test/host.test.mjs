/**
 * 宿主半边的行为测试。
 *
 * 为什么必须单独有这一套：`context.test.mjs` / `format.test.mjs` 只覆盖 `lib/` 的
 * 纯函数，而实际出过的三个阻塞级缺陷全都长在 handler 路径上 ——
 *
 *   1. `req.destroy()` 让 413 永远送不到客户端
 *   2. 忽略 `finish` 块，把"半截输出 + 中途挂掉"当成成功
 *   3. 断连信号挂在 `req` 上，而那个事件早就烧过了
 *
 * 纯函数测试一个都抓不到。这里用假的 `webServer` / `llm` / `sessions` 驱动真实的
 * `apply`，把这三条钉死。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// **必须在 import 插件之前**设好 DSH_HOME：插件的 `dataDirectory()` 在调用时读
// `process.env.DSH_HOME`，而这个套件会写状态文件。不隔离的话测试会把真实的
// `~/.dsh/structured-input/state.json` 改掉 —— 实际发生过：一条用例把 enabled
// 写成 false，此后所有用例都走了"停用"分支，却不报错，只是静默不调模型。
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-structured-input-test-'))
process.env.DSH_HOME = TEST_HOME
after(() => { rmSync(TEST_HOME, { recursive: true, force: true }) })

const { GENERATE_ROUTE, STATE_ROUTE, apply } = await import('../index.js')

/**
 * 起一个真 HTTP 服务器，把插件注册的 handler 挂上去。
 *
 * 用真服务器而不是伪造 req/res：`res.writableEnded`、`'close'` 事件时序这些
 * 恰恰是缺陷所在，伪造的 req/res 会把问题一起伪造掉。
 */
async function withServer(options, run) {
  // 每个用例一个独立数据目录。`state.json` 是全局的，而"停用"那条用例会把
  // `enabled` 写成 false —— 共用目录时它会串到后面的用例里，表现为"模型没被调用"
  // 却没有任何报错。这类串扰只能靠隔离消除，不能靠执行顺序。
  const home = mkdtempSync(join(tmpdir(), 'dsh-si-case-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const handlers = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(deps, callback) {
      const child = {
        webServer: {
          register({ path, handler }) { handlers.set(path, handler); return () => handlers.delete(path) },
        },
      }
      callback(child)
      return { dispose() {} }
    },
    get(name) {
      if (name === 'sessions') return options.sessions ?? { get: () => null }
      if (name === 'llm') return options.llm ?? null
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return null
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
  }
  // Cordis 以裸函数调用 apply（registry.ts:226 → fiber.ts:259），这里照做。
  const callback = apply
  callback(ctx, options.config ?? {})

  const server = createServer((req, res) => {
    const handler = handlers.get(req.url)
    if (!handler) { res.writeHead(404); res.end(); return }
    void handler(req, res)
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await run(base, handlers)
  } finally {
    await new Promise((resolve) => { server.close(resolve) })
    process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
}

/** 一个只吐固定 chunk 的假 llm。 */
function fakeLlm(chunks) {
  return {
    async *stream() { for (const chunk of chunks) yield chunk },
  }
}

test('生成路由：正常流返回 ok:true', async () => {
  await withServer({ llm: fakeLlm([
    { type: 'text-delta', index: 0, text: '{"目标":"做A","约束":"别用B"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]) }, async (base) => {
    const res = await fetch(`${base}${GENERATE_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '干活', templateId: 'task' }),
    })
    const data = await res.json()
    assert.equal(data.ok, true)
    assert.equal(data.degraded, false)
    assert.match(data.text, /做A/)
  })
})

test('生成路由：finish=error 时不把半截输出当成功', async () => {
  // 这是曾经的真实缺陷：模型吐了一半就挂，`ok:true` 把残缺结果交给用户。
  await withServer({ llm: fakeLlm([
    { type: 'text-delta', index: 0, text: '{"目标": "半截' },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'network reset' } } },
  ]) }, async (base) => {
    const res = await fetch(`${base}${GENERATE_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '干活' }),
    })
    const data = await res.json()
    assert.equal(data.ok, false, '中途失败绝不能报成功')
    assert.equal(data.error, 'network reset', '要报真实原因，而不是"没产出文本"')
    assert.equal(data.text, undefined, '不能把半截结果带出去')
  })
})

test('生成路由：max-tokens 截断单列为 truncated', async () => {
  await withServer({ llm: fakeLlm([
    { type: 'text-delta', index: 0, text: '{"目标": "被截断' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]) }, async (base) => {
    const data = await (await fetch(`${base}${GENERATE_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '干活' }),
    })).json()
    assert.equal(data.ok, false)
    assert.equal(data.errorKind, 'truncated')
  })
})

test('生成路由：请求体超限时客户端能收到 413（而不是网络错误）', async () => {
  await withServer({ llm: fakeLlm([]) }, async (base) => {
    // 超过 MAX_BODY_BYTES（128KB）。原来的 `req.destroy()` 会让客户端拿到
    // UND_ERR_SOCKET，永远看不到这个 413。
    const res = await fetch(`${base}${GENERATE_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(200 * 1024),
    })
    assert.equal(res.status, 413)
    const data = await res.json()
    assert.equal(data.ok, false)
    assert.match(data.error, /too large/)
  })
})

test('状态路由：GET 返回模板清单与状态', async () => {
  await withServer({}, async (base) => {
    const data = await (await fetch(`${base}${STATE_ROUTE}`)).json()
    assert.equal(data.ok, true)
    assert.ok(Array.isArray(data.state.templates.items))
    assert.ok(data.state.templates.items.length > 0)
    assert.equal(typeof data.state.context.maxChars, 'number')
  })
})

test('状态路由：非 POST/PUT 返回 405', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}${STATE_ROUTE}`, { method: 'DELETE' })
    assert.equal(res.status, 405)
  })
})

test('生成路由：插件停用时不调模型', async () => {
  let called = false
  await withServer({
    llm: { async *stream() { called = true; yield { type: 'finish', reason: { kind: 'stop' } } } },
  }, async (base) => {
    // 先把 enabled 写 false，再试生成。
    await fetch(`${base}${STATE_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: { enabled: false } }),
    })
    const data = await (await fetch(`${base}${GENERATE_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '干活' }),
    })).json()
    assert.equal(data.ok, false)
    assert.equal(data.errorKind, 'disabled')
    assert.equal(called, false)
  })
})

test('生成路由：客户端断开时中止模型调用', async () => {
  // 覆盖那条"监听 res 而不是 req"的修复：req 的 close 在监听挂上之前就烧过了。
  let aborted = false
  const slowLlm = {
    async *stream(options) {
      // 先吐一点内容：一点不吐的话 `callModel` 会因为"没产出文本"提前返回，
      // 响应在客户端 abort 之前就正常结束了，测不到断连那条路径。
      yield { type: 'text-delta', index: 0, text: '{"目标":"' }
      for (let i = 0; i < 100; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (options.signal && options.signal.aborted) { aborted = true; return }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  await withServer({ llm: slowLlm }, async (base) => {
    const controller = new AbortController()
    const request = fetch(`${base}${GENERATE_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '干活' }),
      signal: controller.signal,
    }).catch(() => { /* 主动中止，预期会 reject */ })
    await new Promise((resolve) => setTimeout(resolve, 120))
    controller.abort()
    await request
    // 给宿主一点时间观察到断连并让 slowLlm 的轮询看到 sig​nal。
    for (let i = 0; i < 40 && !aborted; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(aborted, true, '客户端断开后模型调用必须被中止')
  })
})

test('未知路径返回 404（handler 未注册时不崩）', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/plugins/dsh-structured-input/nope`, { method: 'POST' })
    assert.equal(res.status, 404)
  })
})
