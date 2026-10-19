/**
 * 状态与模板的读写。
 *
 * 分成 `state.json`（开关、默认模板、模型路由、统计）与 `templates.json`
 * （模板库）两份文件，因为它们的所有者不同：前者是插件自己维护的，
 * 后者是**用户可以直接编辑**的。混在一起会让用户在改模板时不小心动到状态。
 *
 * 两条纪律：
 * - **读失败一律回落默认值，绝不拒绝启动**。状态文件坏了最坏是设置丢失，
 *   不应该是插件不上。
 * - **写盘先写临时文件再 rename**。直接 writeFile 被打断会留下半截 JSON，
 *   下次启动读到它就是一份坏状态。
 *
 * @module dsh-structured-input/state
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件自己的数据目录名。 */
const DATA_DIRNAME = 'structured-input'

/** 状态文件名。 */
const STATE_FILENAME = 'state.json'

/** 模板文件名。 */
const TEMPLATES_FILENAME = 'templates.json'

/** 提示词文件名。 */
const PROMPT_FILENAME = 'prompt.md'

/** 出厂默认状态。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  templateId: 'task',
  context: Object.freeze({
    /** 上下文预算（字符）。 */
    maxChars: 12000,
  }),
  llm: Object.freeze({
    provider: '',
    model: '',
    /** 0 = 按输入长度自动估算。 */
    maxTokens: 0,
    timeoutMs: 60000,
  }),
})

/**
 * 去掉 UTF-8 BOM。
 *
 * Windows 记事本保存 UTF-8 会带 BOM，`JSON.parse` 见到它会直接抛、`readFileSync`
 * 也不会帮你剥。而 README 明说"直接改这个文件就行"——不剥 BOM 等于"用户按最自然
 * 的方式保存，配置就整份失效且毫无提示"。
 *
 * @param {string} value 读到的文本。
 * @returns {string} 去掉开头 BOM 的文本。
 */
function stripBom(value) {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

/** 解析插件数据目录。 */
export function dataDirectory() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, DATA_DIRNAME)
}

/** 状态文件路径。 */
export function stateFile() {
  return join(dataDirectory(), STATE_FILENAME)
}

/** 模板文件路径（用户可改的那一份）。 */
export function templatesFile() {
  return join(dataDirectory(), TEMPLATES_FILENAME)
}

/** 提示词文件路径（用户可改的那一份）。 */
export function promptFile() {
  return join(dataDirectory(), PROMPT_FILENAME)
}

/** 包内自带的资源路径。 */
function bundledPath(filename) {
  return join(dirname(fileURLToPath(import.meta.url)), filename)
}

/** 包内自带的模板。 */
export function bundledTemplatesFile() {
  return bundledPath(TEMPLATES_FILENAME)
}

/** 包内自带的提示词。 */
export function bundledPromptFile() {
  return bundledPath(PROMPT_FILENAME)
}

/** 把未知输入收敛成布尔。 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 把未知输入收敛成非负数。 */
function nonNegative(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** 把未知输入收敛成非空字符串（允许空串，因为 provider/model 可以为空表示"用默认"）。 */
function text(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/**
 * 校验并规整一份状态。非法字段回落默认值，绝不因为坏数据拒绝启动。
 *
 * `defaults` 可以是**不完整**的：调用方传 `{ enabled: false }` 这种局部覆盖是合理用法，
 * 而 `readState()` 的保命路径正是 `sanitizeState(defaults, defaults)` —— 那条路径自己
 * 抛错就等于"读盘失败时插件直接崩"，与文件头承诺相反。所以这里先把 defaults 补齐。
 *
 * @param {unknown} raw 候选状态。
 * @param {object} [defaults] 兜底默认值（可局部）。
 * @returns {object} 规整后的状态。
 */
export function sanitizeState(raw, defaults = DEFAULTS) {
  const base = defaults && typeof defaults === 'object' ? defaults : {}
  const safeDefaults = {
    ...DEFAULTS,
    ...base,
    context: { ...DEFAULTS.context, ...(base.context && typeof base.context === 'object' ? base.context : {}) },
    llm: { ...DEFAULTS.llm, ...(base.llm && typeof base.llm === 'object' ? base.llm : {}) },
  }
  const source = raw && typeof raw === 'object' ? raw : {}
  const contextRaw = source.context && typeof source.context === 'object' ? source.context : {}
  const llmRaw = source.llm && typeof source.llm === 'object' ? source.llm : {}
  const maxChars = nonNegative(contextRaw.maxChars, safeDefaults.context.maxChars)
  return {
    enabled: bool(source.enabled, safeDefaults.enabled),
    templateId: text(source.templateId, safeDefaults.templateId),
    context: {
      // 0 会让上下文彻底失效，按默认值处理。
      maxChars: maxChars > 0 ? maxChars : safeDefaults.context.maxChars,
    },
    llm: {
      provider: text(llmRaw.provider, safeDefaults.llm.provider),
      model: text(llmRaw.model, safeDefaults.llm.model),
      maxTokens: nonNegative(llmRaw.maxTokens, safeDefaults.llm.maxTokens),
      timeoutMs: nonNegative(llmRaw.timeoutMs, safeDefaults.llm.timeoutMs) || safeDefaults.llm.timeoutMs,
    },
    stats: source.stats && typeof source.stats === 'object' ? { ...source.stats } : {},
    // 负数没有意义，且会被 publicState 原样发给客户端。
    revision: Math.max(0, Number.isFinite(Number(source.revision)) ? Number(source.revision) : 0),
  }
}

/**
 * 读状态。文件不存在或损坏都返回默认值。
 * @param {object} defaults 默认值。
 * @returns {Promise<object>} 状态。
 */
export async function readState(defaults = DEFAULTS) {
  try {
    const raw = stripBom(await readFile(stateFile(), 'utf8'))
    const next = sanitizeState({ ...defaults, ...JSON.parse(raw) }, defaults)
    readState.lastError = null
    return next
  } catch (error) {
    // 读失败必须回落默认值（插件不能因为一个坏文件就不启动），但**不能静默**：
    // 用户的配置此刻已经丢了，唯一的痕迹就是这条记录。调用方按需上报。
    readState.lastError = error && error.code === 'ENOENT'
      ? null
      : String((error && error.message) || error)
    return sanitizeState(defaults, defaults)
  }
}

/** 最近一次 `readState()` 的失败原因（`ENOENT` 不算失败）；成功时为 null。 */
readState.lastError = null

/**
 * 写状态。串行化由调用方负责（见 index.js 的 writeChain）。
 * @param {object} state 完整状态。
 * @returns {Promise<void>} 写盘完成。
 */
export async function writeState(state) {
  const file = stateFile()
  await mkdir(dirname(file), { recursive: true })
  // 临时文件名必须唯一。固定 `${file}.tmp` 时两个并发写者会互相踩：一方的
  // `writeFile` 与另一方的 `rename` 交错，写出尾部多一个 `}` 的非法 JSON，而
  // **两边都返回成功**；下次 `readState()` 解析失败则静默回落全默认值，用户配置
  // 无声消失。带上 pid + 时间 + 随机串后，并发写退化成"后 rename 的赢"，至少
  // 落盘的永远是一份完整 JSON。
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify({ ...state, savedAt: Date.now() }, null, 2), 'utf8')
    await rename(tmp, file)
  } catch (error) {
    // 失败别留下临时文件残骸。
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * 解析一份模板文件内容。
 *
 * 接受两种写法：`{ "templates": [...] }` 或裸数组 `[...]`。用户手改文件时
 * 很容易只留下数组，两种都认能少一次"改完插件就坏了"。
 *
 * @param {string} raw 文件内容。
 * @returns {object[]} 模板数组；无法解析时返回空数组。
 */
export function parseTemplates(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.templates) ? parsed.templates : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.id !== 'string' || item.id.trim().length === 0) continue
    // 去重用**归一化后**的 id：`"a"` 与 `" a "` 在界面上是同一个名字（name 回落成 id），
    // 当两个模板放出来用户分不清。重复只保留第一个 —— 后出现的多半是复制粘贴忘了改。
    const key = item.id.trim()
    if (seen.has(key)) continue
    seen.add(key)
    const sections = Array.isArray(item.sections)
      ? item.sections.filter((section) => section && typeof section.title === 'string' && section.title.trim().length > 0)
      : []
    out.push({
      id: key,
      name: typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id,
      sections: sections.map((section) => ({
        title: section.title.trim(),
        hint: typeof section.hint === 'string' ? section.hint : '',
      })),
    })
  }
  return out
}

/**
 * 读模板库：数据目录优先，其次包内自带。
 *
 * **不做缓存**：模板文件很小，而"改完立刻生效"比省这一次 `statSync` 重要得多。
 *
 * @returns {{ templates: object[], source: 'file'|'bundled', path: string }}
 */
export function resolveTemplates() {
  const candidates = [
    { path: templatesFile(), source: 'file' },
    { path: bundledTemplatesFile(), source: 'bundled' },
  ]
  for (const candidate of candidates) {
    let info
    try {
      info = statSync(candidate.path)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    try {
      const templates = parseTemplates(stripBom(readFileSync(candidate.path, 'utf8')))
      if (templates.length > 0) {
        return { templates, source: candidate.source, path: candidate.path }
      }
    } catch {
      continue
    }
  }
  return { templates: [], source: 'bundled', path: '' }
}

/**
 * 按 id 找模板；找不到就返回第一个；一个都没有就返回 null。
 * @param {object[]} templates 模板列表。
 * @param {string} id 期望的模板 id。
 * @returns {object|null} 模板。
 */
export function pickTemplate(templates, id) {
  if (!Array.isArray(templates) || templates.length === 0) return null
  const found = templates.find((template) => template.id === id)
  return found ?? templates[0]
}

/** 提示词缓存：按 mtime+size 失效。 */
const promptCache = { path: '', mtimeMs: -1, size: -1, text: '' }

/** 两个提示词文件都读不到时的紧急兜底。刻意写得短。 */
const BUILTIN_PROMPT = [
  '你是结构化提示词构建专家。把用户的需求改写成结构清晰、可执行的中文提示词。',
  '必须遵守：技术内容（技术栈、参数、数值、约束、验收标准）一律不得增删篡改或臆测；',
  '只输出要求的 JSON 对象，不要解释、不要代码块围栏。',
].join('\n')

/**
 * 读提示词：数据目录 → 包内自带 → 内置常量。
 * @returns {{ text: string, source: 'file'|'bundled'|'builtin', path: string, chars: number }}
 */
export function resolvePrompt() {
  const candidates = [
    { path: promptFile(), source: 'file' },
    { path: bundledPromptFile(), source: 'bundled' },
  ]
  for (const candidate of candidates) {
    let info
    try {
      info = statSync(candidate.path)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    try {
      if (promptCache.path === candidate.path
        && promptCache.mtimeMs === info.mtimeMs
        && promptCache.size === info.size
        && promptCache.text.trim().length > 0) {
        return { text: promptCache.text, source: candidate.source, path: candidate.path, chars: promptCache.text.length }
      }
      const content = stripBom(readFileSync(candidate.path, 'utf8'))
      if (content.trim().length === 0) continue
      promptCache.path = candidate.path
      promptCache.mtimeMs = info.mtimeMs
      promptCache.size = info.size
      promptCache.text = content
      return { text: content, source: candidate.source, path: candidate.path, chars: content.length }
    } catch {
      continue
    }
  }
  return { text: BUILTIN_PROMPT, source: 'builtin', path: '', chars: BUILTIN_PROMPT.length }
}

/**
 * 首次激活时把包内的提示词与模板播种到数据目录。已存在则不覆盖。
 * @returns {Promise<{ prompt: string, templates: string }>} 各自的播种结果。
 */
export async function seed() {
  await mkdir(dataDirectory(), { recursive: true })
  const results = { prompt: 'failed', templates: 'failed' }
  const pairs = [
    ['prompt', promptFile(), bundledPromptFile()],
    ['templates', templatesFile(), bundledTemplatesFile()],
  ]
  for (const [key, target, source] of pairs) {
    if (existsSync(target)) {
      results[key] = 'exists'
      continue
    }
    try {
      await copyFile(source, target)
      results[key] = 'seeded'
    } catch {
      results[key] = 'failed'
    }
  }
  return results
}
