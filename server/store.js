// 数据持久化层：Neon 云数据库（Postgres），账号 / 会话 / 消息全部持久保存。
// 通过环境变量 DATABASE_URL 提供连接串；未配置时服务可启动，但接口会返回配置提示。
// 注意：本模块在加载时就读取连接串（顶层建表），必须先自行加载 .env——
// ESM 中 import 的模块体先于 index.js 的模块体执行，不能依赖 index.js 里的 dotenv。
import postgres from 'postgres'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') })

const DATABASE_URL = process.env.DATABASE_URL || ''
export const dbReady = Boolean(DATABASE_URL)

const sql = dbReady
  ? postgres(DATABASE_URL, { max: 5, ssl: 'require', prepare: false })
  : null

// 启动时建表（幂等）
if (dbReady) {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      username text UNIQUE NOT NULL,
      pass_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      title text NOT NULL DEFAULT '新的会话',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      current_html text,
      unread boolean NOT NULL DEFAULT false
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      role text NOT NULL,
      text text NOT NULL DEFAULT '',
      html text,
      model text,
      attachments jsonb NOT NULL DEFAULT '[]',
      ts timestamptz NOT NULL DEFAULT now()
    )`
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts)`
}

function requireDb() {
  if (!dbReady) {
    throw new Error('服务器未配置 DATABASE_URL（Neon 数据库），请联系部署者。')
  }
  return sql
}

export function newId() {
  return crypto.randomBytes(8).toString('hex')
}

// ---------- 账号与令牌 ----------
export function hashPassword(pwd) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(pwd), salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(pwd, stored) {
  try {
    const [salt, hash] = String(stored).split(':')
    const h = crypto.scryptSync(String(pwd), salt, 64).toString('hex')
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))
  } catch {
    return false
  }
}

const AUTH_SECRET = process.env.AUTH_SECRET || 'ai-app-builder-dev-secret'
const TOKEN_TTL = 30 * 24 * 3600 * 1000 // 30 天

export function signToken(userId) {
  const payload = `${userId}.${Date.now() + TOKEN_TTL}`
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex')
  return `${payload}.${sig}`
}

export function verifyToken(token) {
  try {
    const [uid, exp, sig] = String(token || '').split('.')
    if (!uid || !exp || !sig) return null
    if (Number(exp) < Date.now()) return null
    const expect = crypto.createHmac('sha256', AUTH_SECRET).update(`${uid}.${exp}`).digest('hex')
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) ? uid : null
  } catch {
    return null
  }
}

export async function findUserByUsername(username) {
  const db = requireDb()
  const rows = await db`SELECT id, username, pass_hash FROM users WHERE username = ${username}`
  return rows[0] || null
}

export async function createUser(username, password) {
  const db = requireDb()
  const id = newId()
  await db`INSERT INTO users (id, username, pass_hash) VALUES (${id}, ${username}, ${hashPassword(password)})`
  return { id, username }
}

// ---------- 会话 ----------
// 会话列表摘要（不含消息正文与应用 HTML，避免大 payload）
export async function listSessions(userId) {
  const db = requireDb()
  const rows = await db`
    SELECT s.id, s.title, s.created_at, s.updated_at, s.current_html, s.unread,
           (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS message_count
    FROM sessions s WHERE s.user_id = ${userId}
    ORDER BY s.updated_at DESC`
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: Number(r.message_count),
    hasApp: Boolean(r.current_html),
    unread: r.unread,
  }))
}

// 从模型输出中截取真正的 HTML 文档区间（清洗历史脏数据）
export function sanitizeHtml(html) {
  const t = String(html || '')
  const doctypeIdx = t.search(/<!doctype html/i)
  const htmlTagIdx = t.search(/<html[\s>]/i)
  const start = doctypeIdx >= 0 ? doctypeIdx : htmlTagIdx
  if (start < 0) return t
  const endTag = t.search(/<\/html>/i)
  const end = endTag >= 0 ? endTag + '</html>'.length : t.length
  return t.slice(start, end).trim()
}

// 会话详情（含消息）。传 userId 时按归属校验；不传时用于公开分享链接访问
export async function getSession(id, userId) {
  const db = requireDb()
  const rows = userId
    ? await db`
      SELECT id, user_id, title, created_at, updated_at, current_html, unread
      FROM sessions WHERE id = ${id} AND user_id = ${userId}`
    : await db`
      SELECT id, user_id, title, created_at, updated_at, current_html, unread
      FROM sessions WHERE id = ${id}`
  const s = rows[0]
  if (!s) return null
  const msgs = await db`
    SELECT id, role, text, html, model, attachments, ts
    FROM messages WHERE session_id = ${id} ORDER BY ts ASC`
  return {
    id: s.id,
    title: s.title,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    unread: s.unread,
    currentHtml: s.current_html ? sanitizeHtml(s.current_html) : s.current_html,
    messages: msgs.map((m) => ({
      mid: m.id,
      role: m.role,
      text: m.text,
      html: m.html ? sanitizeHtml(m.html) : m.html,
      model: m.model,
      attachments: m.attachments || [],
      ts: m.ts,
    })),
  }
}

export async function createSession(userId) {
  const db = requireDb()
  const id = newId()
  await db`
    INSERT INTO sessions (id, user_id, title) VALUES (${id}, ${userId}, ${'新的会话'})`
  return getSession(id, userId)
}

export async function deleteSession(id, userId) {
  const db = requireDb()
  const owned = await db`SELECT id FROM sessions WHERE id = ${id} AND user_id = ${userId}`
  if (!owned.length) return false
  await db`DELETE FROM messages WHERE session_id = ${id}`
  await db`DELETE FROM sessions WHERE id = ${id}`
  return true
}

// 追加消息；首条用户消息自动作为会话标题（取前 20 字）
export async function addMessage(sessionId, message) {
  const db = requireDb()
  const mid = message.mid || newId()
  const isFirstUser =
    message.role === 'user' &&
    !(await db`SELECT 1 FROM messages WHERE session_id = ${sessionId} AND role = 'user' LIMIT 1`).length
  await db`
    INSERT INTO messages (id, session_id, role, text, html, model, attachments, ts)
    VALUES (${mid}, ${sessionId}, ${message.role}, ${message.text || ''}, ${message.html || null},
            ${message.model || null}, ${JSON.stringify(message.attachments || [])}, ${new Date(message.ts || Date.now())})`
  if (isFirstUser) {
    const title = String(message.text || '').slice(0, 20) || '新的会话'
    await db`UPDATE sessions SET title = ${title}, updated_at = now() WHERE id = ${sessionId}`
  } else {
    await db`UPDATE sessions SET updated_at = now() WHERE id = ${sessionId}`
  }
  // 助手产出了新应用 → 标记未读，提醒用户查看
  if (message.role === 'assistant' && message.html) {
    await db`UPDATE sessions SET unread = true WHERE id = ${sessionId}`
  }
  return mid
}

export async function markRead(sessionId, userId) {
  const db = requireDb()
  const rows = await db`
    UPDATE sessions SET unread = false WHERE id = ${sessionId} AND user_id = ${userId} RETURNING id`
  return rows.length > 0
}

// 更新会话当前应用（多轮迭代时作为下一轮的上下文）
export async function setSessionApp(sessionId, html) {
  const db = requireDb()
  await db`UPDATE sessions SET current_html = ${html}, updated_at = now() WHERE id = ${sessionId}`
}

// 版本回滚：把某条历史消息里的 HTML 设为当前应用
export async function rollbackVersion(sessionId, mid, userId) {
  const db = requireDb()
  const rows = await db`
    SELECT m.html FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.id = ${mid} AND m.session_id = ${sessionId} AND s.user_id = ${userId} AND m.html IS NOT NULL`
  if (!rows.length) return null
  const html = sanitizeHtml(rows[0].html)
  await db`UPDATE sessions SET current_html = ${html}, updated_at = now() WHERE id = ${sessionId}`
  return html
}
