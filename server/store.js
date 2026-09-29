// 会话持久化：JSON 文件存储（demo 规模足够，无需数据库）。
// 数据文件：server/data/db.json（已加入 .gitignore，不会提交）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const DB_FILE = path.join(DATA_DIR, 'db.json')

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ sessions: [] }, null, 2), 'utf8')
  }
}

function loadDb() {
  ensureDb()
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
    if (!Array.isArray(db.sessions)) db.sessions = []
    return db
  } catch {
    // 文件损坏时重置，避免服务不可用
    return { sessions: [] }
  }
}

function saveDb(db) {
  ensureDb()
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8')
}

export function newId() {
  return crypto.randomBytes(8).toString('hex')
}

// 会话列表摘要（不含消息正文与应用 HTML，避免大 payload）
export function listSessions() {
  return loadDb().sessions
    .map(({ id, title, createdAt, updatedAt, messages, currentHtml, unread }) => ({
      id,
      title,
      createdAt,
      updatedAt,
      messageCount: messages.length,
      hasApp: Boolean(currentHtml),
      unread: Boolean(unread), // 有新产物但用户尚未查看
    }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
}

export function getSession(id) {
  const s = loadDb().sessions.find((x) => x.id === id) || null
  if (!s) return null
  // 返回前清洗历史脏数据：早期版本可能把模型的前言/尾部 markdown
  // 一起存进了 HTML，这里统一截取 <!doctype/html> … </html> 区间
  return {
    ...s,
    currentHtml: s.currentHtml ? sanitizeHtml(s.currentHtml) : s.currentHtml,
    messages: s.messages.map((m) =>
      m.html ? { ...m, html: sanitizeHtml(m.html) } : m,
    ),
  }
}

// 截取真正的 HTML 文档区间，剥掉模型误输出到页面里的前言和 markdown 残留
export function sanitizeHtml(html) {
  const t = String(html || '')
  const doctypeIdx = t.search(/<!doctype html/i)
  const htmlTagIdx = t.search(/<html[\s>]/i)
  const start = doctypeIdx >= 0 ? doctypeIdx : htmlTagIdx
  if (start < 0) return t // 无法识别为 HTML 文档时原样返回
  const endTag = t.search(/<\/html>/i)
  const end = endTag >= 0 ? endTag + '</html>'.length : t.length
  return t.slice(start, end).trim()
}

export function createSession() {
  const db = loadDb()
  const now = new Date().toISOString()
  const session = {
    id: newId(),
    title: '新的会话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    currentHtml: null,
    unread: false,
  }
  db.sessions.push(session)
  saveDb(db)
  return session
}

export function deleteSession(id) {
  const db = loadDb()
  const before = db.sessions.length
  db.sessions = db.sessions.filter((s) => s.id !== id)
  if (db.sessions.length === before) return false
  saveDb(db)
  return true
}

// 追加消息；首条用户消息自动作为会话标题（取前 20 字）
export function addMessage(sessionId, message) {
  const db = loadDb()
  const s = db.sessions.find((x) => x.id === sessionId)
  if (!s) return null
  const isFirstUser = message.role === 'user' && !s.messages.some((m) => m.role === 'user')
  s.messages.push(message)
  if (isFirstUser) s.title = String(message.text || '').slice(0, 20) || '新的会话'
  // 助手产出了新应用 → 标记未读，提醒用户查看
  if (message.role === 'assistant' && message.html) s.unread = true
  s.updatedAt = new Date().toISOString()
  saveDb(db)
  return s
}

// 用户打开/查看会话后清除未读标记
export function markRead(sessionId) {
  const db = loadDb()
  const s = db.sessions.find((x) => x.id === sessionId)
  if (!s) return false
  if (s.unread) {
    s.unread = false
    saveDb(db)
  }
  return true
}

// 更新会话当前应用（多轮迭代时作为下一轮的上下文）
export function setSessionApp(sessionId, html) {
  const db = loadDb()
  const s = db.sessions.find((x) => x.id === sessionId)
  if (!s) return null
  s.currentHtml = html
  s.updatedAt = new Date().toISOString()
  saveDb(db)
  return s
}
