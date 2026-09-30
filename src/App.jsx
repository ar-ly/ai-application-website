import { useState, useRef, useEffect } from 'react'
import {
  generateAppStream,
  stopGeneration,
  uploadFiles,
  refinePrompt,
  listSessions,
  fetchSession,
  createSessionApi,
  deleteSessionApi,
  markSessionRead,
} from './services/ai.js'
import { pickRecommendations } from './recommendations.js'

const MAX_KEPT_PREVIEWS = 8 // 保活的 iframe 数量上限（LRU 淘汰）

let msgSeq = 0
function uid() {
  msgSeq += 1
  return `m${Date.now().toString(36)}-${msgSeq}`
}

// 读取记忆的栏宽
function readLayout(key, fallback) {
  try {
    const raw = JSON.parse(localStorage.getItem('layout') || '{}')
    const v = Number(raw[key])
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}

// 栏间可拖拽分隔条
function ColumnResizer({ onMouseDown, active }) {
  return (
    <div
      onMouseDown={onMouseDown}
      title="拖拽调整栏宽"
      className="relative z-20 w-[5px] shrink-0 cursor-col-resize group"
    >
      <div
        className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-px transition-colors ${
          active ? 'bg-brand' : 'bg-line group-hover:bg-brand/60'
        }`}
      />
    </div>
  )
}

// ---------------- 小图标 ----------------
function IconPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function IconSun() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}
function IconMoon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
    </svg>
  )
}
function IconExport() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5M12 15V3" />
    </svg>
  )
}
function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  )
}
function IconRefresh() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />
    </svg>
  )
}
function IconDownload() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5M12 15V3" />
    </svg>
  )
}
function IconExternal() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </svg>
  )
}

function formatTime(iso) {
  try {
    const d = new Date(iso)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes(),
    ).padStart(2, '0')}`
  } catch {
    return ''
  }
}

// 聊天消息类型：user / assistant / system / error
// 判断输入是否明显无意义（乱码/纯数字/纯emoji/重复字符等），命中时不触发生成
function isMeaningless(text) {
  const t = text.trim()
  if (!t) return true
  // 含中文 → 视为有意义（中文表达压缩度高，两个字也可能有明确意图）
  if (/[一-鿿]/.test(t)) return false
  // 纯数字/空白
  if (/^[\d\s]+$/.test(t)) return true
  // 同一字符重复（1111、aaaa、!!!!）
  if (/^(.)\1+$/.test(t)) return true
  // 不含任何字母和数字（纯 emoji / 纯符号）
  if (!/[a-zA-Z0-9]/.test(t)) return true
  // 纯英文字母且够长但没有任何元音 → 大概率键盘乱敲（asdfjkl）
  if (/^[a-zA-Z]+$/.test(t) && t.length >= 5 && !/[aeiou]/i.test(t)) return true
  return false
}

// 一键复制按钮：复制成功短暂显示对勾（气泡外操作行使用）
function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false)
  async function copy(e) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用时静默忽略 */
    }
  }
  return (
    <button
      onClick={copy}
      title={copied ? '已复制' : '复制'}
      className={`flex items-center gap-1 px-1.5 py-1 rounded-md text-[11px] transition-colors ${
        copied ? 'text-emerald-600' : 'text-dim/70 hover:text-dim hover:bg-inset'
      }`}
    >
      {copied ? (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          已复制
        </>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

function MessageBubble({ msg }) {
  const isUser = msg.role === 'user'
  const isAssistant = msg.role === 'assistant'
  const isSystem = msg.role === 'system'
  const isError = msg.role === 'error'

  // 用户长消息折叠（超过阈值按高度折叠 + 渐变遮罩）
  const [expanded, setExpanded] = useState(false)
  // hover 显示操作行：用 React state 而非 CSS group-hover，保证任何环境可靠
  const [hover, setHover] = useState(false)
  const LONG_LIMIT = 240
  const isLongUser = isUser && (msg.text?.length || 0) > LONG_LIMIT

  if (isSystem) {
    return (
      <div className="mb-3 px-1 text-xs italic leading-relaxed text-dim whitespace-pre-wrap">
        {msg.text}
      </div>
    )
  }

  return (
    <div
      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-3`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >      <div
        className={`max-w-[88%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm ${
          isUser
            ? 'bg-brand text-white rounded-br-sm'
            : isError
              ? 'bg-danger/10 border border-danger/30 text-danger rounded-bl-sm'
              : 'bg-inset border border-line text-ink rounded-bl-sm'
        }`}
      >
        {(isAssistant || isError) && (
          <div
            className={`text-[10px] uppercase tracking-wide mb-1 font-medium ${
              isError ? 'text-danger' : 'text-dim'
            }`}
          >
            {isError ? '生成失败' : 'Assistant'}
          </div>
        )}
        {isLongUser ? (
          <>
            <div className={`relative ${expanded ? '' : 'max-h-[7.6em] overflow-hidden'}`}>
              {msg.text}
              {!expanded && (
                <div className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-brand via-brand/70 to-transparent pointer-events-none" />
              )}
            </div>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 flex items-center gap-0.5 text-[11px] text-white/75 hover:text-white transition-colors"
            >
              <svg
                width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
              {expanded ? '收起' : '展开全部'}
            </button>
          </>
        ) : (
          msg.text
        )}
        {/* 附件文件名 */}
        {isUser && Array.isArray(msg.attNames) && msg.attNames.length > 0 && (
          <div className="mt-1.5 pt-1.5 border-t border-white/25 flex flex-wrap gap-1">
            {msg.attNames.map((n) => (
              <span
                key={n}
                className="inline-flex items-center gap-1 text-[10px] bg-white/15 rounded px-1.5 py-0.5"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                {n}
              </span>
            ))}
          </div>
        )}
        {/* 排队中徽章 */}
        {isUser && msg.pending && (
          <div className="mt-1.5 flex items-center gap-1 text-[10px] text-white/85">
            <span className="w-2 h-2 rounded-full border-[1.5px] border-white/50 border-t-white animate-spin" />
            已排队，等待当前生成完成…
          </div>
        )}
      </div>
      {/* 操作行：hover 气泡时显示（参考 DeepSeek 交互） */}
      {(isUser || isAssistant || isError) && msg.text && (
        <div
          className={`mt-0.5 flex items-center transition-opacity ${
            hover ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <CopyBtn text={msg.text} />
        </div>
      )}
    </div>
  )
}

// 流式生成中的临时气泡：默认折叠为“思考中”一行，箭头可展开浅色代码块
function StreamingBubble({ text, model }) {
  const [expanded, setExpanded] = useState(false)
  const codeRef = useRef(null)

  useEffect(() => {
    const el = codeRef.current
    if (el && expanded) el.scrollTop = el.scrollHeight
  }, [text, expanded])

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[88%] w-full rounded-xl rounded-bl-sm px-3.5 py-2.5 bg-inset border border-line text-ink shadow-sm">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-2 text-left"
        >
          {/* 折叠态：转圈小图标，展开态：箭头 */}
          {expanded ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-dim shrink-0">
              <path d="M18 15l-6-6-6 6" />
            </svg>
          ) : (
            <span className="w-3 h-3 rounded-full border-2 border-brand/30 border-t-brand animate-spin shrink-0" />
          )}
          <span className="text-xs font-medium text-dim">
            {expanded ? '正在生成代码' : '思考中'}
            <span className="ml-1.5 text-dim/70">{text.length} 字符</span>
            {model && <span className="ml-1.5 text-dim/50">· {model}</span>}
          </span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`ml-auto text-dim shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        {expanded && (
          <pre
            ref={codeRef}
            className="mt-2 max-h-52 overflow-y-auto scroll-thin text-[11px] font-mono whitespace-pre-wrap break-all text-dim bg-panel rounded-lg p-2.5 border border-line"
          >
            {text || '正在连接 DeepSeek...'}
          </pre>
        )}
      </div>
    </div>
  )
}

// 空会话欢迎页：问候语 + 习惯推荐 prompt 卡片 + 换一批
function WelcomePanel({ suggestions, onPick, onRefresh }) {
  return (
    <div className="flex flex-col items-center pt-14 pb-6 px-2">
      <div className="w-14 h-14 rounded-2xl bg-brandSoft flex items-center justify-center mb-4">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-brand">
          <path d="M12 2l2.4 5.6L20 9l-4.5 4 1.2 6L12 16l-4.7 3 1.2-6L4 9l5.6-1.4z" />
        </svg>
      </div>
      <h2 className="text-lg font-semibold text-ink">今天想生成什么应用？</h2>
      <p className="text-xs text-dim mt-1.5">
        描述你的需求，或从下面推荐中挑选一个开始
      </p>
      <p className="text-[11px] text-dim/70 mt-1">
        历史记录保存在当前浏览器中，仅自己可见；长时间无人访问后演示服务会自动重置记录
      </p>

      {suggestions.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5 mt-6 w-full">
          {suggestions.map((item) => (
            <button
              key={item.title}
              onClick={() => onPick(item.prompt)}
              className="flex flex-col items-start gap-1 text-left p-3 rounded-xl bg-inset/60 border border-line hover:border-brand/50 hover:bg-brandSoft/60 hover:shadow-sm transition-all"
            >
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                <span className="text-base leading-none">{item.icon}</span>
                {item.title}
              </span>
              <span className="text-[11px] text-dim leading-snug">{item.desc}</span>
            </button>
          ))}
        </div>
      )}

      <button
        onClick={onRefresh}
        className="flex items-center gap-1.5 mt-4 px-3 py-1.5 rounded-lg text-[11px] text-dim hover:text-brand hover:bg-inset transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 4v6h-6M1 20v-6h6" />
          <path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />
        </svg>
        换一批推荐
      </button>
    </div>
  )
}

export default function App() {
  const [sessions, setSessions] = useState([])
  const [sessionId, setSessionId] = useState('')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [generatingSid, setGeneratingSid] = useState('') // 正在生成的会话（可能不是当前查看的）
  const [streamText, setStreamText] = useState('')
  const [streamModel, setStreamModel] = useState('')

  // 待发送的附件材料 [{filename, content, chars}]
  const [attachments, setAttachments] = useState([])
  const [refining, setRefining] = useState(false) // “优化指令”请求中
  const [queueCount, setQueueCount] = useState(0) // 排队中的需求条数

  // iframe 保活池：key=会话 id，切换会话只隐藏不卸载，游戏等应用的运行时进度得以保留
  const [previewMap, setPreviewMap] = useState({})
  const [previewOrder, setPreviewOrder] = useState([]) // LRU 顺序，最近使用在前
  const [reloadNonce, setReloadNonce] = useState({}) // 手动“刷新”时强制重挂某个 iframe

  // 主题：默认明亮，记忆在 localStorage
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  })

  // 三栏宽度：可拖拽调整并记忆
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readLayout('sidebarWidth', 240),
  )
  const [chatWidth, setChatWidth] = useState(() => readLayout('chatWidth', 416))
  const [resizing, setResizing] = useState('') // '' | 'sidebar' | 'chat'

  // 空会话推荐 prompt
  const [suggestions, setSuggestions] = useState([])
  const shownTitlesRef = useRef([])

  const bootedRef = useRef(false)
  const scrollRef = useRef(null)
  const fileInputRef = useRef(null)
  const taskIdRef = useRef('') // 当前生成任务 id（用于停止）
  const queueRef = useRef([]) // 排队的生成请求 [{sid, prompt, attachments, msgUid}]
  const activeSidRef = useRef('') // 用户当前正在查看的会话
  activeSidRef.current = sessionId

  useEffect(() => {
    try {
      localStorage.setItem(
        'layout',
        JSON.stringify({ sidebarWidth, chatWidth }),
      )
    } catch {
      /* 忽略 */
    }
  }, [sidebarWidth, chatWidth])

  // 拖拽分隔条。拖拽期间用全屏透明遮罩盖住 iframe，
  // 否则鼠标滑过 iframe 时 mousemove 会被 iframe 吞掉导致拖动中断。
  function beginResize(which, e) {
    e.preventDefault()
    const startX = e.clientX
    const startW = which === 'sidebar' ? sidebarWidth : chatWidth
    const min = which === 'sidebar' ? 200 : 320
    const hardMax = which === 'sidebar' ? 380 : 720
    // 保证另一栏与右栏仍有可用宽度
    const dynamicMax =
      which === 'sidebar'
        ? Math.min(hardMax, window.innerWidth - chatWidth - 420)
        : Math.min(hardMax, window.innerWidth - sidebarWidth - 360)
    const max = Math.max(min + 40, dynamicMax)

    setResizing(which)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev) => {
      const w = Math.min(max, Math.max(min, startW + ev.clientX - startX))
      if (which === 'sidebar') setSidebarWidth(w)
      else setChatWidth(w)
    }
    const onUp = () => {
      setResizing('')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem('theme', theme)
    } catch {
      /* 隐私模式下忽略 */
    }
  }, [theme])

  // 聊天区自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, isGenerating, streamText])

  // LRU 淘汰：previewOrder 更新后，移除超出上限的保活 iframe
  useEffect(() => {
    setPreviewMap((prev) => {
      let changed = false
      const next = { ...prev }
      for (const sid of Object.keys(next)) {
        if (!previewOrder.includes(sid)) {
          delete next[sid]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [previewOrder])

  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    boot()
  }, [])

  // 把会话 HTML 放入保活池（并置顶 LRU）
  function touchPreview(sid, html) {
    setPreviewMap((prev) => ({ ...prev, [sid]: html }))
    setPreviewOrder((prev) => [sid, ...prev.filter((x) => x !== sid)].slice(0, MAX_KEPT_PREVIEWS))
  }

  function dropPreview(sid) {
    setPreviewMap((prev) => {
      if (!(sid in prev)) return prev
      const next = { ...prev }
      delete next[sid]
      return next
    })
    setPreviewOrder((prev) => prev.filter((x) => x !== sid))
  }

  // 启动：拉取会话列表，取最近一个；没有则新建
  async function boot() {
    try {
      const list = await listSessions()
      setSessions(list)
      if (list.length > 0) {
        await loadSession(list[0].id, list)
      } else {
        await handleNewSession()
      }
    } catch (err) {
      setMessages([
        { role: 'error', text: err?.message || '初始化失败，请确认后端服务已启动（npm run dev:all）。' },
      ])
    }
  }

  async function refreshSessions() {
    try {
      const list = await listSessions()
      setSessions(list)
      return list
    } catch {
      /* 列表刷新失败不影响主流程 */
      return null
    }
  }

  // 根据历史会话标题推断使用习惯，刷新空会话推荐
  function refreshSuggestions(titlesArg, reset = false) {
    const titles = (titlesArg ?? sessions).map((s) => s.title).filter(Boolean)
    if (reset) shownTitlesRef.current = []
    const { items: picked, cycled } = pickRecommendations(
      titles,
      4,
      shownTitlesRef.current,
    )
    // 一轮展示完循环重来时，清空旧的已展示记录
    shownTitlesRef.current = cycled
      ? picked.map((p) => p.title)
      : [...shownTitlesRef.current, ...picked.map((p) => p.title)]
    setSuggestions(picked)
  }

  async function loadSession(id, listSessionsArg) {
    const s = await fetchSession(id)
    setSessionId(s.id)
    activeSidRef.current = s.id
    setMessages(
      s.messages.length
        ? s.messages.map((m) => ({
            role: m.role,
            text: m.text,
            mid: m.mid,
            attNames: m.attachments || undefined,
          }))
        : [],
    )
    if (s.currentHtml) touchPreview(s.id, s.currentHtml)
    // 查看即已读：左侧未读绿点消失
    markSessionRead(s.id)
    setSessions((prev) =>
      prev.some((x) => x.id === s.id && x.unread)
        ? prev.map((x) => (x.id === s.id ? { ...x, unread: false } : x))
        : prev,
    )
    if (!s.messages.length) refreshSuggestions(listSessionsArg ?? undefined, true)
  }

  async function handleNewSession() {
    try {
      const s = await createSessionApi()
      setSessionId(s.id)
      activeSidRef.current = s.id
      setMessages([])
      setAttachments([])
      const list = await refreshSessions()
      refreshSuggestions(list ?? undefined, true)
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'error', text: err?.message || '新建会话失败。' }])
    }
  }

  async function handleDeleteSession(id) {
    if (!window.confirm('确定删除该会话？删除后不可恢复。')) return
    try {
      await deleteSessionApi(id)
      dropPreview(id)
      const rest = sessions.filter((s) => s.id !== id)
      setSessions(rest)
      if (id === sessionId) {
        if (rest.length > 0) await loadSession(rest[0].id)
        else await handleNewSession()
      }
    } catch (err) {
      alert(err?.message || '删除失败。')
    }
  }

  // 导出会话为 Markdown（含完整对话与每版应用代码）
  async function handleExportSession(id) {
    let s
    try {
      s = await fetchSession(id)
    } catch (err) {
      alert(err?.message || '导出失败：无法读取会话。')
      return
    }
    const lines = [`# ${s.title}`, '', `> 导出时间：${new Date().toLocaleString()}`, '']
    if (!s.messages.length) lines.push('（空会话）', '')
    for (const m of s.messages) {
      lines.push(`## ${m.role === 'user' ? '用户' : '助手'}`)
      lines.push('')
      lines.push(m.text || '')
      if (m.html) {
        lines.push('', '```html', m.html, '```')
      }
      lines.push('')
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const safeName = (s.title || 'session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)
    a.href = url
    a.download = `${safeName}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ---------- 文件上传 ----------
  async function handleFilePick(fileList) {
    const picked = Array.from(fileList || [])
    if (picked.length === 0) return
    try {
      // 浏览器端读取为文本（零额外依赖）
      const readOne = (file) =>
        new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () =>
            resolve({ filename: file.name, content: String(reader.result || '') })
          reader.onerror = () => reject(new Error(`读取文件 “${file.name}” 失败。`))
          reader.readAsText(file)
        })
      const files = await Promise.all(picked.map(readOne))
      await uploadFiles(files) // 后端校验类型与大小，失败会抛中文错误
      setAttachments((prev) => {
        const map = new Map(prev.map((a) => [a.filename, a]))
        for (const f of files) map.set(f.filename, { ...f, chars: f.content.length })
        return [...map.values()].slice(0, 5)
      })
    } catch (err) {
      alert(err?.message || '文件上传失败。')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function removeAttachment(name) {
    setAttachments((prev) => prev.filter((a) => a.filename !== name))
  }

  // ---------- 优化指令：把简单想法扩写为详细需求，回填到输入框供用户编辑 ----------
  async function handleRefine() {
    if (refining) return
    const text = input.trim()
    // 没有输入时：让 AI 结合当前会话与历史帮用户想一个合适的指令
    const seed =
      text ||
      '请帮我想一个实用又有趣的网页应用创意，直接给出它的详细生成指令。'
    setRefining(true)
    try {
      const refined = await refinePrompt(seed)
      setInput(refined)
    } catch (err) {
      alert(err?.message || '指令优化失败。')
    } finally {
      setRefining(false)
    }
  }

  // 发送：生成中则排队，否则立即执行
  function handleGenerate(presetPrompt) {
    if (!sessionId) {
      setMessages((prev) => [...prev, { role: 'error', text: '会话尚未初始化完成，请稍候再试。' }])
      return
    }
    const raw = (presetPrompt ?? input)
    if (!raw.trim()) return
    const prompt = raw.trim()
    const atts = attachments
    const msgUid = uid()
    const attNames = atts.map((a) => a.filename)

    // 无意义输入（乱码/纯数字/纯emoji等）：用户消息照常上屏，
    // 但不触发生成，由 assistant 回复引导用户说清需求
    if (isMeaningless(prompt) && !atts.length) {
      setMessages((prev) => [
        ...prev,
        { uid: msgUid, role: 'user', text: prompt, attNames },
        {
          uid: uid(),
          role: 'assistant',
          text: '我好像没有理解您的意思。能具体描述一下您想要什么应用吗？比如「做一个贪吃蛇游戏」「帮我做一个生日祝福页面」，描述越具体，生成效果越好。',
        },
      ])
      setInput('')
      setAttachments([])
      return
    }

    // 用户消息立即上屏；生成中发送的先标记为“排队中”
    setMessages((prev) => [
      ...prev,
      { uid: msgUid, role: 'user', text: prompt, pending: isGenerating, attNames },
    ])
    setInput('')
    setAttachments([])

    const item = { sid: sessionId, prompt, attachments: atts, msgUid }
    if (isGenerating) {
      queueRef.current.push(item)
      setQueueCount(queueRef.current.length)
    } else {
      runGeneration(item)
    }
  }

  async function runGeneration(item) {
    setIsGenerating(true)
    setGeneratingSid(item.sid)
    setStreamText('')
    setStreamModel('')
    taskIdRef.current = ''

    // 排队消息转入执行态（仅当它在当前视图中）
    setMessages((prev) =>
      prev.some((m) => m.uid === item.msgUid && m.pending)
        ? prev.map((m) => (m.uid === item.msgUid ? { ...m, pending: false } : m))
        : prev,
    )

    try {
      const result = await generateAppStream({
        sessionId: item.sid,
        prompt: item.prompt,
        attachments: item.attachments,
        onMeta: (m) => {
          taskIdRef.current = m.taskId || ''
          setStreamModel(m.model || '')
        },
        onDelta: (t) => setStreamText((prev) => prev + t),
      })

      if (result.partial) {
        // 用户中途停止：右侧展示已生成的部分成果（临时，不入历史），并告知实现进度
        touchPreview(item.sid, result.html)
        if (activeSidRef.current === item.sid) {
          const progress = result.closed
            ? `已停止生成（已产出约 ${result.chars} 字符，代码结构基本完整）。右侧展示的是当前成果，可直接继续发送需求让我在此基础上补全或调整。`
            : `已停止生成（已产出约 ${result.chars} 字符，应用尚未完全生成）。右侧为部分成果，页面可能不完整，继续发送需求即可让我补全。`
          setMessages((prev) => [...prev, { role: 'assistant', text: progress }])
        }
      } else {
        touchPreview(item.sid, result.html)
        if (activeSidRef.current === item.sid) {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', text: result.message?.text || '生成完成！', mid: result.message?.mid },
          ])
        }
        // 用户仍停留在该会话 → 直接已读；否则保留未读绿点，等切回时清除
        if (activeSidRef.current === item.sid) {
          markSessionRead(item.sid)
        }
        await refreshSessions()
        if (activeSidRef.current === item.sid) {
          setSessions((prev) =>
            prev.map((x) => (x.id === item.sid ? { ...x, unread: false } : x)),
          )
        }
      }
    } catch (err) {
      if (activeSidRef.current === item.sid) {
        setMessages((prev) => [
          ...prev,
          { role: 'error', text: err?.message || '生成失败，请稍后重试。' },
        ])
      }
      await refreshSessions()
    } finally {
      taskIdRef.current = ''
      setStreamText('')
      // 执行队列中的下一条
      const next = queueRef.current.shift()
      setQueueCount(queueRef.current.length)
      if (next) {
        runGeneration(next)
      } else {
        setIsGenerating(false)
        setGeneratingSid('')
      }
    }
  }

  // 停止当前生成（不影响排队中的后续需求）
  function handleStop() {
    if (taskIdRef.current) stopGeneration(taskIdRef.current)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!input.trim() && !attachments.length) return
      handleGenerate()
    }
  }

  async function handleDownload() {
    // 以下载服务端已保存的完整版本为准，避免下到中途停止的半成品
    let html = previewMap[sessionId]
    let name = `app-${sessionId.slice(0, 8)}`
    try {
      const s = await fetchSession(sessionId)
      if (s.currentHtml) html = s.currentHtml
      if (s.title) name = s.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 30)
    } catch {
      // 拉取失败时退回到当前预览内容
    }
    if (!html) return
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleOpenInNewTab() {
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.mid)
    if (sessionId && last?.mid) window.open(`/apps/${sessionId}/${last.mid}`, '_blank')
  }

  const currentHtml = previewMap[sessionId] || ''
  const currentTitle = sessions.find((s) => s.id === sessionId)?.title || '新的会话'
  // 空会话（无消息且当前会话没有生成任务）时展示推荐
  const isEmpty = messages.length === 0 && generatingSid !== sessionId
  // 流式气泡/遮罩只在生成任务所属会话显示
  const showStreaming = isGenerating && generatingSid === sessionId

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-appbg">
      {/* ============ 左栏：会话导航 ============ */}
      <aside
        style={{ width: sidebarWidth }}
        className="flex flex-col shrink-0 bg-sidebar"
      >
        {/* 品牌 + 主题切换 */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-brand shadow-sm" />
            <span className="text-ink font-semibold text-[13px]">AI 应用构建器</span>
          </div>
          <button
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? '切换到明亮主题' : '切换到暗色主题'}
            className="p-1.5 rounded-lg text-dim hover:text-brand hover:bg-inset transition-colors"
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </div>

        {/* 新建会话：显眼主按钮 */}
        <div className="px-3 pb-2">
          <button
            onClick={handleNewSession}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-brand hover:bg-brandHover text-white text-sm font-medium shadow-sm transition-colors"
          >
            <IconPlus />
            新建会话
          </button>
        </div>

        <div className="px-4 pt-2 pb-1 text-[11px] font-medium text-dim">
          会话历史（{sessions.length}）
        </div>

        {/* 会话列表（常驻） */}
        <div className="flex-1 overflow-y-auto scroll-thin px-2 pb-2">
          {sessions.length === 0 && (
            <p className="text-xs text-dim text-center mt-6 px-2">还没有会话，点击上方按钮开始</p>
          )}
          {sessions.map((s) => {
            const active = s.id === sessionId
            return (
              <div
                key={s.id}
                onClick={() => loadSession(s.id)}
                className={`group relative flex items-center gap-2 px-2.5 py-2 mb-0.5 rounded-lg cursor-pointer transition-colors ${
                  active ? 'bg-brandSoft' : 'hover:bg-inset'
                }`}
              >
                {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 rounded-r bg-brand" />}
                <div className="min-w-0 flex-1 pl-1">
                  <div className="flex items-center gap-1.5">
                    {s.unread && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="有新生成的应用，点击查看" />
                    )}
                    <span className={`text-[13px] truncate ${active ? 'text-brand font-medium' : 'text-ink'}`}>
                      {s.title}
                    </span>
                  </div>
                  <div className="text-[10px] text-dim mt-0.5">
                    {formatTime(s.updatedAt)} · {s.messageCount} 条消息
                  </div>
                </div>
                {/* 悬浮操作：导出 / 删除 */}
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleExportSession(s.id)
                    }}
                    title="导出会话（Markdown）"
                    className="p-1 rounded-md text-dim hover:text-brand hover:bg-panel"
                  >
                    <IconExport />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteSession(s.id)
                    }}
                    title="删除会话"
                    className="p-1 rounded-md text-dim hover:text-danger hover:bg-panel"
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <footer className="border-t border-line px-4 py-2.5 text-[10px] text-dim">
          deepseek-chat · v0.8.0
        </footer>
      </aside>

      <ColumnResizer
        active={resizing === 'sidebar'}
        onMouseDown={(e) => beginResize('sidebar', e)}
      />

      {/* ============ 中栏：聊天区 ============ */}
      <section
        style={{ width: chatWidth }}
        className="flex flex-col shrink-0 bg-panel"
      >
        <header className="flex items-center justify-between px-5 h-12 border-b border-line">
          <span className="text-sm font-medium text-ink truncate">{currentTitle}</span>
          <span className="text-[11px] text-dim shrink-0 ml-2">会话自动保存</span>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-5 py-5">
          {isEmpty ? (
            <WelcomePanel
              suggestions={suggestions}
              onPick={(p) => setInput(p)}
              onRefresh={() => refreshSuggestions(undefined, false)}
            />
          ) : (
            <>
              {messages.map((msg) => (
                <MessageBubble key={msg.uid || msg.mid || `${msg.role}-${msg.text.slice(0, 8)}`} msg={msg} />
              ))}
              {showStreaming && <StreamingBubble text={streamText} model={streamModel} />}
              {showStreaming && queueCount > 0 && (
                <div className="text-[11px] text-dim mb-3 ml-1">
                  还有 {queueCount} 条需求排队中，将在当前生成完成后自动执行
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t border-line p-3.5 bg-panel">
          {/* 已选附件材料 */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachments.map((a) => (
                <span
                  key={a.filename}
                  className="inline-flex items-center gap-1.5 text-[11px] bg-brandSoft text-ink border border-line rounded-lg pl-2 pr-1 py-1"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-brand shrink-0">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  <span className="max-w-[140px] truncate">{a.filename}</span>
                  <span className="text-dim">{a.chars} 字符</span>
                  <button
                    onClick={() => removeAttachment(a.filename)}
                    title="移除附件"
                    className="ml-0.5 p-0.5 rounded text-dim hover:text-danger"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="描述你想生成的应用…（Enter 发送，Shift+Enter 换行）"
            rows={3}
            className="w-full resize-y min-h-[76px] max-h-[33vh] bg-inset border border-line focus:border-brand focus:ring-2 focus:ring-brand/15 rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-dim/80 outline-none scroll-thin transition-colors"
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.markdown,.json,.csv,.html,.htm,.css,.js,.jsx,.ts,.tsx,.xml,.yml,.yaml,.log,.py,.java,.c,.cpp,.h,.go,.rs,.vue,.sql,.ini,.conf,.env,.text,text/plain"
            className="hidden"
            onChange={(e) => handleFilePick(e.target.files)}
          />
          <div className="flex items-center justify-between mt-2.5">
            {/* 左下：上传材料 + 优化指令 */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => fileInputRef.current?.click()}
                title="上传文本材料（.txt / .md / .json / .csv / 代码等），AI 会基于材料内容生成应用"
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-dim border border-line hover:text-brand hover:border-brand/40 hover:bg-brandSoft transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                上传材料
              </button>
              <button
                onClick={handleRefine}
                disabled={refining}
                title="有输入时：扩写为详细指令；无输入时：帮你想一个应用创意"
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] border transition-colors ${
                  refining
                    ? 'border-line text-dim/50 cursor-not-allowed'
                    : 'text-dim border-line hover:text-brand hover:border-brand/40 hover:bg-brandSoft'
                }`}
              >
                {refining ? (
                  <span className="w-3 h-3 rounded-full border-2 border-brand/30 border-t-brand animate-spin" />
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
                    <path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
                  </svg>
                )}
                {refining ? '优化中…' : '优化指令'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              {isGenerating && (
                <button
                  onClick={handleStop}
                  className="px-3.5 py-1.5 rounded-lg text-sm border border-line text-dim hover:bg-inset transition-colors"
                >
                  停止
                </button>
              )}
              <button
                onClick={() => handleGenerate()}
                disabled={!input.trim() && !attachments.length}
                className="px-5 py-1.5 rounded-lg text-sm font-medium bg-brand text-white hover:bg-brandHover disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-brand shadow-sm transition-colors"
              >
                {isGenerating ? '加入队列' : '生成应用'}
              </button>
            </div>
          </div>
        </div>
      </section>

      <ColumnResizer
        active={resizing === 'chat'}
        onMouseDown={(e) => beginResize('chat', e)}
      />

      {/* ============ 右栏：预览区 ============ */}
      <main className="flex flex-col flex-1 min-w-0 bg-appbg border-l border-line">
        <header className="flex items-center justify-between px-5 h-12 border-b border-line bg-panel">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">预览</span>
          </div>
          <div className="flex items-center gap-2">
            {currentHtml ? (
              <span className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                应用已加载
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] text-dim">
                <span className="w-1.5 h-1.5 rounded-full bg-dim" />
                等待生成
              </span>
            )}
            <PreviewButton disabled={!currentHtml} onClick={() => setReloadNonce((p) => ({ ...p, [sessionId]: (p[sessionId] || 0) + 1 }))} title="刷新当前预览">
              <IconRefresh />
              刷新
            </PreviewButton>
            <PreviewButton disabled={!currentHtml} onClick={handleDownload} title="下载当前应用 HTML">
              <IconDownload />
              下载
            </PreviewButton>
            <PreviewButton disabled={!currentHtml} onClick={handleOpenInNewTab} title="在新标签页独立打开">
              <IconExternal />
              新窗口
            </PreviewButton>
          </div>
        </header>

        <div className="flex-1 relative bg-white">
          {/* 保活 iframe 池：隐藏的 iframe 不卸载，应用内部状态（如 2048 分数）继续保留 */}
          {previewOrder.map((sid) => {
            const html = previewMap[sid]
            if (!html) return null
            return (
              <iframe
                key={`${sid}:${reloadNonce[sid] || 0}`}
                title={`app-preview-${sid}`}
                srcDoc={html}
                sandbox="allow-scripts allow-modals allow-same-origin allow-popups allow-forms allow-pointer-lock allow-touch-events"
                className={`absolute inset-0 w-full h-full border-0 bg-white ${
                  sid === sessionId ? 'block' : 'hidden'
                }`}
              />
            )
          })}

          {/* 空状态 */}
          {!currentHtml && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-appbg text-dim">
              <div className="w-16 h-16 rounded-2xl bg-brandSoft flex items-center justify-center mb-4">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-brand">
                  <rect x="3" y="4" width="18" height="14" rx="2" />
                  <path d="M3 9h18M8 4v5" />
                </svg>
              </div>
              <p className="text-sm font-medium text-ink">还没有生成应用</p>
              <p className="text-xs text-dim mt-1">在中间输入框描述需求，生成结果将在这里实时预览</p>
            </div>
          )}

          {/* 生成中遮罩：明确告知预览即将更新，同时不打断旧应用的运行状态 */}
          {showStreaming && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-appbg/85 backdrop-blur-[2px]">
              <span className="w-10 h-10 rounded-full border-[3px] border-brand/25 border-t-brand animate-spin" />
              <p className="text-sm font-medium text-ink">正在生成新应用…</p>
              <p className="text-xs text-dim">完成后自动替换此处预览{currentHtml ? '，当前应用进度已保留' : ''}</p>
              {queueCount > 0 && (
                <p className="text-[11px] text-dim">另有 {queueCount} 条需求排队等待中</p>
              )}
            </div>
          )}
        </div>
      </main>

      {/* 拖拽栏宽时的全屏遮罩：拦截事件，防止 iframe 吞掉 mousemove */}
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  )
}

function PreviewButton({ children, onClick, disabled, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${
        disabled
          ? 'border-line text-dim opacity-50 cursor-not-allowed'
          : 'border-line text-dim hover:text-brand hover:border-brand/40 hover:bg-brandSoft'
      }`}
    >
      {children}
    </button>
  )
}
