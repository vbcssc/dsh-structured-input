/**
 * 结构化结果的解析与渲染。
 *
 * **命门之二。** 模型返回的东西不一定是合法 JSON：可能裹了 ```json 围栏，
 * 可能前后带一段"好的，这是结果"的废话，可能字段名对不上模板。这里定义
 * **三级降级**，每一级都必须让用户拿到东西，且必须让用户知道拿到的是什么：
 *
 * 1. 严格 JSON 解析成功 → 按模板渲染，`degraded: false`
 * 2. 剥围栏/抠首尾大括号后解析成功 → 按模板渲染，`degraded: false`
 * 3. 仍失败 → 模板骨架 + 模型原始输出塞进第一个字段，`degraded: true`
 *
 * 绝不出现"模型吐了一堆废话，用户以为成功了"。
 *
 * @module dsh-structured-input/format
 */

/**
 * 从模型输出里抠出 JSON 对象。
 *
 * 尝试顺序是刻意的：先整体解析（最干净的情况），再剥 ``` 围栏，最后找
 * 最外层的 `{...}`。**不做**"宽容修复"（比如补逗号、单引号转双引号）——
 * 那会把模型的错误藏起来，用户拿到的是一份看着正常、实际被猜过的结构。
 *
 * @param {string} raw 模型原始输出。
 * @returns {object|null} 解析出的对象，失败返回 null。
 */
export function extractJson(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return null

  const attempt = (candidate) => {
    try {
      const parsed = JSON.parse(candidate)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  const direct = attempt(text)
  if (direct !== null) return direct

  // ```json ... ``` 或 ``` ... ```。**逐个尝试所有围栏块**：模型先给一个坏块或
  // 示例块、再给正确块的写法很常见，只看第一个会白白掉进降级。
  for (const match of text.matchAll(/```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi)) {
    const inside = attempt(match[1].trim())
    if (inside !== null) return inside
  }

  // 最外层大括号：**配平扫描**找到闭合位置。
  //
  // 不能简单地取"第一个 { 到最后一个 }"：模型爱在结尾补一句说明（"不需要时请返回 {}"）
  // 或举个第二个例子，尾随的 `}` 会让整段切片变成非法 JSON，于是明明能解析的输出被
  // 判成解析失败、降级成一坨原文。也不能只数括号：字符串里的 `{"code":"if(x){y()}"}`
  // 会把括号计数带偏 —— 所以扫描器必须感知字符串与转义。
  //
  // 扫描时**跳过空对象**：模型常在正文里写"不需要时返回 {}"这类说明，`{}` 本身是合法
  // JSON，先命中它就会把真正的内容整段丢掉。空对象不可能是结构化结果，没有保留价值。
  let cursor = text.indexOf('{')
  while (cursor !== -1) {
    const balanced = sliceBalanced(text, cursor)
    if (balanced === null) break
    const parsed = attempt(balanced)
    if (parsed !== null && Object.keys(parsed).length > 0) return parsed
    cursor = text.indexOf('{', cursor + 1)
  }

  return null
}

/**
 * 从 `start`(必须是 `{`) 开始配平扫描出第一个完整的 JSON 对象文本。
 *
 * 感知双引号字符串与反斜杠转义，因此 `{"code":"a}b"}` 不会被提前截断。
 *
 * @param {string} text 原文。
 * @param {number} start `{` 的下标。
 * @returns {string|null} 配平的切片，或未闭合时的 null。
 */
function sliceBalanced(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 从模板定义里取出小节标题列表。
 * @param {object|null} template 模板对象。
 * @returns {string[]} 小节标题；模板无效时返回空数组。
 */
export function sectionTitles(template) {
  const sections = template && Array.isArray(template.sections) ? template.sections : []
  const out = []
  for (const section of sections) {
    if (section && typeof section.title === 'string' && section.title.trim().length > 0) {
      out.push(section.title.trim())
    }
  }
  return out
}

/**
 * 把模型给的字段对齐到模板小节上。
 *
 * 匹配规则：先按标题**精确**匹配，再按**去掉空白与标点后**匹配。都对不上就当
 * 模型没给这一节 —— 返回空串，由渲染时决定显示"（未提供）"。**不猜**语义相近
 * 的字段（"目标"和"目的"不自动等价），猜错比缺失更糟。
 *
 * @param {object|null} parsed 解析出的对象。
 * @param {string[]} titles 模板小节标题。
 * @returns {{ values: Record<string, string>, unconsumed: string[] }}
 *   `values` 是标题 → 正文；`unconsumed` 是模型给了但模板里没有的键
 *   （用来在渲染时提示"模型答非所问"，而不是静默丢掉它的内容）。
 */
export function matchSections(parsed, titles) {
  // `Object.create(null)`：标题可能来自模型给的键名，`__proto__` 走普通对象会改原型。
  const out = Object.create(null)
  if (!parsed || typeof parsed !== 'object') return { values: out, unconsumed: [] }
  // 反引号、下划线、引用块符号也算 markdown 装饰：模型常写 `` `目标` `` 或 `> 目标`。
  const normalize = (value) => String(value).replace(/[\s:：*#\-—`_>]/gu, '').toLowerCase()
  const keys = Object.keys(parsed)
  const normalizedKeys = new Map(keys.map((key) => [normalize(key), key]))
  const used = new Set()

  for (const title of titles) {
    let value
    let matchedKey
    if (Object.prototype.hasOwnProperty.call(parsed, title)) {
      value = parsed[title]
      matchedKey = title
    } else {
      const key = normalizedKeys.get(normalize(title))
      if (key !== undefined) {
        value = parsed[key]
        matchedKey = key
      }
    }
    if (matchedKey !== undefined) used.add(matchedKey)
    if (value === undefined || value === null) {
      out[title] = ''
      continue
    }
    out[title] = typeof value === 'string'
      ? value.trim()
      : Array.isArray(value)
        ? value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n')
        : JSON.stringify(value, null, 2)
  }

  const unconsumed = keys.filter((key) => !used.has(key))
  return { values: out, unconsumed }
}

/**
 * 把匹配好的小节渲染成最终 markdown。
 * @param {string[]} titles 小节标题，按模板顺序。
 * @param {Record<string, string>} values 标题 → 正文。
 * @returns {string} 渲染结果。
 */
export function renderSections(titles, values) {
  const blocks = []
  for (const title of titles) {
    const body = values[title]
    blocks.push(`## ${title}\n\n${body && body.length > 0 ? body : '（未提供）'}`)
  }
  return blocks.join('\n\n')
}

/**
 * 把模型输出变成可展示、可发送的结构化文本。
 *
 * @param {string} raw 模型原始输出。
 * @param {object|null} template 选中的模板。
 * @returns {{ text: string, degraded: boolean, missing: string[], raw: string, unconsumed: string[] }}
 *   `text` 是最终结果；`degraded` 为真表示"没能解析成结构，塞的是原文"；
 *   `missing` 是模板里模型没给的小节标题；`unconsumed` 是模型给了但模板没有的键。
 */
export function buildStructured(raw, template) {
  const titles = sectionTitles(template)
  const source = String(raw ?? '').trim()

  // 模板无效（没有小节）：退回原文，且明确标记降级 —— 没有骨架就谈不上"结构化"。
  if (titles.length === 0) {
    return { text: source, degraded: true, missing: [], raw: source, unconsumed: [] }
  }

  const parsed = extractJson(source)
  if (parsed !== null) {
    const { values, unconsumed } = matchSections(parsed, titles)
    const missing = titles.filter((title) => values[title].length === 0)

    // "答非所问"的判据是**键有没有对上**，不是值空不空。
    //
    // `describeTemplate()` 明确要求模型"没有信息的小节写空字符串，不要编造"——
    // 所以 `{"目标":"","约束":""}` 是**完全合规**的回答，只是这次确实没内容。
    // 若按 `missing.length === titles.length` 判降级，模型越听话越容易被误报成
    // "没按模板返回"，客户端弹一条假警报。
    //
    // `unconsumed` 非空才说明模型用了模板里没有的键 —— 那才是答非所问。
    if (unconsumed.length > 0 && missing.length === titles.length) {
      const fallback = Object.create(null)
      for (const title of titles) fallback[title] = ''
      const note = unconsumed.length > 0
        ? `模型返回的键是：${unconsumed.join('、')}\n\n原文：\n${source}`
        : source
      fallback[titles[0]] = note.length > 0 ? note : '（模型没有返回内容）'
      return {
        text: renderSections(titles, fallback),
        degraded: true,
        missing: titles,
        raw: source,
        unconsumed,
      }
    }

    return {
      text: renderSections(titles, values),
      degraded: false,
      missing,
      raw: source,
      unconsumed,
    }
  }

  // 降级：保留模板骨架，把原文塞进第一个小节。用户一眼能看出这是原文不是结构，
  // 同时骨架还在，可以直接在上面改。
  const fallback = Object.create(null)
  for (const title of titles) fallback[title] = ''
  fallback[titles[0]] = source.length > 0 ? source : '（模型没有返回内容）'
  return {
    text: renderSections(titles, fallback),
    degraded: true,
    missing: titles.slice(1),
    raw: source,
    unconsumed: [],
  }
}

/**
 * 按模板拼出给模型看的结构要求（放进 system 提示词）。
 * @param {object|null} template 模板。
 * @returns {string} 要求文本；模板无效时返回空串。
 */
export function describeTemplate(template) {
  const sections = template && Array.isArray(template.sections) ? template.sections : []
  const lines = []
  for (const section of sections) {
    if (!section || typeof section.title !== 'string') continue
    const hint = typeof section.hint === 'string' && section.hint.length > 0 ? `：${section.hint}` : ''
    lines.push(`- "${section.title.trim()}"${hint}`)
  }
  if (lines.length === 0) return ''
  return [
    '只输出一个 JSON 对象，不要任何解释、不要代码块围栏。',
    'JSON 的键必须严格使用下面这些标题（包括标点），值的类型是字符串：',
    ...lines,
    '没有信息的小节，值写空字符串，不要编造。',
  ].join('\n')
}
