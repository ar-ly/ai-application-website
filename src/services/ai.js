// 前端服务层：SSE 流式生成 + 会话管理 + 文件上传 + 指令优化。
// DeepSeek 的真实地址与 API Key 都保存在后端，浏览器中不可见。

// 匿名访客标识：同一浏览器固定不变，随请求头发给后端，
// 用于会话隔离——不同访客打开站点只能看到自己的历史会话
function ownerId() {
  try {
    let id = localStorage.getItem('aib-owner-id')
    if (!id) {
      id = 'v' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
      localStorage.setItem('aib-owner-id', id)
    }
    return id
  } catch {
    return 'vanon'
  }
}

const ownerHeaders = () => ({ 'x-owner-id': ownerId() })

/**
 * 流式生成应用。事件流：meta → delta* → done | partial | error
 * 停止生成请调用 stopGeneration(taskId)（不要中断 fetch，否则收不到部分成果）。
 * @param {object} opts
 *   sessionId, prompt, attachments: [{filename, content}],
 *   onMeta, onDelta, onPartial, signal（仅用于页面卸载等场景）
 * @returns {Promise<object>} done 事件载荷；若被用户停止则返回 { partial:true, html, chars, closed }
 */
export async function generateAppStream({
  sessionId,
  prompt,
  attachments = [],
  onMeta,
  onDelta,
  onPartial,
  signal,
}) {
  let res
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ownerHeaders() },
      body: JSON.stringify({ sessionId, prompt, attachments }),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new Error(
      '无法连接后端服务（/api/generate）。请确认已运行 npm run dev:all（或 npm run server）。',
    )
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new Error(data?.error || `后端服务返回错误（HTTP ${res.status}）。`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result = null
  let partialResult = null

  // 解析单条 SSE 事件（data: {...}）
  const handleEvent = (raw) => {
    const line = raw.split('\n').find((l) => l.startsWith('data:'))
    if (!line) return
    let payload
    try {
      payload = JSON.parse(line.slice(5).trim())
    } catch {
      return
    }
    switch (payload.type) {
      case 'meta':
        onMeta?.(payload)
        break
      case 'delta':
        onDelta?.(payload.text)
        break
      case 'done':
        result = payload
        break
      case 'partial':
        partialResult = payload
        onPartial?.(payload)
        break
      case 'error':
        throw new Error(payload.error)
      default:
        break
    }
  }

  for (;;) {
    let chunk
    try {
      const r = await reader.read()
      if (r.done) break
      chunk = r.value
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      throw new Error(`读取生成流失败：${err.message}`)
    }
    buffer += decoder.decode(chunk, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''
    for (const evt of events) handleEvent(evt)
  }

  if (result) return result
  if (partialResult) return { partial: true, ...partialResult }
  throw new Error('生成流意外中断，请重试。')
}

// 用户主动停止当前生成任务（后端会把已生成的部分内容通过 partial 事件回传）
export async function stopGeneration(taskId) {
  if (!taskId) return
  try {
    await fetch(`/api/generate/${taskId}/stop`, { method: 'POST' })
  } catch {
    /* 停止请求失败不阻塞 UI */
  }
}

// ---------- 文件上传（前端读取文本 → 后端校验类型与大小） ----------
export async function uploadFiles(files) {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error || '文件上传失败。')
  return data.files || []
}

// ---------- 优化指令：把简单想法扩写为详细生成指令 ----------
export async function refinePrompt(prompt) {
  const res = await fetch('/api/refine-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error || '指令优化失败。')
  return data.refined
}

// ---------- 会话管理 ----------
export async function listSessions() {
  const res = await fetch('/api/sessions', { headers: ownerHeaders() })
  if (!res.ok) throw new Error('获取会话列表失败。')
  const data = await res.json()
  return data.sessions || []
}

export async function fetchSession(id) {
  const res = await fetch(`/api/sessions/${id}`)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error || '获取会话详情失败。')
  return data
}

export async function createSessionApi() {
  const res = await fetch('/api/sessions', { method: 'POST', headers: ownerHeaders() })
  if (!res.ok) throw new Error('新建会话失败。')
  return res.json()
}

export async function deleteSessionApi(id) {
  const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('删除会话失败。')
}

// 标记会话已读（左侧未读小绿点消失）
export async function markSessionRead(id) {
  try {
    await fetch(`/api/sessions/${id}/read`, { method: 'POST' })
  } catch {
    /* 忽略 */
  }
}
