/**
 * dsh-structured-input — host 半边。
 *
 * 只做四件事：
 *
 * 1. **读上下文**。`ctx.sessions.get(sessionId)` 拿到活着的 Session，
 *    `deriveMessages()` 拿到完整历史，交给 `lib/context.js` 压成 transcript。
 * 2. **套模板**。模板来自 `lib/templates.json`（用户可改），`lib/format.js`
 *    把模型输出对齐到模板小节。
 * 3. **调模型**。用宿主 `llm` 服务做一次性生成，不经过 agent 循环。
 * 4. **供浏览器半边**。注册两条路由：读状态、执行生成。
 *
 * **刻意不做的事**：不监听 `agent/pre-step`，不拦截发送。本插件是"用户主动点
 * 按钮、主动点生成"的工具，不碰任何消息投递链路 —— 那条路是 `dsh-prompt-hardener`
 * 的地盘，两个插件因此可以同时开着而互不干扰。
 *
 * 三条实现纪律：
 * - 拿不到会话（冷启动 / headless / 会话已销毁）时**降级为只用当前输入**，
 *   并在响应里说清楚，绝不编造上下文。
 * - 模型输出的 `purpose` 字段**不传**：它是有类型的闭合联合，只认
 *   `compaction` / `session-title`，塞别的值是绕过类型检查的隐患。
 * - 子效应（路由注册）任何一个炸了都只记一笔，绝不把整个插件带下水。
 *
 * @module dsh-structured-input
 */

import { buildStructured, describeTemplate } from './lib/format.js'
import { composeUserContent, projectTranscript } from './lib/context.js'
import {
  DEFAULTS,
  dataDirectory,
  pickTemplate,
  resolvePrompt,
  resolveTemplates,
  sanitizeState,
  readState,
  seed,
  writeState,
} from './lib/state.js'

/** Cordis 插件名。 */
export const name = 'structured-input'

/**
 * 不硬依赖任何服务：`llm` 用 `ctx.get('llm')` 惰性取，`sessions` 同样；
 * `webServer` 必须走 `ctx.inject` 等待就绪（见下方路由挂载的说明）。
 */
export const inject = []

/** 状态路由。 */
export const STATE_ROUTE = '/plugins/dsh-structured-input/state.json'

/** 生成路由。 */
export const GENERATE_ROUTE = '/plugins/dsh-structured-input/generate'

/** 请求体大小上限。需求正文再长也不该超过这个数。 */
const MAX_BODY_BYTES = 128 * 1024

/** 提示词之外的执行约束。放在代码里，不随用户换 prompt.md 而消失。 */
export const FIDELITY_CLAUSE = [
  '## 执行约束（插件追加，优先级高于上面的风格规范）',
  '',
  '1. **保真优先**：需求与上下文里的技术内容 —— 技术栈、文件名、参数、数值、单位、约束、边界条件、验收标准 ——',
  '   一律不得增删、篡改或臆测。看不懂的地方照抄，不要自己编。',
  '2. **上下文只用来理解指代**：它说明"之前的对话在聊什么"，不是这次要执行的任务。',
  '   不要把上下文里的旧需求重新列进结果，也不要把它当成新任务。',
  '3. **只输出 JSON**：不要解释、不要"以下是结果"这类元话语、不要用代码块包裹。',
  '4. **用中文输出**。',
].join('\n')

/** 读 JSON 请求体。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let overflowed = false
    const chunks = []
    req.on('data', (chunk) => {
      // 超限之后**继续吞掉**后续数据但不再累积：既不占内存，也让请求正常走完，
      // handler 才可能把 413 回给客户端。
      if (overflowed) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overflowed = true
        chunks.length = 0
        reject(Object.assign(new Error('body too large'), { siStatus: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (overflowed) return
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
  })
}

/** 只接受同源/直接发起的写请求。 */
function isTrustedWrite(req) {
  const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
  if (site === 'cross-site') return false
  const method = String(req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const origin = String((req.headers && req.headers.origin) || '')
  if (origin.length === 0) return true
  try {
    const host = String((req.headers && req.headers.host) || '')
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 解析生成用的模型路由。
 *
 * 三级回退：
 * 1. 插件配置里的 `llm.provider` + `llm.model`（两个都给才算数）
 * 2. 该会话已落库的 `requestHeader()` —— 当前真实路由，用户切模型也会跟进
 * 3. 宿主默认模型服务 `agentDefaultModel.currentSelection()`
 *
 * @param {object} ctx cordis 上下文。
 * @param {object} configured 插件配置里的 llm 段。
 * @param {object|null} session 目标会话。
 * @returns {{ provider: string, model: string }} 路由。
 */
export function resolveRoute(ctx, configured, session) {
  const explicit = configured && typeof configured === 'object' ? configured : {}
  const provider = typeof explicit.provider === 'string' ? explicit.provider : ''
  const model = typeof explicit.model === 'string' ? explicit.model : ''
  if (provider && model) return { provider, model }

  if (session && typeof session.requestHeader === 'function') {
    try {
      const header = session.requestHeader()
      const config = header && header.config ? header.config : {}
      const headerProvider = typeof config.provider === 'string' ? config.provider : ''
      const headerModel = typeof config.model === 'string' ? config.model : ''
      if (headerProvider && headerModel) return { provider: headerProvider, model: headerModel }
    } catch {
      /* 读不到就落到下一级 */
    }
  }

  try {
    const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    if (service && typeof service.currentSelection === 'function') {
      const picked = service.currentSelection()
      if (picked && typeof picked.provider === 'string' && typeof picked.model === 'string') {
        return { provider: picked.provider, model: picked.model }
      }
    }
  } catch {
    /* 宿主没装这个服务就当没有 */
  }

  return { provider, model }
}

/**
 * 读会话上下文并投影。
 *
 * 拿不到会话不是错误 —— 用户可能在一个刚开的会话里，也可能宿主没有 sessions
 * 服务。这时返回 `used: false` 和原因，调用方据此告诉用户"这次没带上下文"，
 * 而不是静默地什么都不带。
 *
 * @param {object} ctx cordis 上下文。
 * @param {string} sessionId 会话 id。
 * @param {number} maxChars 字符预算。
 * @returns {{ used: boolean, reason: string|null, messages: number, omitted: number, chars: number, text: string, session: object|null }}
 */
export function readContext(ctx, sessionId, maxChars) {
  const empty = { used: false, reason: null, messages: 0, omitted: 0, chars: 0, text: '', session: null }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ...empty, reason: 'no-session-id' }
  }
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
  if (!sessions || typeof sessions.get !== 'function') {
    return { ...empty, reason: 'no-sessions-service' }
  }
  let session
  try {
    session = sessions.get(sessionId)
  } catch {
    return { ...empty, reason: 'session-unavailable' }
  }
  if (!session) return { ...empty, reason: 'session-not-live' }

  let messages
  try {
    messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
  } catch {
    return { ...empty, reason: 'derive-failed', session }
  }
  const projected = projectTranscript(messages, { maxChars })
  // "没有历史"和"历史有东西但被预算卡没了"是两回事，用户看到的提示不同、
  // 排查方向也不同：前者正常，后者说明 context.maxChars 配得太小。
  const hasAnyMessage = messages.length > 0
  return {
    used: projected.usedMessages > 0,
    reason: projected.usedMessages > 0
      ? null
      : (hasAnyMessage ? 'budget-too-small' : 'empty-history'),
    messages: projected.usedMessages,
    omitted: projected.omittedMessages,
    chars: projected.chars,
    text: projected.text,
    session,
  }
}

/**
 * 调一次模型，拿到原始文本输出。
 *
 * 失败按信号归因，不猜错误字符串：超时 / 被调用方取消 / 没路由，三件事对用户
 * 意味着完全不同的排查方向。
 *
 * @param {object} ctx cordis 上下文。
 * @param {object} call 调用参数：`{ provider, model, system, user, maxTokens, timeoutMs, signal }`。
 * @returns {Promise<string>} 模型输出正文。
 */
async function callModel(ctx, call) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : null
  if (!llm || typeof llm.stream !== 'function') {
    throw Object.assign(new Error('llm service unavailable'), { siKind: 'no-route' })
  }
  if (!call.provider || !call.model) {
    throw Object.assign(new Error('no provider/model route available'), { siKind: 'no-route' })
  }

  const timeoutMs = call.timeoutMs > 0 ? call.timeoutMs : DEFAULTS.llm.timeoutMs
  const timeoutSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : null
  const signals = [call.signal, timeoutSignal].filter(Boolean)
  let signal
  if (signals.length === 0) signal = undefined
  else if (signals.length === 1) signal = signals[0]
  else if (typeof AbortSignal.any === 'function') signal = AbortSignal.any(signals)
  else signal = signals[0]

  const options = {
    provider: call.provider,
    model: call.model,
    system: call.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: call.user }] }],
    ...(call.maxTokens > 0 ? { maxTokens: call.maxTokens } : {}),
    ...(signal === undefined ? {} : { signal }),
    // 刻意不传 purpose：它只认 'compaction' | 'session-title'。
  }

  const attribute = (cause, message) => {
    if (timeoutSignal && timeoutSignal.aborted) {
      return Object.assign(new Error(`llm call timed out after ${timeoutMs}ms`), { siKind: 'timeout', cause })
    }
    if (call.signal && call.signal.aborted) {
      return Object.assign(new Error('llm call aborted by caller'), { siKind: 'aborted', cause })
    }
    return cause instanceof Error ? cause : Object.assign(new Error(message), { siKind: 'llm-failed' })
  }

  let out = ''
  let finish = null
  try {
    for await (const chunk of llm.stream(options)) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      // 终结块必须记下来：`LlmRuntime` **不会**因 provider 失败而 throw，它把失败
      // 归一化成 `{ type:'finish', reason:{ kind:'error'|'aborted', failure } }` 正常
      // 吐出来（`llm/src/index.ts` 的 `adapterFailureChunk` 是 yield 不是 throw）。
      // 所以只看 `text-delta` 的话，`catch` 永远不触发，"半截输出 + 中途挂掉"会被
      // 当成成功返回 —— 用户拿到一份看着完整的残缺结果。
      else if (chunk && chunk.type === 'finish') finish = chunk.reason
    }
  } catch (cause) {
    throw attribute(cause, 'llm call failed')
  }

  // 先判终结块，再看文本。顺序不能反：中途失败时往往**已经收到半截文本**，
  // 先看文本就会把失败当成成功。
  if (finish) {
    if (finish.kind === 'aborted') {
      // 超时和"调用方主动取消"都会走到这里，靠信号区分。
      throw attribute(null, 'llm call aborted')
    }
    if (finish.kind === 'error') {
      const detail = finish.failure && finish.failure.message ? finish.failure.message : 'llm call failed'
      // 失败原因可能正是超时（provider 侧超时被归一化），仍然按信号优先归因。
      if (timeoutSignal && timeoutSignal.aborted) throw attribute(null, detail)
      const error = new Error(detail)
      error.siKind = 'llm-failed'
      error.cause = finish.failure
      throw error
    }
    // `max-tokens` 不是失败，但结果是**被截断**的：JSON 必然不完整，交给
    // `buildStructured` 走降级路径没有意义（它只会把半截原文塞进第一个小节）。
    // 明确报错，让用户知道是输出长度不够，可以调大 maxTokens 或缩小需求。
    if (finish.kind === 'max-tokens') {
      const error = new Error(`llm output truncated at maxTokens (${call.maxTokens || 'auto'}); raise llm.maxTokens or shorten the request`)
      error.siKind = 'truncated'
      throw error
    }
  }

  const trimmed = out.trim()
  if (trimmed.length === 0) throw attribute(null, 'llm produced no text')
  return trimmed
}

/** 按输入长度估算输出上限。 */
function autoMaxTokens(chars) {
  return Math.min(16000, Math.max(2000, Math.ceil(chars * 2)))
}

/**
 * 执行一次结构化生成。HTTP 路由与单测共用这一条。
 *
 * @param {object} ctx cordis 上下文。
 * @param {object} state 当前状态。
 * @param {{ sessionId?: string, text?: string, templateId?: string }} input 请求。
 * @returns {Promise<object>} 响应体。
 */
export async function generate(ctx, state, input) {
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (text.length === 0) {
    return { ok: false, error: 'text required' }
  }

  const templateInfo = resolveTemplates()
  const template = pickTemplate(templateInfo.templates, typeof input.templateId === 'string' ? input.templateId : state.templateId)
  if (template === null) {
    return { ok: false, error: 'no templates available: check lib/templates.json' }
  }

  const context = readContext(ctx, input.sessionId, state.context.maxChars)
  const route = resolveRoute(ctx, state.llm, context.session)
  const prompt = resolvePrompt()

  const userContent = composeUserContent(text, { text: context.text })
  const templateSpec = describeTemplate(template)
  const system = [
    prompt.text,
    '---',
    FIDELITY_CLAUSE,
    '---',
    templateSpec,
  ].filter((part) => typeof part === 'string' && part.trim().length > 0).join('\n\n')

  let raw
  try {
    raw = await callModel(ctx, {
      provider: route.provider,
      model: route.model,
      system,
      user: userContent,
      maxTokens: state.llm.maxTokens > 0 ? state.llm.maxTokens : autoMaxTokens(text.length),
      timeoutMs: state.llm.timeoutMs,
      signal: input.signal,
    })
  } catch (error) {
    return {
      ok: false,
      error: String((error && error.message) || error),
      errorKind: (error && error.siKind) || 'llm-failed',
      context: {
        used: context.used,
        reason: context.reason,
        messages: context.messages,
        omitted: context.omitted,
        chars: context.chars,
      },
    }
  }

  const built = buildStructured(raw, template)
  return {
    ok: true,
    text: built.text,
    degraded: built.degraded,
    missing: built.missing,
    raw: built.raw,
    template: { id: template.id, name: template.name },
    route,
    promptSource: prompt.source,
    context: {
      used: context.used,
      reason: context.reason,
      messages: context.messages,
      omitted: context.omitted,
      chars: context.chars,
    },
  }
}

/**
 * 对外暴露的状态（去掉内部字段，补上只读信息）。
 * @param {object} state 完整状态。
 * @param {object} templates 模板解析结果。
 * @returns {object} 可下发状态。
 */
export function publicState(state, templates) {
  const prompt = resolvePrompt()
  return {
    enabled: state.enabled,
    templateId: state.templateId,
    context: { ...state.context },
    llm: { ...state.llm },
    stats: { ...state.stats },
    revision: state.revision,
    templates: {
      source: templates.source,
      path: templates.path,
      items: templates.templates.map((template) => ({
        id: template.id,
        name: template.name,
        sections: template.sections.map((section) => section.title),
        // `hints` 与 `sections` 一一对应：客户端用它在预览里说明每一节该写什么。
        // 单列一个数组而不是把 sections 改成对象数组，是为了不破坏已有的读取方
        // （`sections` 被当成 string[] 用）。
        hints: template.sections.map((section) => section.hint ?? ''),
      })),
    },
    prompt: { source: prompt.source, path: prompt.path, chars: prompt.chars },
    dataDirectory: dataDirectory(),
    // 配置文件损坏时会静默回落默认值 —— 把原因带出去，UI 才有机会说一句
    // "你的设置读不出来，已重置"，而不是让用户以为自己从没配过。
    stateFileError: readState.lastError,
  }
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文。
 * @param {object} [config] 行配置，作为默认值。
 */
export function apply(ctx, config) {
  const defaults = sanitizeState(config && typeof config === 'object' ? config : {}, DEFAULTS)

  /** 内存态；磁盘是权威，内存只是缓存。 */
  let state = { ...defaults }
  /**
   * 读盘的 promise 缓存。**不能用布尔标志**：`loaded = true` 若放在 `await` 之前，
   * 读盘还没回来时任何并发调用都会立刻拿到尚未从磁盘读入的 `{...defaults}`。
   * `void load()` 是不等待的后台启动，而路由在 `mount()` 里同步注册，这个窗口真实存在。
   * 更糟的是 PUT/POST 会拿这份默认态当基底写盘，把用户的真实状态整个覆盖掉。
   */
  let loading = null
  /** 串行化写盘。 */
  let writeChain = Promise.resolve()

  const logger = (() => {
    try {
      return typeof ctx.logger === 'function' ? ctx.logger(name) : null
    } catch {
      return null
    }
  })()

  const note = (message) => {
    if (logger && typeof logger.debug === 'function') logger.debug(message)
  }

  /** 子效应挂载过程中攒下来的失败，便于离线取证。 */
  const failures = []

  const load = () => {
    loading ??= readState(defaults).then((next) => { state = next })
    return loading
  }

  const persist = () => {
    const snapshot = { ...state }
    // 写盘失败用 warn 而不是 debug：状态没落盘是用户可感知的事实
    // （重启后设置回退），不该只留在 debug 级别里。
    writeChain = writeChain
      .then(() => writeState(snapshot))
      .catch((error) => {
        const message = String((error && error.message) || error)
        failures.push({ label: 'structured-input: persist', message, at: Date.now() })
        if (logger && typeof logger.warn === 'function') logger.warn(`persist failed: ${message}`)
        else note(`persist failed: ${message}`)
      })
    return writeChain
  }

  const mount = (fn, label) => {
    try {
      ctx.effect(fn, label)
    } catch (error) {
      const message = String((error && error.message) || error)
      failures.push({ label, message, at: Date.now() })
      note(`${label} failed: ${message}`)
    }
  }

  // 播种提示词与模板（已存在不覆盖）。
  mount(() => {
    let cancelled = false
    void seed().then((result) => {
      if (!cancelled) note(`seed: ${JSON.stringify(result)}`)
    }).catch(() => {
      /* 播种失败不影响使用，会退回包内自带那份 */
    })
    return () => { cancelled = true }
  }, 'structured-input: seed')

  // 先把磁盘态读进来；读盘期间路由用同步默认值，不会阻塞。
  void load()

  const sendJson = (res, code, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /* ───────────────────── 1. 状态路由 ───────────────────── */

  mount(() => {
    const handler = async (req, res) => {
      try {
        if (!isTrustedWrite(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
          return
        }
        const method = String(req.method || 'GET').toUpperCase()
        await load()
        if (method === 'GET' || method === 'HEAD') {
          sendJson(res, 200, { ok: true, state: publicState(state, resolveTemplates()) })
          return
        }
        if (method !== 'PUT' && method !== 'POST') {
          sendJson(res, 405, { ok: false, error: `method not allowed: ${method}` })
          return
        }
        const body = await readJsonBody(req)
        const patch = body && typeof body === 'object' && body.state ? body.state : body
        const merged = { ...state, ...(patch && typeof patch === 'object' ? patch : {}) }
        state = sanitizeState(merged, defaults)
        state = { ...state, revision: Number(state.revision || 0) + 1 }
        await persist()
        sendJson(res, 200, { ok: true, state: publicState(state, resolveTemplates()) })
      } catch (error) {
        // 超限请求体带自家的状态码（413）；其余按 400 回。
        const status = error && Number.isInteger(error.siStatus) ? error.siStatus : 400
        sendJson(res, status, { ok: false, error: String((error && error.message) || error) })
      }
    }

    // 冷启动时 webServer 通常晚于本插件就绪：裸访问 ctx.webServer 会抛
    // `cannot get property "webServer" without inject`，路由一次都注册不上。
    const fiber = ctx.inject(['webServer'], (child) => {
      let disposer = null
      try {
        disposer = child.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler })
      } catch (error) {
        const message = String((error && error.message) || error)
        failures.push({ label: 'structured-input: state route', message, at: Date.now() })
        note(`state route registration failed: ${message}`)
        return () => {}
      }
      note(`state route registered: ${STATE_ROUTE}`)
      return () => {
        try {
          disposer()
        } catch {
          /* 已经卸掉就算了 */
        }
      }
    })

    return () => {
      try {
        void fiber.dispose()
      } catch {
        /* 同上 */
      }
    }
  }, 'structured-input: state route')

  /* ───────────────────── 2. 生成路由 ───────────────────── */

  mount(() => {
    const handler = async (req, res) => {
      try {
        if (!isTrustedWrite(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
          return
        }
        const method = String(req.method || 'GET').toUpperCase()
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: `method not allowed: ${method}` })
          return
        }
        await load()
        if (!state.enabled) {
          sendJson(res, 200, { ok: false, error: 'plugin disabled', errorKind: 'disabled' })
          return
        }
        // controller 提到读 body **之前**：请求体上传阶段客户端就断开的话，同样
        // 应该停下来，不必等读完再发现没人要了。
        //
        // 监听 **res** 而不是 req。`req` 的 `'close'` 语义是"请求体流结束"，它在
        // `'end'` 之后紧接着就触发；而这里要等到 `await readJsonBody` 之后才挂监听，
        // 那时事件早就烧过了 —— 实测 10 次真实断连里 `req.on('close')` 触发 0 次，
        // 修复形同虚设。`res` 的 `'close'` 才表示"响应结束或连接断开"，正常完成时
        // `writableEnded` 为 true、断连时为 false，正好是需要的判别。
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        if (controller) {
          res.on('close', () => {
            if (!res.writableEnded) controller.abort()
          })
        }
        const body = await readJsonBody(req)
        const result = await generate(ctx, state, {
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
          text: typeof body.text === 'string' ? body.text : '',
          templateId: typeof body.templateId === 'string' ? body.templateId : state.templateId,
          ...(controller ? { signal: controller.signal } : {}),
        })

        state = {
          ...state,
          stats: {
            ...state.stats,
            calls: Number(state.stats.calls || 0) + 1,
            ...(result.ok === true
              ? {
                lastAt: Date.now(),
                lastSource: result.degraded ? 'degraded' : 'structured',
                lastChars: result.text.length,
                lastTemplate: result.template ? result.template.id : '',
                lastContext: result.context ? result.context.messages : 0,
                lastDegraded: result.degraded === true,
              }
              : { lastError: result.error || '', lastErrorKind: result.errorKind || '' }),
          },
        }
        void persist()
        sendJson(res, 200, result)
      } catch (error) {
        // 超限请求体带自家的状态码（413）；其余按 400 回。
        const status = error && Number.isInteger(error.siStatus) ? error.siStatus : 400
        sendJson(res, status, { ok: false, error: String((error && error.message) || error) })
      }
    }

    const fiber = ctx.inject(['webServer'], (child) => {
      let disposer = null
      try {
        disposer = child.webServer.register({ kind: 'exact', path: GENERATE_ROUTE, handler })
      } catch (error) {
        const message = String((error && error.message) || error)
        failures.push({ label: 'structured-input: generate route', message, at: Date.now() })
        note(`generate route registration failed: ${message}`)
        return () => {}
      }
      note(`generate route registered: ${GENERATE_ROUTE}`)
      return () => {
        try {
          disposer()
        } catch {
          /* 同上 */
        }
      }
    })

    return () => {
      try {
        void fiber.dispose()
      } catch {
        /* 同上 */
      }
    }
  }, 'structured-input: generate route')
}

export { DEFAULTS }
