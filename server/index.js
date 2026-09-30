// 后端服务：DeepSeek 代理（SSE 流式）+ 会话持久化 + 生产模式静态托管。
// 开发：npm run server（3001，前端走 Vite 代理）
// 生产：npm run build 后 npm start（单服务同时托管 dist 与 /api）
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import {
  listSessions,
  getSession,
  createSession,
  deleteSession,
  addMessage,
  setSessionApp,
  markRead,
  newId,
} from './store.js'

// 无论从哪个工作目录启动，都能正确加载项目根目录的 .env
const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const app = express()

// 开发环境下前端走 Vite 代理（同源），cors 仅为直接访问后端时兜底
app.use(cors())
// 附件以文本形式随请求体上传，放宽到 6mb
app.use(express.json({ limit: '6mb' }))

const PORT = process.env.PORT || 3001
const DIST_DIR = path.resolve(__dirname, '..', 'dist')
const DEEPSEEK_API_URL =
  process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions'
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const IDLE_TIMEOUT = 120_000 // 流式：相邻数据块之间的最大等待时间

// ---------- Mock 演示模式 ----------
// 设 MOCK_MODE=true 时，所有 /api/generate 请求不走 DeepSeek，
// 从预置的已验证产物中按关键词匹配返回，模拟 SSE 流式输出。
// 部署演示环境零 API 成本、永不失败；关闭后恢复正常 AI 调用。
const MOCK_MODE = process.env.MOCK_MODE === 'true'
// 显式设置 MOCK_MODE=true，或未配置 API Key（线上演示环境）时，自动进入演示模式
const MOCK_ACTIVE = MOCK_MODE || !process.env.DEEPSEEK_API_KEY
const MOCK_DIR = path.resolve(__dirname, 'mock-products')

// 关键词 -> 预置文件名（mock-products 目录下）
const MOCK_KEYWORDS = [
  { patterns: /贪吃蛇|snake|贪食蛇/i, file: 'snake.html', label: '贪吃蛇游戏' },
  { patterns: /2048/i, file: '2048.html', label: '2048 游戏' },
  { patterns: /俄罗斯方块|tetris|方块消除/i, file: 'tetris.html', label: '俄罗斯方块' },
]
// 兜底产物：当用户输入匹配不到任何预置关键词时，返回通用应用
const MOCK_FALLBACK = 'tetris.html'

// 模拟流式输出：把完整文本按 ~80 字符切块、每 30ms 发一个 delta
function streamMockHtml(res, send, html) {
  return new Promise((resolve) => {
    const chunkSize = 80
    let offset = 0
    const timer = setInterval(() => {
      const chunk = html.slice(offset, offset + chunkSize)
      if (!chunk) {
        clearInterval(timer)
        resolve()
        return
      }
      offset += chunkSize
      send({ type: 'delta', text: chunk })
    }, 30)
  })
}

function loadMockProduct(fileName) {
  try {
    return fs.readFileSync(path.join(MOCK_DIR, fileName), 'utf-8')
  } catch {
    return null
  }
}

function matchMockProduct(prompt) {
  for (const m of MOCK_KEYWORDS) {
    if (m.patterns.test(prompt)) return { file: m.file, label: m.label }
  }
  return { file: MOCK_FALLBACK, label: '示例应用' }
}

const SYSTEM_PROMPT = [
  '你是一个 Web 应用生成器。请根据用户的自然语言需求，生成一个完整、可直接运行的 HTML 文件。',
  '要求：',
  '1. 所有 HTML/CSS/JS 都写在一个文件里，不要依赖外部本地文件，必须能在 iframe 中直接运行；',
  '2. 只返回纯 HTML 代码，不要用 markdown 包裹，代码外不要写任何说明文字；',
  '3. UI 必须美观、现代、协调：统一的配色体系、清晰的留白与层级、合适的圆角和字体；',
  '4. 如果应用需要介绍、玩法规则等说明内容，必须用页面内样式化的组件呈现（如标题、卡片、列表），',
  '   严禁把 markdown 源码符号（#、**、```、- 列表符等）直接显示在页面上；',
  '5. 默认视觉风格必须是明亮、温和、清新的浅色配色：白色或暖白背景（如 #ffffff / #faf7f2 / #faf6f0）、',
  '   浅灰边框、暖橙色系强调色（如 #d97706 / #f59e0b / #fb923c），与暖色调平台保持协调；',
  '   不要使用深色、暗色背景和霓虹荧光配色——除非用户明确要求恐怖、惊悚、悬疑、暗黑等严肃题材；',
  '6. 游戏或工具类应用的介绍、规则、操作说明等帮助信息，不要堆在页面底部（用户很难看到），',
  '   应在界面顶部放置“介绍”“规则”“玩法”等小按钮，用户点击后弹出居中的模态浮层展示，',
  '   浮层同样采用浅色风格，可点击遮罩或关闭按钮关闭；',
  '7. 如果用户提供了参考材料（文件内容/数据），必须基于材料中的真实信息生成，',
  '   例如数据展示类应用要使用材料里的数据，不要凭空编造与材料冲突的内容；',
  '8. 所有游戏类应用必须提供完整的控制按钮，且每个按钮都绑定真实可用的事件：',
  '   “开始游戏”（从初始状态开始并进入运行）、“暂停游戏”（运行中可点，停止计时/循环）、',
  '   “继续游戏”（暂停后恢复，不重置进度）、“新一局”（重置后立即重新开始）。',
  '   按明确的状态机实现：未开始→运行中→已暂停→（继续）运行中→结束；按钮在不适用的状态下应禁用，',
  '   不能出现点击无反应的按钮。游戏初次打开时显示开始遮罩，不要自动开始；',
  '9. 代码必须健壮：访问 localStorage/sessionStorage 等浏览器 API 时一律用 try/catch 包裹并提供内存兜底，',
  '   确保在禁用存储的沙箱环境中所有功能（含最高分记录）也不会报错；脚本放在页面元素之后或用 DOMContentLoaded 包裹，',
  '   交付前自查所有按钮点击、键盘/触摸操作和帮助弹窗都能正常工作。',
  '10. 输出篇幅控制：代码保持精炼，删除大段冗余注释和重复样式，CSS/JS 适度紧凑，优先用简洁实现，避免输出超长文档。',
].join('\n')

// “优化指令”功能使用的提示词：把用户的简单想法扩写为具体可执行的生成指令
const REFINE_PROMPT = [
  '你是一个产品需求助手。用户对想生成的 Web 应用只有一个简单想法，请把它扩写成一段清晰、具体、可执行的生成指令。',
  '要求：',
  '1. 保持用户原意，只做合理补充，不要添加用户没提到的复杂功能；',
  '2. 补充核心功能、交互方式、关键界面元素；界面风格默认采用明亮温暖的浅色配色（白底/暖白 + 暖橙点缀）；',
  '3. 100~300 字，分条或连贯描述均可；',
  '4. 只输出扩写后的需求正文，不要寒暄、不要标题、不要用 markdown 代码块包裹。',
].join('\n')

// 允许上传的文本类文件扩展名（零额外依赖，浏览器端 FileReader 读取为文本后传入）
const UPLOAD_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'html', 'htm', 'css', 'js', 'jsx',
  'ts', 'tsx', 'xml', 'yml', 'yaml', 'log', 'py', 'java', 'c', 'cpp', 'h',
  'go', 'rs', 'vue', 'sql', 'ini', 'conf', 'env', 'text',
])
const MAX_FILE_CHARS = 200_000 // 单个文件约 20 万字符
const MAX_FILES_PER_REQUEST = 5

// ---------- 会话管理 API ----------
// 访客标识：前端 localStorage 生成并随请求头携带，
// 不同浏览器（访客）只能看到自己的会话，互不可见
function getOwnerId(req) {
  const id = String(req.get('x-owner-id') || '').trim()
  return id.slice(0, 64) || null
}

app.get('/api/sessions', (req, res) => {
  res.json({ sessions: listSessions(getOwnerId(req)) })
})

app.post('/api/sessions', (req, res) => {
  res.status(201).json(createSession(getOwnerId(req)))
})

app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id)
  if (!session) return res.status(404).json({ error: '会话不存在或已被删除。' })
  res.json(session)
})

app.delete('/api/sessions/:id', (req, res) => {
  const ok = deleteSession(req.params.id)
  if (!ok) return res.status(404).json({ error: '会话不存在或已被删除。' })
  res.json({ ok: true })
})

// 标记会话已读（用户打开查看后，左侧小绿点消失）
app.post('/api/sessions/:id/read', (req, res) => {
  if (!markRead(req.params.id)) {
    return res.status(404).json({ error: '会话不存在或已被删除。' })
  }
  res.json({ ok: true })
})

// ---------- 文件上传（文本类材料） ----------
// 浏览器端把文件读取为文本后 POST 到这里校验；内容在后续 /api/generate 时随请求一起发送。
app.post('/api/upload', (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : null
  if (!files || files.length === 0) {
    return res.status(400).json({ error: '没有收到文件。' })
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return res.status(400).json({ error: `一次最多上传 ${MAX_FILES_PER_REQUEST} 个文件。` })
  }

  const accepted = []
  for (const f of files) {
    const filename = typeof f?.filename === 'string' ? f.filename.trim() : ''
    const content = typeof f?.content === 'string' ? f.content : null
    if (!filename || content === null) {
      return res.status(400).json({ error: '文件信息不完整（缺少文件名或内容）。' })
    }
    const ext = (filename.split('.').pop() || '').toLowerCase()
    if (!UPLOAD_EXTENSIONS.has(ext)) {
      return res.status(415).json({
        error:
          `暂不支持 “${filename}” 这类文件。目前支持文本类文件（如 .txt / .md / .json / .csv / .html / .js / .py 等）；` +
          '图片、Word、Excel、PDF 等二进制文件请先另存为文本后上传。',
      })
    }
    if (content.length > MAX_FILE_CHARS) {
      return res.status(413).json({
        error: `文件 “${filename}” 过大（${content.length} 字符），单个文件不能超过 ${MAX_FILE_CHARS} 字符。`,
      })
    }
    accepted.push({
      filename,
      chars: content.length,
      preview: content.slice(0, 160),
    })
  }
  res.json({ ok: true, files: accepted })
})

// ---------- 优化指令：把简单想法扩写为详细生成指令 ----------
app.post('/api/refine-prompt', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  if (!prompt) return res.status(400).json({ error: '请先输入你的初步想法。' })

  const apiKey = process.env.DEEPSEEK_API_KEY

  // 演示模式：本地模板扩写，不调用外部 API，保证线上功能闭环
  if (!apiKey || MOCK_ACTIVE) {
    const refined =
      `请为我生成一个网页应用：${prompt}。` +
      '要求：所有代码整合在单个 HTML 文件中，可直接在浏览器运行；' +
      '界面采用明亮的浅色配色（暖白背景、暖橙色强调色），布局清晰、有适当留白和圆角；' +
      '提供完整可用的核心交互功能，操作反馈及时；' +
      '如包含规则或使用说明，用页面内的样式化组件展示。'
    return res.json({ refined })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  let upstream
  try {
    upstream = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: REFINE_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.6,
        max_tokens: 900,
        stream: false,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    return res.status(502).json({
      error:
        err.name === 'AbortError'
          ? '指令优化超时，请稍后重试或直接生成。'
          : `无法连接 DeepSeek API：${err.message}`,
    })
  }
  clearTimeout(timer)

  const data = await upstream.json().catch(() => null)
  if (!upstream.ok) {
    const detail = data?.error?.message || data?.message || '上游返回错误。'
    return res.status(502).json({ error: `指令优化失败：${detail}` })
  }
  const refined = (data?.choices?.[0]?.message?.content || '').trim()
  if (!refined) return res.status(502).json({ error: '模型返回为空，请重试。' })
  res.json({ refined })
})

// 健康检查：只返回状态，不泄露 Key
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: DEEPSEEK_MODEL,
    keyConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
    mockMode: MOCK_ACTIVE,
  })
})

// 正在进行的生成任务：taskId -> { stoppedByUser, abort }
// 用户点“停止”时不关闭 SSE 连接，而是调 /stop 让后端中止上游后把部分成果回传。
const runningTasks = new Map()

app.post('/api/generate/:taskId/stop', (req, res) => {
  const task = runningTasks.get(req.params.taskId)
  if (!task) return res.status(404).json({ error: '任务不存在或已结束。' })
  task.stoppedByUser = true
  task.abort()
  res.json({ ok: true })
})

// ---------- 生成接口（SSE 流式，支持多轮迭代 + 附件材料） ----------
app.post('/api/generate', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : ''
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : ''
  const attachments = Array.isArray(req.body?.attachments)
    ? req.body.attachments.filter(
        (a) => a && typeof a.filename === 'string' && typeof a.content === 'string',
      )
    : []

  if (!prompt) {
    return res.status(400).json({ error: '请求体缺少 prompt 参数（用户需求不能为空）。' })
  }
  if (attachments.length > MAX_FILES_PER_REQUEST) {
    return res.status(400).json({ error: `一次最多附带 ${MAX_FILES_PER_REQUEST} 个文件。` })
  }

  const apiKey = process.env.DEEPSEEK_API_KEY
  // 演示模式下不需要 API Key（未配置时自动降级为演示模式）
  if (!apiKey && !MOCK_ACTIVE) {
    return res
      .status(500)
      .json({ error: '服务器未配置 DEEPSEEK_API_KEY，请在项目根目录 .env 中设置后重启后端。' })
  }

  let session = sessionId ? getSession(sessionId) : null
  if (sessionId && !session) {
    return res.status(404).json({ error: '会话不存在或已被删除，请刷新页面后重试。' })
  }
  if (!session) session = createSession(getOwnerId(req))

  // 组装送给模型的用户内容：附件材料 + 多轮上下文 + 本轮需求
  let userContent = prompt
  const materialBlocks = attachments
    .slice(0, MAX_FILES_PER_REQUEST)
    .map((a, i) => `===== 参考材料 ${i + 1}：${a.filename}（${a.content.length} 字符）=====\n${a.content}`)
  if (session.currentHtml) {
    userContent =
      `当前应用 HTML：\n\`\`\`html\n${session.currentHtml}\n\`\`\`\n\n` +
      (materialBlocks.length
        ? `${materialBlocks.join('\n\n')}\n\n=====\n用户修改需求：${prompt}`
        : `用户修改需求：${prompt}`) +
      `\n\n请基于以上应用进行修改，输出修改后的完整 HTML。`
  } else if (materialBlocks.length) {
    userContent =
      '用户提供了以下参考材料，请充分利用材料中的真实数据和内容来生成应用，不要编造与材料冲突的信息：\n\n' +
      `${materialBlocks.join('\n\n')}\n\n=====\n用户需求：${prompt}`
  }

  // 先落库用户消息（即使生成失败，提问记录也保留）
  addMessage(session.id, {
    mid: newId(),
    role: 'user',
    text: prompt,
    attachments: attachments.map((a) => a.filename),
    ts: Date.now(),
  })

  // SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (obj) => {
    if (res.writableEnded) return
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* 连接已断开，忽略 */
    }
  }

  const taskId = newId()
  send({ type: 'meta', model: DEEPSEEK_MODEL, sessionId: session.id, taskId })

  // ---------- Mock 演示模式 ----------
  if (MOCK_ACTIVE) {
    const matched = matchMockProduct(prompt)
    const html = loadMockProduct(matched.file)
    if (!html) {
      send({ type: 'error', error: '演示环境暂不支持该应用，请尝试：贪吃蛇 / 2048 / 俄罗斯方块 / 个人主页 / 菜单' })
      res.end()
      return
    }
    send({ type: 'notice', text: `正在生成「${matched.label}」…` })
    await streamMockHtml(res, send, html)
    const assistantMsg = {
      mid: newId(),
      role: 'assistant',
      text: `已生成应用（${html.length} 字符），可在右侧预览或通过"新窗口"独立打开。`,
      html,
      model: 'mock',
      ts: Date.now(),
    }
    addMessage(session.id, assistantMsg)
    setSessionApp(session.id, html)
    send({
      type: 'done',
      html,
      model: 'mock',
      message: { mid: assistantMsg.mid, text: assistantMsg.text },
      session: getSession(session.id),
    })
    res.end()
    return
  }

  const controller = new AbortController()
  let clientGone = false
  runningTasks.set(taskId, { stoppedByUser: false, abort: () => controller.abort() })
  // 注意：必须用 res 的 close 检测客户端断开。
  // Node 20 中 req 的 close 在请求体被 express.json 读完后就会触发，
  // 会误判为客户端离开而中止上游请求。
  res.on('close', () => {
    clientGone = true
    controller.abort()
  })

  // 空闲超时：连接阶段即生效（覆盖 DeepSeek 长时间无响应），之后每个数据块重置
  let idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT)
  const resetIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT)
  }

  // 单轮上游调用：流式转发 delta，返回本轮完整文本与结束原因
  const callUpstream = async (messages) => {
    let resp
    try {
      resp = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages,
          temperature: 0.7,
          max_tokens: 8192,
          stream: true,
        }),
        signal: controller.signal,
      })
    } catch (err) {
      return { connError: err }
    }

    if (!resp.ok) {
      const data = await resp.json().catch(() => null)
      const detail = data?.error?.message || data?.message || '上游接口返回了非预期的错误。'
      const statusMap = {
        400: `DeepSeek 拒绝了请求（400），可能是上下文过长（附件太大）。详情：${detail}`,
        401: `DeepSeek 鉴权失败（401）：API Key 无效或已过期。详情：${detail}`,
        402: `DeepSeek 账户余额不足（402），请充值后重试。详情：${detail}`,
        404: `DeepSeek 接口或模型不存在（404）。详情：${detail}`,
        429: `请求 DeepSeek 过于频繁或额度不足（429）。详情：${detail}`,
      }
      return {
        httpError:
          statusMap[resp.status] ||
          `DeepSeek 返回错误（HTTP ${resp.status}）。详情：${detail}`,
      }
    }

    let text = ''
    let finishReason = null
    let model = DEEPSEEK_MODEL
    const r = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    resetIdle()
    let err = null
    try {
      for (;;) {
        const { done, value } = await r.read()
        if (done) break
        resetIdle()
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          let json
          try {
            json = JSON.parse(payload)
          } catch {
            continue
          }
          if (json.model) model = json.model
          const choice = json.choices?.[0]
          if (choice?.finish_reason) finishReason = choice.finish_reason
          const delta = choice?.delta?.content
          if (delta) {
            text += delta
            send({ type: 'delta', text: delta })
          }
        }
      }
    } catch (e) {
      err = e
    }
    return { text, finishReason, model, readError: err }
  }

  // ---------- 主流程：首轮 + 长度截断自动续写 ----------
  const MAX_CONTINUE = 2 // 最多续写 2 次（累计最多约 3 段 8192 tokens）
  const CONTINUE_HINT =
    '上一段输出因长度限制被截断。请严格从截断处继续输出剩余的 HTML 代码：' +
    '不要重复任何已经输出过的内容，不要输出解释说明，直接续写代码本身，直到整个 HTML 文档完整结束（以 </html> 收尾）。' +
    '特别注意：如果截断点恰好停在字符串、括号或语句中间，必须先把它正确闭合再继续，保证拼接处的 JavaScript 语法完全合法。'

  const convo = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ]
  let full = ''
  let upstreamModel = DEEPSEEK_MODEL
  let readError = null
  let fatalError = null

  for (let round = 0; round <= MAX_CONTINUE; round++) {
    const r = await callUpstream(convo)
    if (r.connError) {
      clearTimeout(idleTimer)
      runningTasks.delete(taskId)
      if (!clientGone) {
        send({
          type: 'error',
          error:
            r.connError.name === 'AbortError'
              ? `请求 DeepSeek 超时（超过 ${IDLE_TIMEOUT / 1000} 秒无响应），请稍后重试。`
              : `后端无法连接 DeepSeek API：${r.connError.message}。请检查服务器网络或代理设置。`,
        })
        res.end()
      }
      return
    }
    if (r.httpError) {
      clearTimeout(idleTimer)
      runningTasks.delete(taskId)
      send({ type: 'error', error: r.httpError })
      res.end()
      return
    }
    if (r.model) upstreamModel = r.model
    full += r.text || ''
    if (r.readError) {
      readError = r.readError
      break
    }
    // 正常结束，或内容已完整闭合，无需续写
    if (r.finishReason !== 'length' || /<\/html>/i.test(stripCodeFence(full))) break
    // 已达续写上限
    if (round === MAX_CONTINUE) {
      fatalError =
        '应用内容过长，多次续写后仍不完整。请追加“精简代码、减少注释”之类的要求后重新生成。'
      break
    }
    // 带上截断的上文，要求模型严格续写
    convo.push({ role: 'assistant', content: r.text })
    convo.push({ role: 'user', content: CONTINUE_HINT })
    send({ type: 'notice', text: '内容较长，正在自动续写剩余部分…' })
  }
  clearTimeout(idleTimer)
  const task = runningTasks.get(taskId)
  const stoppedByUser = Boolean(task?.stoppedByUser)
  runningTasks.delete(taskId)

  // ---------- 流式读取被中止 ----------
  if (readError) {
    // 用户主动停止：尝试从已生成内容中抢救部分 HTML，回传给前端预览
    if (stoppedByUser && !clientGone) {
      const partial = stripCodeFence(full)
      if (partial && /<html|<!doctype/i.test(partial)) {
        send({
          type: 'partial',
          html: partial,
          chars: full.length,
          closed: /<\/html>/i.test(partial),
          model: upstreamModel,
        })
        res.end()
        return
      }
      send({ type: 'error', error: '已停止生成，且尚未产出可预览的内容，请稍后重试。' })
      res.end()
      return
    }
    if (!clientGone) {
      send({
        type: 'error',
        error:
          readError.name === 'AbortError'
            ? '生成超时或被中止，请稍后重试。'
            : `读取 DeepSeek 流式响应失败：${readError.message}`,
      })
      res.end()
    }
    return
  }
  if (fatalError && !clientGone) {
    send({ type: 'error', error: fatalError })
    res.end()
    return
  }

  const html = stripCodeFence(full)
  const invalidReason = validateGeneratedHtml(html)
  if (invalidReason) {
    send({
      type: 'error',
      error: `生成的应用未通过完整性校验（${invalidReason}），本次结果不会保存，请重试，或在需求中追加“精简代码、减少注释”。`,
    })
    res.end()
    return
  }

  // 落库 assistant 消息与最新应用
  const assistantMsg = {
    mid: newId(),
    role: 'assistant',
    text: `已生成应用（${html.length} 字符），可在右侧预览或通过“新窗口”独立打开。`,
    html,
    model: upstreamModel,
    ts: Date.now(),
  }
  addMessage(session.id, assistantMsg)
  setSessionApp(session.id, html)

  send({
    type: 'done',
    html,
    model: upstreamModel,
    message: { mid: assistantMsg.mid, text: assistantMsg.text },
    session: getSession(session.id),
  })
  res.end()
})

// ---------- 生成的应用独立访问链接（分享/新窗口） ----------
app.get('/apps/:sid/:mid', (req, res) => {
  const session = getSession(req.params.sid)
  const msg = session?.messages.find((m) => m.mid === req.params.mid)
  if (!msg || !msg.html) return res.status(404).send('应用不存在或已被删除。')
  res.type('html').send(msg.html)
})

// 从模型输出中提取纯 HTML：
// 模型有时会在代码前后加说明文字（如“这是一个2048页面：```html ...```”），
// 简单的首尾围栏正则会漏掉这种情况，导致说明文字被一起注入 iframe。
function stripCodeFence(text) {
  let t = (text || '').trim()

  // 1) 提取 markdown 围栏中的代码（仅识别 html 围栏或无语言标识围栏）
  const fence = t.match(/```(?:[hH][tT][mM][lL])?[ \t]*\n?([\s\S]*?)\n?```/)
  if (fence) t = fence[1].trim()

  // 2) 若代码前仍有说明文字，从第一个 <!doctype html> / <html> 处开始截取
  const doctypeIdx = t.search(/<!doctype html/i)
  const htmlTagIdx = t.search(/<html[\s>]/i)
  const start =
    doctypeIdx >= 0 ? doctypeIdx : htmlTagIdx >= 0 ? htmlTagIdx : -1
  if (start > 0) t = t.slice(start)

  // 3) 去掉结尾残留的围栏标记
  return t.replace(/\n?```[ \t]*$/, '').trim()
}

// 校验生成的 HTML：文档闭合且每段内联脚本语法合法，
// 防止输出截断或续写拼接产生“能保存但跑不起来”的坏产物
function validateGeneratedHtml(html) {
  if (!html || !/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) {
    return 'HTML 文档不完整（缺少 <html>/</html> 闭合标签）。'
  }
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html))) {
    const attrs = m[1] || ''
    if (/\bsrc\s*=/.test(attrs)) continue
    const typeMatch = attrs.match(/type\s*=\s*["']?([^"'\s>]+)/i)
    if (typeMatch && !/javascript|module|text\/js/i.test(typeMatch[1])) continue
    const body = m[2]
    if (!body.trim()) continue
    try {
      new vm.Script(body, { filename: 'generated.js' })
    } catch (e) {
      return `生成的脚本存在语法错误（第 ${e.stack?.match(/generated\.js:(\d+)/)?.[1] || '?'} 行）：${e.message}`
    }
  }
  return null
}

// ---------- 生产模式：单服务托管构建产物 ----------
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/apps')) return next()
    res.sendFile(path.join(DIST_DIR, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`[server] 服务已启动: http://localhost:${PORT}`)
  console.log(
    `[server] 使用模型: ${DEEPSEEK_MODEL} | Key 已配置: ${Boolean(process.env.DEEPSEEK_API_KEY)}`,
  )
  console.log(
    `[server] 静态托管: ${
      fs.existsSync(DIST_DIR) ? DIST_DIR : '未检测到 dist/（开发模式请使用 npm run dev:all）'
    }`,
  )
})
