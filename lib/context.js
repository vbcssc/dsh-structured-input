/**
 * 上下文投影：把会话历史压成模型能读的纯文本 transcript。
 *
 * **这是本插件的命门之一。** 会话历史不是"一堆字符串"，而是 `Message[]`：
 * 里面混着工具调用、工具结果、推理块、图片、文件引用、系统注入的上下文消息。
 * 原样塞给模型会出事 —— 模型看到自己上一轮的 `tool-call`，会把这次生成也当成
 * 工具调用继续下去，而不是老老实实吐结构化文本。所以这里只做一件事：
 * **压成人话**，每条一行 `【角色】正文`。
 *
 * 三条硬规矩：
 * 1. **绝不原样传递 Message[]**。输出是 string，类型上就不给原样传的机会。
 * 2. **预算在拼接之前生效**。先按字符预算挑出要保留的轮次，再拼字符串；
 *    不是拼完再截断（截断会把半句话留在里面）。
 * 3. **从新到旧挑**。离现在越近的话越有用；丢掉的是最老的那几轮。
 *
 * @module dsh-structured-input/context
 */

/** 默认上下文预算（字符）。500k 窗口的模型下，这个数只占零头。 */
export const DEFAULT_MAX_CHARS = 12000

/**
 * 上下文档位：弹窗下拉里的固定选项。
 *
 * 为什么做成固定档位而不是让用户填字符数：12000 和 24000 的差别对用户没有直觉，
 * 而"最近 5 条 / 10 条 / 20 条"是看得懂的。每个档位同时挂一个字符上限 —— 只限条数
 * 不够，一条巨型工具输出就能吃光整个预算；只限字符也不够，历史很长但每条都很短时
 * 会把几十条旧对话全拉进来，反而稀释了最近的上下文。
 *
 * `maxMessages: 0`（对应 `off`）表示完全不带上文，只发送当前需求。
 * `full` 不限条数，只受字符上限约束。
 */
export const CONTEXT_PRESETS = Object.freeze([
  Object.freeze({ id: 'off', maxChars: 0, maxMessages: 0 }),
  Object.freeze({ id: 'brief', maxChars: 4000, maxMessages: 5 }),
  Object.freeze({ id: 'standard', maxChars: 12000, maxMessages: 10 }),
  Object.freeze({ id: 'deep', maxChars: 24000, maxMessages: 20 }),
  Object.freeze({ id: 'full', maxChars: 48000, maxMessages: Number.POSITIVE_INFINITY }),
])

/** 默认档位。未知 id 一律回落到这里，而不是"不带上下文"。 */
export const DEFAULT_CONTEXT_PRESET = 'standard'

/**
 * 按 id 取档位；未知/缺失统统回落到默认档位。
 *
 * 刻意**不**回落到 `off`：配置写错一个字就悄悄不带上文，用户只会觉得
 * "这插件怎么读不懂我说的话"，而不会想到是档位 id 拼错了。
 *
 * @param {unknown} id 档位 id。
 * @returns {{ id: string, maxChars: number, maxMessages: number }} 档位定义。
 */
export function resolveContextPreset(id) {
  return CONTEXT_PRESETS.find((preset) => preset.id === id)
    ?? CONTEXT_PRESETS.find((preset) => preset.id === DEFAULT_CONTEXT_PRESET)
}

/**
 * 把旧配置里的自由字符数映射到最接近的档位。
 *
 * 旧版 `state.json` 只有 `context.maxChars`。直接忽略它等于让用户的定制预算无声失效；
 * 向上取最近的一档（预算不缩水），超出最大档就落到 `full`。
 *
 * @param {unknown} maxChars 旧配置里的字符预算。
 * @returns {{ id: string, maxChars: number, maxMessages: number }} 档位定义。
 */
export function presetForMaxChars(maxChars) {
  const value = Number(maxChars)
  if (!Number.isFinite(value) || value <= 0) return resolveContextPreset('off')
  return CONTEXT_PRESETS.find((preset) => preset.maxChars >= value)
    ?? CONTEXT_PRESETS[CONTEXT_PRESETS.length - 1]
}

/** 每条消息压完后的单条上限，防止一轮巨型工具输出吃掉整个预算。 */
const PER_MESSAGE_MAX_CHARS = 2000

/** 角色显示名。未知角色按原样显示，不猜。 */
const ROLE_LABEL = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  system: '系统',
  developer: '运行时',
}

/**
 * 按码元截断，但不劈开代理对。
 *
 * `String#slice` 按 UTF-16 码元切：切在 emoji 中间会留下孤立高代理，
 * 之后编码成 UTF-8 或写日志会被替换成 U+FFFD —— 凭空多一个乱码字符。
 * 回退一个码元即可，代价可以忽略。
 *
 * @param {string} value 原字符串。
 * @param {number} limit 最多保留的码元数。
 * @returns {string} 安全截断的结果。
 */
function truncate(value, limit) {
  if (value.length <= limit) return value
  let end = Math.max(0, limit)
  const code = value.charCodeAt(end - 1)
  // 0xD800–0xDBFF 是高代理：说明切点正好落在一对中间。
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1
  return value.slice(0, end)
}

/**
 * 从一个内容块里取出可读文本。不是文本块的一律返回空串。
 *
 * `tool-call` 单独给一行摘要：模型需要知道"上一轮调过什么工具"，但**不需要**
 * 参数全文，更不该拿到可以复用的调用结构。
 * @param {object} block 内容块。
 * @returns {string} 可读文本，可能是空串。
 */
function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'tool-call' && typeof block.name === 'string') return `[调用工具 ${block.name}]`
  if (block.type === 'image') return '[图片]'
  if (block.type === 'file') return '[文件附件]'
  // reasoning / tool-addition / tool-removal 以及未知类型：对结构化生成没有价值，丢弃。
  return ''
}

/**
 * 把一条消息压成一行文本。
 * @param {object} message 会话消息。
 * @returns {string} 压好的文本；没有可读内容时返回空串。
 */
export function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    const text = blockText(block)
    if (text.length > 0) parts.push(text)
  }
  let joined = parts.join(' ').trim()
  if (joined.length === 0) return ''
  if (joined.length > PER_MESSAGE_MAX_CHARS) {
    joined = `${truncate(joined, PER_MESSAGE_MAX_CHARS)}…[已截断]`
  }
  const role = typeof message.role === 'string' ? message.role : 'unknown'
  // 用 hasOwn 而不是直接下标：角色来自会话数据，`constructor` / `toString` 这类
  // 原型链上的名字不该被当成已知角色渲染成一段 JS 源码。
  const label = Object.hasOwn(ROLE_LABEL, role) ? ROLE_LABEL[role] : role
  return `【${label}】${joined}`
}

/**
 * 把会话历史投影成 transcript，并套用字符预算。
 *
 * 预算按"从新到旧"消费：先放最近的一轮，放得下就继续往前，放不下就停。
 * 停下的位置之前 (更老的) 内容整体丢弃，并在开头留一行说明 —— 让模型知道
 * "更早的对话你没看到"，而不是误以为这就是全部。
 *
 * @param {readonly object[]} messages `session.deriveMessages()` 的返回值。
 * @param {{ maxChars?: number, maxMessages?: number }} [options] 预算选项。
 *   `maxMessages` 是轮数上限（从最新一条往回数）；`Infinity`/缺省表示不限。
 * @returns {{ text: string, usedMessages: number, omittedMessages: number, chars: number, limitedBy: string|null }}
 *   `text` 是可直接拼进提示词的 transcript；没有可用内容时为空串。
 *   `limitedBy` 说明是哪个上限先挡住更早的历史：`chars` / `messages` / `null`。
 */
export function projectTranscript(messages, options) {
  const budget = Number.isFinite(options?.maxChars) && options.maxChars > 0
    ? Math.floor(options.maxChars)
    : DEFAULT_MAX_CHARS
  const maxMessages = Number.isFinite(options?.maxMessages) && options.maxMessages > 0
    ? Math.floor(options.maxMessages)
    : Number.POSITIVE_INFINITY
  const list = Array.isArray(messages) ? messages : []

  // 先压成行，再倒着挑。压这一步必须对**所有**消息做吗？不必 —— 但保留顺序判断
  // 比"先压全部再挑"简单，而且压本身是 O(内容量)，与预算无关。
  const lines = []
  for (const message of list) {
    const line = messageText(message)
    if (line.length > 0) lines.push(line)
  }

  const kept = []
  let used = 0
  let limitedBy = null
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // 条数上限先判：它和预算一样，都是"从新到旧装，装不下就停"。
    // 单条超预算时**仍然允许最新一条进来**（下面那段），所以这里不在
    // `kept.length === 0` 时提前 break。
    if (kept.length >= maxMessages && kept.length > 0) {
      limitedBy = 'messages'
      break
    }
    const line = lines[i]
    const cost = line.length + 1
    if (used + cost > budget) {
      limitedBy = 'chars'
      // 最新的一条自身就超预算：截断保留，而不是整条丢掉。
      // 丢掉会让"上下文"变成空串，用户以为历史没用上；而最新一条恰恰是最相关的。
      if (kept.length === 0) {
        const marker = '…[本条已截断]'
        const room = budget - marker.length
        if (room > 0) {
          kept.push({ text: `${truncate(line, room)}${marker}`, truncated: true })
          used = budget
        }
      }
      break
    }
    kept.push({ text: line, truncated: false })
    used += cost
  }
  kept.reverse()

  const omitted = lines.length - kept.length
  if (kept.length === 0) {
    return { text: '', usedMessages: 0, omittedMessages: omitted, chars: 0, limitedBy }
  }

  // 说明行也占预算。它的长度取决于被省略的条数，而条数又取决于最终留了几条 ——
  // 所以这里**多丢几条**直到装得下：从最老的一条开始丢，与裁剪方向一致。
  //
  // 这一步真的丢了东西时，挡住更早历史的是**字符预算**而不是条数上限（表头比
  // 被丢掉的那几行还长），`limitedBy` 要跟着改，否则界面会把"档位太小"
  // 误报成"条数到了"。
  const headFor = (count) => (count > 0 ? `[更早的 ${count} 条对话已省略]\n` : '')
  while (kept.length > 0) {
    const body = kept.map((item) => item.text).join('\n')
    const text = headFor(lines.length - kept.length) + body
    if (text.length <= budget) {
      return {
        text,
        usedMessages: kept.length,
        omittedMessages: lines.length - kept.length,
        chars: text.length,
        limitedBy,
      }
    }
    kept.shift()
    limitedBy = 'chars'
  }
  return { text: '', usedMessages: 0, omittedMessages: lines.length, chars: 0, limitedBy }
}

/**
 * 拼出交给模型的最终 user 内容。
 *
 * 顺序是刻意的：先上下文，再当前需求。模型读到最后一句时，"现在要干什么"
 * 紧贴着它，比反过来更容易守住。
 *
 * @param {string} text 用户这次输入的需求。
 * @param {{ text: string } | null} transcript 上下文投影结果。
 * @returns {string} 拼好的正文。
 */
export function composeUserContent(text, transcript) {
  const demand = String(text ?? '').trim()
  const context = transcript && typeof transcript.text === 'string' ? transcript.text.trim() : ''
  if (context.length === 0) return demand
  return `## 会话上下文（供你理解指代与背景，不是这次要执行的任务）\n\n${context}\n\n## 这次的需求\n\n${demand}`
}
