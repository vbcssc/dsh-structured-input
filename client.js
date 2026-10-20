/**
 * dsh-structured-input — 浏览器半边。
 *
 * 两个槽位注册，共用同一个 `store` 座位：
 *  - `conversation.input.left`（list）—— 工具栏上的药丸按钮，与硬邦邦插件相邻。
 *  - `conversation.input.dock`（list）—— 弹窗本体，未打开时返回 null 不占空间。
 *
 * **本插件不拦截发送**。它不注册全局快捷键、不接管发送按钮、不碰
 * `agent/pre-step`、不读写会话草稿。用户点按钮 → 打开弹窗 → 输入需求 → 点生成 →
 * 看结果 → 自己决定复制还是发送。因此它和 `dsh-prompt-hardener`（那个会劫持发送
 * 并改写）可以同时开着。
 *
 * 弹窗内自己的文本框上有 Ctrl/Cmd+Enter 快捷生成，只作用于那个 textarea。
 *
 * 三点刻意的取舍：
 * - **药丸规格照抄相邻控件**。28px 高、`box-sizing: border-box`、`border-radius:
 *   var(--dsw-radius-sm)`、12px 字号 —— 与硬邦邦药丸和模型选择器同高同圆角，才
 *   不会在工具栏里显得错位。
 * - **弹窗用 `position: fixed` 遮罩**。挂在 `input.dock`（会话作用域，能拿到
 *   `sessionId`）里也能真正浮起来；不需要绕 `shell.overlay`（那是 root 作用域，
 *   拿不到会话 id）。
 * - **只用主题变量**（`--dsw-alias-*`），深浅色主题都跟着走。
 *
 * @module dsh-structured-input/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-structured-input',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { defineStore } = require('@deepseek-ai/dsh-client-store')
    const { createPortal } = require('react-dom')
    const { useModalLayer } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 必须等于 host 包名：模块表按包身份对账。 */
    const name = 'dsh-structured-input'

    /**
     * 测试缝的落点。挂模块作用域而不是 `this`：Cordis 分离调用 `apply`，
     * 严格模式下 `this` 是 `undefined`（详见 `apply` 末尾的说明）。
     */
    let internals = null

    /** host 注册的状态路由。 */
    const STATE_ROUTE = '/plugins/dsh-structured-input/state.json'

    /** host 注册的生成路由。 */
    const GENERATE_ROUTE = '/plugins/dsh-structured-input/generate'

    /** 语言域命名空间。 */
    const NS = 'structured-input'

    /**
     * 生成请求的客户端超时。宿主那次模型调用自己有 60 秒上限，这里留出余量。
     * 没有这道闸的话，请求一旦卡住，弹窗会永远停在"生成中"。
     */
    const GENERATE_TIMEOUT_MS = 90000

    /** 提示文案展示时长。 */
    const HINT_MS = 2000

    const DICT = {
      zh: {
        label: '结构化',
        title: '结构化输入',
        hint: '把你的需求 + 当前会话上下文，按模板嚼成结构化提示词。',
        placeholder: '说清楚要干什么。上下文会自动带上，不用重复前文。',
        template: '模板',
        contextLabel: '上下文',
        contextPresets: {
          off: '不带上文',
          brief: '最近 5 条',
          standard: '最近 10 条',
          deep: '最近 20 条',
          full: '尽可能多',
        },
        contextPresetHint: '带上多少会话历史用来理解「刚才那个」之类的指代',
        generate: '生成',
        generating: '生成中',
        regenerate: '重新生成',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败（浏览器拒绝了剪贴板访问）',
        templateUnavailable: '（模板不可用）',
        presetUnavailable: '（宿主未提供档位）',
        previewShow: '看模板',
        previewHide: '收起',
        previewHint: '展开看看这个模板会要你填哪些内容',
        send: '发送',
        close: '关闭',
        context: '上下文',
        contextUsed: (n) => `已带上 ${n} 条历史`,
        contextOmitted: (n) => `，更早的 ${n} 条已省略`,
        contextNone: '没有可用历史，只用当前需求',
        contextReasons: {
          'no-session-id': '没有会话标识',
          'no-sessions-service': '宿主没有会话服务',
          'session-unavailable': '会话读取失败',
          'session-not-live': '会话尚未就绪',
          'derive-failed': '历史解析失败',
          'empty-history': '这是第一条消息',
          'preset-off': '已关闭上下文（只发送当前需求）',
          'budget-too-small': '历史太长，但上下文档位太小，一条都没装下',
        },
        degraded: '模型没按模板返回结构，下面是原文骨架，请自行整理',
        missing: (list) => `这些小节模型没给：${list}`,
        failed: '生成失败',
        truncated: '模型输出被长度上限截断，结果不完整。可以调大 llm.maxTokens，或把需求拆短',
        timeout: '等太久了，这次请求已中断。可以重试，或者把需求拆短一些',
        empty: '先在左边写上你的需求',
        draftEmpty: '没有内容可发送',
        sendFailed: '发送失败',
        hintSendBlocked: '当前会话未就绪，无法发送',
      },
    }

    const CSS = `
.si-root { position: relative; display: inline-flex; align-items: center; }

/* 药丸照抄相邻控件规格：28px 高、无描边、透明底、圆角与模型选择器一致。
   box-sizing 不能省 —— 高度按 28px 声明，内边距若在它之外撑开就会错位。 */
.si-pill {
  box-sizing: border-box;
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px;
  border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap;
}
.si-pill:hover { background: var(--dsw-alias-interactive-bg-hover); }
.si-pill[data-open="true"] { background: var(--dsw-alias-interactive-bg-active); }
.si-pill svg { flex: none; }

/* 遮罩：fixed 保证它浮在内容流之上，不受 input.dock 父容器影响。
   与 DSH 自己的 Modal 原语同一套观感。 */
.si-mask {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  /* 上边距要走仓库的台面适配：macOS 红绿灯 / Windows 标题栏下，高弹窗会压到
     拖拽条。变量缺失时回落到 24px，与 Modal.module.css 的写法一致。 */
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px 24px;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-mask-1);
}

.si-modal {
  display: flex; flex-direction: column;
  width: clamp(640px, 78vw, 960px); max-width: 100%; max-height: 78vh;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: 0 12px 40px rgb(0 0 0 / 32%);
  color: var(--dsw-alias-label-primary);
  font-size: 13px; overflow: hidden;
}

.si-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.si-title { font-size: 14px; font-weight: 600; }
.si-sub { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.si-x {
  margin-left: auto; flex: none;
  width: 24px; height: 24px; padding: 0;
  border: none; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 16px; line-height: 1;
}
.si-x:hover { background: var(--dsw-alias-interactive-bg-hover); }

.si-body {
  flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: 14px; display: flex; flex-direction: column; gap: 12px;
}

.si-row { display: flex; align-items: center; gap: 8px; flex: none; }
.si-label { color: var(--dsw-alias-label-secondary); font-size: 12px; flex: none; }
.si-select {
  height: 28px; padding: 0 8px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm);
  /* 必须是**实体**背景，不能用 transparent。原生下拉面板由系统绘制、不吃 CSS，
     深色主题下 option 继承了浅色文字却落在系统浅色面板上，就成了白字白底 ——
     只有悬停时系统反白一下才看得见。仓库的 ConfigField 同样用实体色。 */
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-size: 12px;
}

/* option 单独上色：Windows 上弹层是系统绘制的，不继承 select 的 background，
   但**会**继承 color。不显式给背景就会沿用系统浅底 + 深色主题的白字。 */
.si-select option {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
}

.si-preview-toggle {
  height: 28px; padding: 0 10px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; cursor: pointer;
}

.si-preview-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
.si-preview-toggle[data-open="true"] { color: var(--dsw-alias-label-primary); }

.si-preview {
  display: flex; flex-direction: column; gap: 6px;
  margin: 0 0 10px; padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  max-height: 180px; overflow: auto;
}

.si-preview-item { display: flex; flex-direction: column; gap: 2px; }
.si-preview-title { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 600; }
.si-preview-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }

.si-textarea {
  display: block; width: 100%; box-sizing: border-box;
  min-height: 110px; max-height: 240px; resize: vertical;
  padding: 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 13px; line-height: 1.6;
}
.si-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }

.si-out {
  display: block; width: 100%; box-sizing: border-box;
  min-height: 200px; max-height: 46vh;
  padding: 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 12px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word;
  overflow: auto; resize: vertical;
}

.si-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.6; }
.si-warn {
  padding: 8px 10px; border-radius: 8px; line-height: 1.6;
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}
.si-err {
  padding: 8px 10px; border-radius: 8px; line-height: 1.6; word-break: break-word;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-state-error-primary);
}

.si-foot {
  display: flex; align-items: center; gap: 8px; flex: none;
  padding: 10px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.si-spacer { margin-left: auto; }
.si-btn {
  height: 28px; padding: 0 12px; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 1; cursor: pointer;
}
.si-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.si-btn:disabled { opacity: .5; cursor: not-allowed; }
.si-btn-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground); font-weight: 600;
}
.si-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
`

    /** 注入样式（只注一次）。 */
    function mountStyles() {
      const selector = 'style[data-plugin="dsh-structured-input"]'
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      // `data-plugin` 是**必须**的：模块系统在实例化每个插件后会跑 `claimStyles`，
      // 把所有没打标记的 `<style>` 收归给当时那个插件。不标的话本插件的样式会被
      // 下一个物化的插件"领走"，那个插件卸载时 `removeOwnedStyles` 会把它们一起
      // 删掉 —— 表现为"某个不相干的插件一重载，本插件的按钮就没样式了"。
      tag.dataset.plugin = 'dsh-structured-input'
      tag.dataset.siCss = 'dsh-structured-input'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /** 药丸上的图标：几条横线，暗示"结构化"。 */
    function pillIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'currentColor' },
        h('rect', { x: 2, y: 3, width: 12, height: 2, rx: 1 }),
        h('rect', { x: 2, y: 7, width: 8, height: 2, rx: 1 }),
        h('rect', { x: 2, y: 11, width: 10, height: 2, rx: 1 }))
    }

    /**
     * 会话内的状态。
     *
     * `active` 由入口按钮切换，弹窗组件读同一个 store 实例 —— 两个注册声明的是
     * 同一个 handle、同一 scope，渲染器按「handle × sessionId」共享实例。
     */
    function createStore() {
      return defineStore({
        init: () => ({
          active: false,
          draft: '',
          templateId: '',
          /** 上下文档位 id。空串表示"跟 host 的默认档"，host 会收敛到默认值。 */
          contextPreset: '',
          phase: 'idle',
          result: null,
          error: '',
          contextInfo: null,
          meta: null,
          /** 模板预览是否展开。 */
          previewOpen: false,
        }),
        actions: {
          open: (draft) => { draft.active = true },
          close: (draft) => { draft.active = false; draft.error = ''; draft.previewOpen = false },
          setDraft: (draft, value) => { draft.draft = value },
          setTemplate: (draft, value) => { draft.templateId = value },
          setContextPreset: (draft, value) => { draft.contextPreset = value },
          togglePreview: (draft) => { draft.previewOpen = !draft.previewOpen },
          start: (draft) => {
            draft.phase = 'working'
            draft.error = ''
            draft.result = null
            draft.contextInfo = null
            draft.meta = null
          },
          succeed: (draft, payload) => {
            draft.phase = 'ready'
            draft.result = payload.text
            draft.contextInfo = payload.context || null
            draft.meta = {
              degraded: payload.degraded === true,
              missing: Array.isArray(payload.missing) ? payload.missing : [],
              template: payload.template || null,
            }
          },
          fail: (draft, message) => {
            draft.phase = 'error'
            draft.error = message
          },
          setIdle: (draft) => { draft.phase = 'idle'; draft.error = '' },
        },
      })
    }

    /**
     * 读 host 状态。失败不抛 —— 弹窗照常能开，只是模板列表空着。
     * @returns {Promise<object|null>} 状态。
     */
    async function fetchState() {
      try {
        const res = await fetch(STATE_ROUTE, { cache: 'no-store' })
        if (!res.ok) return null
        const data = await res.json().catch(() => null)
        return data && data.ok === true ? data.state : null
      } catch {
        return null
      }
    }

    /**
     * 入口药丸。
     *
     * @param {object} t 文案函数。
     * @param {object} store store 句柄。
     * @returns {Function} 组件。
     */
    function makePill(t, store) {
      return function StructuredInputPill(props) {
        // 一次解构、一个兜底：`props` 为 undefined 时下面每个成员都安全。
        // 之前先解构 sessionId 又直接读 props.useStore，两套写法混用，props 缺失时
        // 第二行会抛 TypeError。
        const { sessionId, useStore, actions } = props || {}
        const active = typeof useStore === 'function' ? useStore((state) => state.active) : false
        const disabled = sessionId === undefined || !actions
        return h('span', { className: 'si-root', 'data-si-owned': 'true' },
          h('button', {
            type: 'button',
            className: 'si-pill',
            'data-open': String(active),
            title: t('hint'),
            'aria-haspopup': 'dialog',
            'aria-expanded': active,
            disabled,
            style: disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined,
            // 不抢输入框焦点。
            onMouseDown: (event) => { event.preventDefault() },
            onClick: () => { if (!disabled) actions.open() },
          }, pillIcon(), h('span', null, t('label'))))
      }
    }

    /**
     * 弹窗。挂在 `conversation.input.dock`。
     *
     * @param {object} t 文案函数。
     * @param {object} ctx 浏览器侧上下文（取会话发送能力）。
     * @returns {Function} 组件。
     */
    function makeDialog(t, ctx) {
      return function StructuredInputDialog(props) {
        const { sessionId, useStore, actions } = props || {}
        // 座位没注进来时不能调用它：调用 undefined 会抛 TypeError，条目随即被隔离、
        // 弹窗永远不出现，而表面上什么错都看不到。这里退化成一个恒空的选择器。
        const read = typeof useStore === 'function' ? useStore : () => undefined
        // hook 必须在提前返回之前调用，且数量不能随状态变化。
        const active = read((state) => state.active)
        const draft = read((state) => state.draft)
        const templateId = read((state) => state.templateId)
        const contextPreset = read((state) => state.contextPreset)
        const phase = read((state) => state.phase)
        const result = read((state) => state.result)
        const error = read((state) => state.error)
        const contextInfo = read((state) => state.contextInfo)
        const meta = read((state) => state.meta)
        const previewOpen = read((state) => state.previewOpen) === true
        const [hostState, setHostState] = React.useState(null)
        const [hint, setHint] = React.useState('')
        const [nowMs, setNowMs] = React.useState(() => Date.now())
        const startedAtRef = React.useRef(0)
        /** 提示定时器。存 ref 才能在重入时清掉旧的、卸载时收干净。 */
        const hintTimerRef = React.useRef(null)
        /** 弹窗容器。交给 useModalLayer 做 Tab 循环与首焦。 */
        const dialogRef = React.useRef(null)
        /** 弹窗里的文本框。 */
        const textareaRef = React.useRef(null)
        /** 在途生成的 AbortController：关弹窗时要把它掐掉，别让计费调用空跑。 */
        const inflightRef = React.useRef(null)
        /** abort 是超时造成的还是用户主动取消？两者都是 AbortError，不区分会误报。 */
        const timedOutRef = React.useRef(false)

        // 打开时读一次 host 状态（模板清单、默认模板）。
        React.useEffect(() => {
          if (!active) return undefined
          let cancelled = false
          void fetchState().then((state) => { if (!cancelled) setHostState(state) })
          return () => { cancelled = true }
        }, [active])

        // 等待期间推进计时，让用户知道没卡死。
        // 依赖里有 `active`：弹窗关掉之后计时器必须停，否则它会在后台空转重渲染
        // 直到那次请求落地。
        React.useEffect(() => {
          if (!active || phase !== 'working') return undefined
          const timer = window.setInterval(() => setNowMs(Date.now()), 500)
          return () => window.clearInterval(timer)
        }, [active, phase])

        // 模态层：Tab 循环、首焦（`[data-modal-autofocus]`）、Escape 关闭、
        // 关闭时还原焦点，全部由仓库原语负责。
        //
        // 手写版只做了"聚焦文本框"，Tab 仍能把焦点送进遮罩后面 —— 用户会在一片
        // 看着被禁用、实际活着的区域里敲字。
        useModalLayer(dialogRef, active, () => actions.close())

        // 卸载时收掉提示定时器和在途请求。
        //
        // 不 abort 的话，用户关掉弹窗后那次 `llm.stream` 仍会跑满宿主的 timeoutMs
        // —— 一次没人接收的计费调用；结果回来时还会往已经关闭的卡片里写状态。
        React.useEffect(() => () => {
          if (hintTimerRef.current !== null) {
            window.clearTimeout(hintTimerRef.current)
            hintTimerRef.current = null
          }
          if (inflightRef.current !== null) {
            try { inflightRef.current.abort() } catch { /* 已结束就算了 */ }
            inflightRef.current = null
          }
        }, [])

        // 弹窗关掉时同样中止：组件还挂着（dock 里返回 null），卸载 effect 不会跑。
        React.useEffect(() => {
          if (active) return
          if (inflightRef.current !== null) {
            try { inflightRef.current.abort() } catch { /* 同上 */ }
            inflightRef.current = null
          }
        }, [active])

        // Esc 不在这里处理：useModalLayer 已经接管，而且带 IME 守卫 ——
        // 中文输入法候选框按 Esc 取消时事件带 isComposing，手写版会把弹窗直接关掉。

        /**
         * 显示一条有时限的提示。定时器存 ref，重入与卸载都收得住。
         *
         * **必须放在上面的提前 return 之前。** 它是个 hook：`active` 从 false 变
         * true 时若 hook 数量跟着变，React 会抛 "Rendered more hooks than during
         * the previous render"，弹窗第一次打开就崩、条目被错误边界隔离。
         */
        const flashHint = React.useCallback((message) => {
          setHint(message)
          if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current)
          hintTimerRef.current = window.setTimeout(() => {
            hintTimerRef.current = null
            setHint('')
          }, HINT_MS)
        }, [])

        if (!active || sessionId === undefined) return null

        const templates = hostState && hostState.templates && Array.isArray(hostState.templates.items)
          ? hostState.templates.items
          : []
        // 选中项必须是**选项里真实存在的值**：渲染时 options 来自 hostState，
        // 而 store 里的 templateId 初值是空串。直接用空串会让 select 显示空白并
        // 触发 React 的 value 不匹配告警。三级兜底：store → host 默认 → 第一个模板。
        const hasTemplate = (id) => typeof id === 'string' && id.length > 0
          && templates.some((item) => item.id === id)
        const effectiveTemplate = hasTemplate(templateId)
          ? templateId
          : (hasTemplate(hostState && hostState.templateId)
            ? hostState.templateId
            : (templates.length > 0 ? templates[0].id : ''))
        // 上下文档位清单由 host 下发（`state.context.presets`），客户端只负责显示。
        // host 没给清单时用空数组：下拉渲染成"不可用"，而不是自己编一份可能与
        // host 对不上的档位表。
        const presets = hostState && hostState.context && Array.isArray(hostState.context.presets)
          ? hostState.context.presets
          : []
        const hasPreset = (id) => typeof id === 'string' && id.length > 0
          && presets.some((item) => item.id === id)
        // 与模板同样的三级兜底：store → host 默认档 → 列表第一项。
        // 空串直接传给 host 也行（host 会收敛），但那样下拉会显示空白。
        const effectivePreset = hasPreset(contextPreset)
          ? contextPreset
          : (hasPreset(hostState && hostState.context && hostState.context.preset)
            ? hostState.context.preset
            : (presets.length > 0 ? presets[0].id : ''))
        const working = phase === 'working'
        const waited = startedAtRef.current > 0
          ? Math.max(0, Math.round((nowMs - startedAtRef.current) / 1000))
          : 0

        /** 复制到剪贴板。 */
        const copy = () => {
          const text = result || ''
          if (text.length === 0) return
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            void navigator.clipboard.writeText(text).then(
              () => flashHint(t('copied')),
              // 剪贴板被拒时必须说出来。原写法 `String(text.slice(0, 0))` 恒等于空串，
              // 等于把提示静默清掉，用户不知道复制失败了。
              () => flashHint(t('copyFailed')),
            )
          } else {
            flashHint(t('copyFailed'))
          }
        }

        /** 把结果作为一条用户消息发进当前会话。 */
        const send = () => {
          const text = result || ''
          if (text.length === 0) {
            setHint(t('draftEmpty'))
            return
          }
          try {
            const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
            const scoped = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : null
            const conversation = scoped && typeof scoped.get === 'function' ? scoped.get('conversation') : null
            if (!conversation || typeof conversation.send !== 'function') {
              setHint(t('hintSendBlocked'))
              return
            }
            void conversation.send(text).then(() => {
              actions.close()
            }, (cause) => {
              setHint(`${t('sendFailed')}: ${String((cause && cause.message) || cause)}`)
            })
          } catch (cause) {
            setHint(`${t('sendFailed')}: ${String((cause && cause.message) || cause)}`)
          }
        }

        /** 调 host 生成。 */
        const generateNow = () => {
          const text = String(draft || '').trim()
          if (text.length === 0) {
            setHint(t('empty'))
            return
          }
          setHint('')
          actions.start()
          timedOutRef.current = false
          startedAtRef.current = Date.now()
          setNowMs(Date.now())

          let controller = null
          let timer = null
          void (async () => {
            try {
              controller = typeof AbortController === 'function' ? new AbortController() : null
              inflightRef.current = controller
              timer = controller
                ? window.setTimeout(() => { timedOutRef.current = true; controller.abort() }, GENERATE_TIMEOUT_MS)
                : null
              const res = await fetch(GENERATE_ROUTE, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  sessionId,
                  text,
                  templateId: effectiveTemplate,
                  contextPreset: effectivePreset,
                }),
                ...(controller ? { signal: controller.signal } : {}),
              })
              const data = await res.json().catch(() => null)
              if (!data) throw new Error(`HTTP ${res.status}`)
              if (data.ok !== true) {
                // `truncated` 是长度不够，不是普通故障 —— 要给一句能指导用户的话，
                // 而不是把宿主那句英文原文直接甩出来。
                const message = data && data.errorKind === 'truncated'
                  ? t('truncated')
                  : ((data && data.error) || t('failed'))
                actions.fail(message)
                return
              }
              actions.succeed(data)
            } catch (cause) {
              const aborted = cause && (cause.name === 'AbortError' || cause.code === 20)
              if (aborted) {
                // 超时才报超时；用户自己关窗只是取消，不该留下失败记录。
                if (timedOutRef.current) actions.fail(t('timeout'))
                else actions.setIdle()
              } else {
                actions.fail(`${t('failed')}：${String((cause && cause.message) || cause)}`)
              }
            } finally {
              if (timer !== null) window.clearTimeout(timer)
              inflightRef.current = null
              startedAtRef.current = 0
            }
          })()
        }

        /* ── 头 ── */
        const head = h('div', { className: 'si-head' },
          h('span', { className: 'si-title' }, t('title')),
          h('span', { className: 'si-sub' }, t('hint')),
          h('button', {
            type: 'button',
            className: 'si-x',
            title: t('close'),
            'aria-label': t('close'),
            onClick: () => actions.close(),
          }, '×'))

        /* ── 上下文提示 ── */
        let contextLine = null
        if (contextInfo) {
          if (contextInfo.used) {
            const omitted = contextInfo.omitted > 0 ? t('contextOmitted')(contextInfo.omitted) : ''
            contextLine = h('div', { key: 'context', className: 'si-meta' }, `${t('context')}：${t('contextUsed')(contextInfo.messages)}${omitted}`)
          } else {
            const reason = contextInfo.reason && t('contextReasons')[contextInfo.reason]
              ? t('contextReasons')[contextInfo.reason]
              : null
            contextLine = h('div', { key: 'context', className: 'si-meta' }, `${t('context')}：${reason || t('contextNone')}`)
          }
        }

        /* ── 模板预览 ── */
        // 下拉里只有模板名，看不到它到底要求写什么。预览把每节的标题和说明摊开，
        // 用户在输入前就知道会被问哪些方面。
        const currentTemplate = templates.find((item) => item.id === effectiveTemplate) || null
        const preview = previewOpen && currentTemplate !== null
          ? h('div', { className: 'si-preview', key: 'preview' },
            (Array.isArray(currentTemplate.sections) ? currentTemplate.sections : []).map((title, index) => {
              // `hints` 是后来才加的字段：旧版宿主没有它，所以按下标对齐后仍要兜底。
              const hints = Array.isArray(currentTemplate.hints) ? currentTemplate.hints : []
              const hint = typeof hints[index] === 'string' ? hints[index] : ''
              return h('div', { className: 'si-preview-item', key: `${index}:${title}` },
                h('span', { className: 'si-preview-title' }, title),
                hint.length > 0 ? h('span', { className: 'si-preview-hint' }, hint) : null)
            }))
          : null

        /* ── 输入区 ── */
        const input = h('div', { className: 'si-body' },
          h('div', { className: 'si-row' },
            h('span', { className: 'si-label' }, t('template')),
            h('select', {
              className: 'si-select',
              value: effectiveTemplate,
              disabled: working,
              onChange: (event) => actions.setTemplate(event.target.value),
            }, templates.length === 0
              ? h('option', { key: 'none', value: '' }, t('templateUnavailable'))
              : templates.map((item) => h('option', { key: item.id, value: item.id }, item.name))),
            currentTemplate !== null
              ? h('button', {
                type: 'button',
                className: 'si-preview-toggle',
                'data-open': String(previewOpen),
                'aria-expanded': previewOpen,
                title: t('previewHint'),
                onMouseDown: (event) => { event.preventDefault() },
                onClick: () => actions.togglePreview(),
              }, previewOpen ? t('previewHide') : t('previewShow'))
              : null),
          // 上下文档位：带上多少会话历史。放在模板下面一行、而不是挤进同一行 ——
          // 两个下拉挨着时，用户会以为它们是一组关联设置；而它们其实互相独立
          // （换模板不必重选上下文）。
          h('div', { className: 'si-row' },
            h('span', { className: 'si-label' }, t('contextLabel')),
            h('select', {
              className: 'si-select',
              title: t('contextPresetHint'),
              value: effectivePreset,
              disabled: working || presets.length === 0,
              onChange: (event) => actions.setContextPreset(event.target.value),
            }, presets.length === 0
              // 不能说「模板不可用」：这里是上下文档位，模板可能好好的。
              // 真实成因几乎总是宿主还是旧版本（旧版不下发 `context.presets`）。
              ? h('option', { key: 'none', value: '' }, t('presetUnavailable'))
              : presets.map((preset) => h('option', { key: preset.id, value: preset.id },
                t('contextPresets')[preset.id] || preset.id)))),
          preview,
          h('textarea', {
            className: 'si-textarea',
            ref: textareaRef,
            'data-modal-autofocus': 'true',
            value: draft,
            spellCheck: false,
            disabled: working,
            placeholder: t('placeholder'),
            onChange: (event) => actions.setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                generateNow()
              }
            },
          }))

        /* ── 结果区 ── */
        const output = []
        if (working) {
          output.push(h('div', { key: 'working', className: 'si-meta' }, `${t('generating')}… ${waited}s`))
        }
        if (error) {
          // `error` 已经是一句完整的话（宿主给的原因，或下面那条超时文案），
          // 再拼一个“生成失败：”前缀就会变成“生成失败：生成失败”。
          output.push(h('div', { key: 'error', className: 'si-err' }, error))
        }
        if (result !== null && result !== undefined && String(result).length > 0) {
          if (meta && meta.degraded) {
            output.push(h('div', { key: 'degraded', className: 'si-warn' }, t('degraded')))
          } else if (meta && Array.isArray(meta.missing) && meta.missing.length > 0) {
            output.push(h('div', { key: 'missing', className: 'si-meta' }, t('missing')(meta.missing.join('、'))))
          }
          output.push(contextLine)
          output.push(h('textarea', {
            key: 'result',
            className: 'si-out',
            value: result,
            spellCheck: false,
            readOnly: true,
          }))
        } else if (!working && !error) {
          output.push(contextLine)
        }

        /* ── 底栏 ── */
        const canUseResult = typeof result === 'string' && result.length > 0 && !working
        const foot = h('div', { className: 'si-foot' },
          h('button', {
            type: 'button',
            className: 'si-btn si-btn-primary',
            disabled: working || String(draft || '').trim().length === 0,
            onClick: generateNow,
          }, working ? `${t('generating')}…` : (canUseResult ? t('regenerate') : t('generate'))),
          h('span', { className: 'si-meta' }, hint),
          h('span', { className: 'si-spacer' }),
          h('button', {
            type: 'button',
            className: 'si-btn',
            disabled: !canUseResult,
            onClick: copy,
          }, t('copy')),
          h('button', {
            type: 'button',
            className: 'si-btn',
            disabled: !canUseResult,
            onClick: send,
          }, t('send')))

        // **必须用 portal 挂到 body**。
        //
        // 弹窗挂在 `conversation.input.dock`，而那个位置的祖先 `.composerSeat` 在
        // active 相位是 `position: sticky; z-index: 7` —— 已经形成层叠上下文。
        // 遮罩的 `z-index: 1000` 只在这个上下文**内部**有效，对外等效于 7：
        // 侧栏(30)、右侧面板(40)、拖拽条(11) 都会盖在遮罩上并且仍然可点。
        // 仓库自带的 `ui-primitives` Modal 也是用 createPortal 挂 body 的。
        const mask = h('div', {
          className: 'si-mask',
          'data-si-owned': 'true',
          // 点遮罩空白处关闭，与仓库的 Modal 原语一致（Modal.tsx 的 mask 上挂
          // onClose）。不接的话用户只能去找那个小小的 ×。
          //
          // 必须判 `target === currentTarget`：在文本框里按下鼠标、拖到弹窗外再松开，
          // click 会沿公共祖先冒泡到遮罩，不判就会把窗关掉。
          onClick: (event) => {
            if (event.target === event.currentTarget) actions.close()
          },
        },
          h('div', {
            className: 'si-modal',
            ref: dialogRef,
            role: 'dialog',
            // `aria-modal` 不只是无障碍：shortcuts 的 modalSelector 靠它识别
            // "有模态开着"，缺了它全局快捷键在弹窗上照常生效。
            'aria-modal': 'true',
            'aria-label': t('title'),
            // 点弹窗本体不能冒到遮罩上，否则在正文里选一段文字就把窗关了。
            onClick: (event) => { event.stopPropagation() },
          },
          head,
          h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
            input),
          h('div', { className: 'si-body', style: { flex: '0 1 auto' } }, output),
          foot))
        return typeof document !== 'undefined' ? createPortal(mask, document.body) : mask
      }
    }

    return {
      name,
      // 只声明真正用到的服务。`locale` 不在这里：本插件的文案内置在 DICT 里，
      // 声明一个从不读取的服务会让缺少它的组装把本插件卡在 PENDING（按钮不出现）。
      inject: ['slots'],
      /** 测试缝：`apply` 跑完之后才有值。 */
      get __internals() { return internals },
      apply(ctx) {
        // HMR 会重跑 apply 而不先卸载旧实例：先拆掉上一份，避免 slot 重复注册。
        try {
          if (typeof window.__SI_DISPOSE__ === 'function') window.__SI_DISPOSE__()
        } catch {
          /* 旧实例已经烂了也不影响新实例 */
        }
        const disposers = []
        const own = (fn, label) => {
          const dispose = ctx.effect(fn, label)
          if (typeof dispose === 'function') disposers.push(dispose)
        }
        window.__SI_DISPOSE__ = () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              /* 逐个拆，坏一个不影响其余 */
            }
          }
        }

        const store = createStore()
        // 文案：拿不到宿主的语言域就连字典本身当函数用（读不到 key 就回退中文）。
        const t = (key) => {
          const dict = DICT.zh
          const value = dict[key]
          return value === undefined ? key : value
        }

        own(() => mountStyles(), `${NS}: styles`)

        own(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: NS,
          // 硬邦邦是 30；31 让它紧邻在它右边。结构化提示词插件是 20。
          order: 31,
          label: () => t('label'),
          store,
        }, makePill(t, store))), `${NS}: composer pill`)

        own(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: NS,
          // 必须避开 20：DSH 自己的队列面板（QueueDock.tsx）就用 20，而 ui-slots
          // 对**相等的 order 保持注册顺序** —— 那取决于插件物化次序，本弹窗排在
          // 队列前面还是后面是不确定的。取 21 把自己钉在队列之后。
          // （todo 面板用 0，不冲突。）
          order: 21,
          label: () => t('label'),
          store,
        }, makeDialog(t, ctx))), `${NS}: dialog`)

        // 测试缝：这些判据在浏览器里没法离线验。
        //
        // **必须挂在模块作用域上，不能挂在 `this` 上**：Cordis 把对象插件解析成
        // 一个**分离的** `apply` 函数（`registry.ts` 的 `isApplicable → plugin.apply`，
        // `fiber.ts` 直接 `runtime.callback(ctx, config)` 调用）。ESM 是严格模式，
        // 分离调用下 `this` 是 `undefined`，`this.x = …` 会抛 TypeError —— 而且是在
        // 所有槽位都注册完之后才抛，表现为"按钮出来了、日志里却有一条加载失败"。
        internals = { DICT, CSS, GENERATE_ROUTE, STATE_ROUTE, createStore }
      },
    }
  },
})
