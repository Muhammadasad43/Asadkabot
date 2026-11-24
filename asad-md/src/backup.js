// src/backup.js — "+Backup": one-time download links for a zip with saved messages + voices.
//
// How it works
//   1. You send  +Backup <number>   (or  +Backup me)  in your own WhatsApp chat.
//   2. The bot creates a random link  https://<your-render-url>/backup/<token>
//      (256-bit token, stored only as a hash, valid ~30 min, max 3 downloads).
//   3. You forward the link to the person. They open it, press Download, and get
//      ONE zip:  messages.txt (readable) + messages.json + voices/*.ogg
//
// Security
//   • Only your own account can create links. No login, no shell, no file manager.
//   • The link is the secret: unguessable, expires, limited downloads, no-store.
//   • The page itself never consumes a download (WhatsApp link previews are safe).
//   • Failed guesses are rate-limited per IP. One zip is built at a time (memory).

import fs from 'node:fs'
import crypto from 'node:crypto'
import express from 'express'
import { pool, store } from './store.js'
import { deviceGetAll, getDeviceRow } from './devices.js'
import { formatPkt, normalizePhone } from './schedule.js'
import { ZipWriter } from './zip.js'

const TTL_MIN = (() => {
  const n = Number(process.env.ASADMD_BACKUP_TTL_MIN)
  return Number.isFinite(n) && n >= 1 && n <= 1440 ? n : 30
})()
const MAX_DOWNLOADS = (() => {
  const n = Number(process.env.ASADMD_BACKUP_MAX_DOWNLOADS)
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 3
})()
const MAX_VOICE_BYTES = 25 * 1024 * 1024 // skip a single voice file bigger than this
export const BACKUP_PORT = Number(process.env.ASADMD_BACKUP_PORT) || 10001
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const userPart = (j) => String(j || '').split('@')[0].split(':')[0]

let schemaReady = false
async function ensureSchema() {
  if (schemaReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asadmd_backup_links (
      token_hash    TEXT PRIMARY KEY,
      scope         TEXT NOT NULL,
      phone         TEXT,
      created_at    BIGINT NOT NULL,
      expires_at    BIGINT NOT NULL,
      downloads     INTEGER NOT NULL DEFAULT 0,
      max_downloads INTEGER NOT NULL
    )
  `)
  schemaReady = true
}

export function publicBaseUrl() {
  const u = process.env.ASADMD_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ''
  return u.replace(/\/+$/, '') || null
}

// ─── links ─────────────────────────────────────────────────────────────
// scope: 'device' (phone = linked number) or 'main' (your own archive)
export async function createBackupLink(scope, phone = null) {
  await ensureSchema()
  await pool.query('DELETE FROM asadmd_backup_links WHERE expires_at < $1', [Date.now() - 24 * 3600 * 1000])
  const token = crypto.randomBytes(32).toString('base64url') // 43 chars
  const now = Date.now()
  const expiresAt = now + TTL_MIN * 60 * 1000
  await pool.query(
    `INSERT INTO asadmd_backup_links (token_hash, scope, phone, created_at, expires_at, max_downloads)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sha256(token), scope, phone, now, expiresAt, MAX_DOWNLOADS]
  )
  return { token, expiresAt, ttlMin: TTL_MIN, maxDownloads: MAX_DOWNLOADS }
}

async function peekLink(token) {
  await ensureSchema()
  const r = await pool.query(
    `SELECT scope, phone, expires_at, downloads, max_downloads FROM asadmd_backup_links
     WHERE token_hash = $1 AND expires_at > $2 AND downloads < max_downloads`,
    [sha256(token), Date.now()]
  )
  return r.rows[0] || null
}

// atomic: two parallel requests can never exceed max_downloads
async function claimLink(token) {
  await ensureSchema()
  const r = await pool.query(
    `UPDATE asadmd_backup_links SET downloads = downloads + 1
     WHERE token_hash = $1 AND expires_at > $2 AND downloads < max_downloads
     RETURNING scope, phone`,
    [sha256(token), Date.now()]
  )
  return r.rows[0] || null
}

async function releaseLink(token) {
  await pool.query(
    'UPDATE asadmd_backup_links SET downloads = GREATEST(downloads - 1, 0) WHERE token_hash = $1',
    [sha256(token)]
  ).catch(() => {})
}

// ─── data ──────────────────────────────────────────────────────────────
async function loadRows(scope, phone) {
  if (scope === 'device') return deviceGetAll(phone) // oldest first
  const all = await store.getAll()
  return all.sort((a, b) => a.timestamp - b.timestamp)
}

export async function backupSummary(scope, phone) {
  const rows = await loadRows(scope, phone)
  const voices = rows.filter((r) => r.type === 'voice')
  const files = voices.filter((r) => r.media_path && fs.existsSync(r.media_path)).length
  return { messages: rows.length, voices: voices.length, voiceFiles: files }
}

const safeName = (s) =>
  String(s || 'unknown').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'unknown'

function stampFile(ms) {
  const d = new Date(Number(ms) + 5 * 3600 * 1000) // Pakistan time
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

function chatKeyOf(r) {
  return r.chat_kind === 'group' ? `g:${r.chat_jid}` : `p:${r.sender_jid || r.chat_jid}`
}

function describeRow(r, voiceFile) {
  let line
  if (r.type === 'voice') line = voiceFile ? `🎤 Voice note → ${voiceFile}` : '🎤 Voice note (audio file no longer stored)'
  else if (r.type === 'viewonce') line = `📷 ${r.content}`
  else line = r.content ?? ''
  if (r.deleted) line += '  (Deleted Message)'
  return line
}

export function buildTranscript(rows, voiceFileOf, meta) {
  const chats = new Map()
  for (const r of rows) {
    const key = chatKeyOf(r)
    let c = chats.get(key)
    if (!c) {
      const isGroup = r.chat_kind === 'group'
      c = {
        title: isGroup ? `Group: ${r.chat_name || userPart(r.chat_jid)}` : `${r.sender_name || userPart(r.sender_jid)} (${r.sender_pn || userPart(r.sender_jid)})`,
        lines: [],
      }
      chats.set(key, c)
    }
    const who = r.chat_kind === 'group' ? `${r.sender_name || userPart(r.sender_jid)}: ` : ''
    const text = describeRow(r, voiceFileOf.get(r.id)).split('\n').join('\n    ')
    c.lines.push(`[${formatPkt(r.timestamp)}] ${who}${text}`)
  }
  const head = [
    'ASAD MD — MESSAGE BACKUP',
    `For: ${meta.label}`,
    `Created: ${formatPkt(Date.now())} (Pakistan time, GMT+5)`,
    `Messages: ${meta.messages}   Voice notes: ${meta.voices}   Voice files included: ${meta.voiceFiles}`,
    '',
    'Voice notes are in the "voices" folder (.ogg — play with VLC, or any phone player).',
    'messages.json has the same data in a structured form.',
    '',
    '════════════════════════════════════════',
  ]
  let n = 0
  const body = [...chats.values()].map((c) => `\n[${++n}] ${c.title}\n${'─'.repeat(40)}\n${c.lines.join('\n')}`)
  return head.join('\n') + '\n' + body.join('\n') + '\n'
}

let building = false

async function streamBackup(res, scope, phone) {
  const rows = await loadRows(scope, phone)
  const label = scope === 'device' ? `+${phone}` : 'main account'
  const fname = `asadmd-backup-${scope === 'device' ? phone : 'main'}-${stampFile(Date.now()).slice(0, 8)}.zip`

  res.status(200)
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${fname}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  })

  const zip = new ZipWriter(res)
  // voices first decide the file names the transcript points to
  const voiceFileOf = new Map()
  const voiceJobs = []
  let idx = 0
  for (const r of rows) {
    if (r.type !== 'voice' || !r.media_path) continue
    let size = 0
    try { size = fs.statSync(r.media_path).size } catch { continue }
    if (!size || size > MAX_VOICE_BYTES) continue
    const name = `voices/${String(++idx).padStart(4, '0')}_${stampFile(r.timestamp)}_${safeName(r.sender_name)}.ogg`
    voiceFileOf.set(r.id, name)
    voiceJobs.push({ name, path: r.media_path, ts: r.timestamp })
  }

  const meta = {
    label,
    messages: rows.length,
    voices: rows.filter((r) => r.type === 'voice').length,
    voiceFiles: voiceJobs.length,
  }
  await zip.addFile('messages.txt', buildTranscript(rows, voiceFileOf, meta))
  await zip.addFile(
    'messages.json',
    JSON.stringify(
      rows.map((r) => ({
        id: r.id,
        chat: r.chat_kind === 'group' ? r.chat_name || r.chat_jid : r.sender_name,
        chat_kind: r.chat_kind || 'private',
        sender: r.sender_name,
        sender_id: r.sender_pn || userPart(r.sender_jid),
        time_utc: new Date(Number(r.timestamp)).toISOString(),
        time_pakistan: formatPkt(r.timestamp),
        type: r.type,
        text: r.type === 'voice' ? null : r.content,
        voice_file: voiceFileOf.get(r.id) || null,
        deleted_by_sender: !!r.deleted,
      })),
      null,
      1
    )
  )
  for (const v of voiceJobs) {
    let buf
    try { buf = await fs.promises.readFile(v.path) } catch { continue }
    await zip.addFile(v.name, buf, { compress: false, date: new Date(Number(v.ts)) })
  }
  await zip.finish()
  return { rows: rows.length, voices: voiceJobs.length }
}

// ─── HTTP (the public site proxies /backup/* to this) ────────────────
const failures = new Map() // ip -> { n, resetAt }
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean)
  return xff[xff.length - 1] || req.socket.remoteAddress || 'unknown'
}
function tooManyFailures(ip) {
  const f = failures.get(ip)
  return !!f && f.resetAt > Date.now() && f.n >= 20
}
function noteFailure(ip) {
  const now = Date.now()
  const f = failures.get(ip)
  if (!f || f.resetAt <= now) failures.set(ip, { n: 1, resetAt: now + 10 * 60 * 1000 })
  else f.n++
  if (failures.size > 5000) failures.clear()
}

const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--fg:#111;--mut:#667;--ac:#0a7d52}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--fg:#eef0f3;--mut:#9aa3b2;--ac:#2fbf8a}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{background:var(--card);max-width:420px;width:100%;padding:28px 24px;border-radius:14px;box-shadow:0 2px 16px #0002}
h1{font-size:20px;margin:0 0 8px}p{margin:8px 0;color:var(--mut)}
a.btn{display:block;text-align:center;margin-top:20px;padding:14px;border-radius:10px;background:var(--ac);color:#fff;text-decoration:none;font-weight:600}
small{color:var(--mut)}`

function page(res, status, title, body) {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  })
  res.send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex,nofollow"><title>${title}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`
  )
}

export function backupRouter() {
  const router = express.Router()

  router.get('/backup/:token', async (req, res) => {
    const ip = clientIp(req)
    if (tooManyFailures(ip)) return page(res, 429, 'Too many tries', '<h1>Too many tries</h1><p>Please wait a few minutes.</p>')
    const { token } = req.params
    try {
      const link = TOKEN_RE.test(token) ? await peekLink(token) : null
      if (!link) {
        noteFailure(ip)
        return page(res, 404, 'Link not valid', '<h1>Link not valid</h1><p>This backup link is wrong, expired or already used. Ask for a new one.</p>')
      }
      const mins = Math.max(1, Math.round((Number(link.expires_at) - Date.now()) / 60000))
      page(
        res,
        200,
        'Your backup',
        `<h1>📦 Your backup is ready</h1><p>One zip file with your saved messages (readable text) and voice notes.</p>` +
          `<a class="btn" href="/backup/${token}/download">Download backup (.zip)</a>` +
          `<p><small>Link works for about ${mins} more minute(s). Keep it private — anyone with this link can download the file.</small></p>`
      )
    } catch (e) {
      console.log(`[backup] page error: ${e?.message || e}`)
      page(res, 500, 'Error', '<h1>Something went wrong</h1><p>Please try again in a minute.</p>')
    }
  })

  router.get('/backup/:token/download', async (req, res) => {
    const ip = clientIp(req)
    if (tooManyFailures(ip)) return page(res, 429, 'Too many tries', '<h1>Too many tries</h1><p>Please wait a few minutes.</p>')
    const { token } = req.params
    let claimed = false
    let owner = false
    try {
      if (!TOKEN_RE.test(token)) { noteFailure(ip); return page(res, 404, 'Link not valid', '<h1>Link not valid</h1>') }
      if (building) {
        res.set('Retry-After', '30')
        return page(res, 503, 'Busy', '<h1>Server is busy</h1><p>Another backup is being prepared. Try again in 30 seconds.</p>')
      }
      building = true // take the slot BEFORE any await so two requests cannot both pass
      owner = true
      const link = await claimLink(token)
      if (!link) {
        noteFailure(ip)
        return page(res, 404, 'Link not valid', '<h1>Link not valid</h1><p>This backup link is wrong, expired or already used. Ask for a new one.</p>')
      }
      claimed = true
      const out = await streamBackup(res, link.scope, link.phone)
      console.log(`[backup] served ${link.scope}${link.phone ? ` +${link.phone}` : ''}: ${out.rows} messages, ${out.voices} voices`)
    } catch (e) {
      console.log(`[backup] download failed: ${e?.message || e}`)
      // a failed/aborted transfer does not burn the person's download
      if (claimed) await releaseLink(token)
      if (!res.headersSent) page(res, 500, 'Error', '<h1>Something went wrong</h1><p>Please try again in a minute.</p>')
      else res.destroy()
    } finally {
      if (owner) building = false
    }
  })

  return router
}

// ─── +Backup command (your own chat only) ──────────────────────────────
export async function cmdBackup(sock, m, args) {
  const jid = m.key.remoteJid
  const reply = (text) => sock.sendMessage(jid, { text }, { quoted: m })

  const a = (args[0] || '').toLowerCase()
  if (!a) return reply('⚠️ Usage: +Backup <number>  (a linked device)  or  +Backup me\nSend *+Backup help* for details.')

  let scope, phone = null, label
  if (a === 'me') {
    scope = 'main'
    label = 'your own archive'
  } else {
    phone = normalizePhone(args.join(''))
    if (!phone) return reply('⚠️ I could not read that number. Example: +Backup 03048648492')
    const row = await getDeviceRow(phone)
    if (!row) return reply(`⚠️ +${phone} is not a linked device, so there is nothing saved for them.`)
    scope = 'device'
    label = `+${phone}`
  }

  const base = publicBaseUrl()
  if (!base) {
    return reply('⚠️ I do not know this server’s public address. In Render → Environment add ASADMD_PUBLIC_URL = https://<your-service>.onrender.com and redeploy.')
  }

  const s = await backupSummary(scope, phone)
  if (!s.messages) return reply(`ℹ️ Nothing is saved for ${label} yet, so there is no backup to make.`)

  const link = await createBackupLink(scope, phone)
  await reply(
    `📦 *Backup ready for ${label}*\n` +
      `📝 ${s.messages} messages · 🎤 ${s.voices} voices (${s.voiceFiles} audio files available)\n\n` +
      `${base}/backup/${link.token}\n\n` +
      `⏳ Valid for ${link.ttlMin} minutes · max ${link.maxDownloads} downloads.\n` +
      `Send this link only to the owner. They open it and tap *Download backup*.` +
      (s.voices > s.voiceFiles ? `\n\n⚠️ ${s.voices - s.voiceFiles} voice file(s) are no longer on the server (they are lost when the server redeploys), so only their text rows are included.` : '')
  )
  console.log(`[cmd] +Backup — link created for ${label}`)
}
