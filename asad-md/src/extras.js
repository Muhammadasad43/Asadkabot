// src/extras.js — +Sticker, +Image, +Summary, +Export, +Stats

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import pino from 'pino'
import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { store, pool } from './store.js'
import { unwrapMessage } from './media.js'
import { askChatGPT, loadKeys } from './chatgpt.js'
import { formatPkt } from './schedule.js'

const logger = pino({ level: 'silent' })
const userPart = (j) => String(j || '').split('@')[0].split(':')[0]
const isGroupish = (jid) =>
  /@g\.us$|@newsletter$|@broadcast$/.test(String(jid || '')) || /^120363/.test(String(jid || ''))
const isPrivateRow = (r) => (!r.chat_kind || r.chat_kind === 'private') && !isGroupish(r.chat_jid)

function runFfmpeg(args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let child
    try {
      child = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args])
    } catch (e) {
      return reject(e)
    }
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(killer)
      reject(e.code === 'ENOENT' ? new Error('ffmpeg is not installed on the server') : e)
    })
    child.on('close', (code) => {
      clearTimeout(killer)
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.slice(-200)}`))
    })
  })
}

function chunkMsg(text, size = 3800) {
  const out = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

// ─── +Sticker ─────────────────────────────────────────────────────────
// Works two ways: reply to a photo/video/GIF with +Sticker, or send a photo/video
// with +Sticker as its caption.
function findStickerSource(m) {
  const own = unwrapMessage(m.message)?.inner
  if (own?.imageMessage || own?.videoMessage) {
    return { msg: m, kind: own.videoMessage ? 'video' : 'image' }
  }
  const ctx =
    own?.extendedTextMessage?.contextInfo ||
    Object.values(own || {}).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo
  if (ctx?.quotedMessage) {
    const q = unwrapMessage(ctx.quotedMessage)?.inner
    if (q?.imageMessage || q?.videoMessage) {
      return {
        msg: {
          key: {
            remoteJid: m.key.remoteJid,
            id: ctx.stanzaId,
            participant: ctx.participant,
            fromMe: false,
          },
          message: ctx.quotedMessage,
        },
        kind: q.videoMessage ? 'video' : 'image',
      }
    }
  }
  return null
}

export async function toSticker(buf, kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asadmd-stk-'))
  const inp = path.join(dir, 'in.bin')
  const out = path.join(dir, 'out.webp')
  try {
    fs.writeFileSync(inp, buf)
    const fit =
      'format=rgba,scale=512:512:force_original_aspect_ratio=decrease,' +
      'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'
    if (kind === 'image') {
      await runFfmpeg(['-i', inp, '-vf', fit, '-vframes', '1', '-c:v', 'libwebp', '-quality', '80', '-an', out])
      return fs.readFileSync(out)
    }
    // animated: shrink quality until it fits WhatsApp's ~1 MB sticker limit
    let last
    for (const q of [60, 40, 25, 12]) {
      await runFfmpeg([
        '-t', '6', '-i', inp, '-vf', `fps=12,${fit}`,
        '-c:v', 'libwebp', '-loop', '0', '-quality', String(q),
        '-compression_level', '6', '-an', out,
      ])
      last = fs.readFileSync(out)
      if (last.length <= 950 * 1024) break
    }
    return last
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export async function cmdSticker(sock, m) {
  const jid = m.key.remoteJid
  const src = findStickerSource(m)
  if (!src) {
    await sock.sendMessage(jid, { text: '⚠️ Reply to a photo or video with the command. Send *+Sticker help* for instructions.' }, { quoted: m })
    return
  }
  try {
    const buf = await downloadMediaMessage(src.msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
    if (!buf || !buf.length) throw new Error('could not download the media')
    const webp = await toSticker(buf, src.kind)
    await sock.sendMessage(jid, { sticker: webp }, { quoted: m })
    console.log(`[cmd] +Sticker (${src.kind}, ${webp.length} bytes)`)
  } catch (e) {
    console.log(`[cmd] +Sticker failed: ${e?.message || e}`)
    await sock.sendMessage(jid, { text: `⚠️ Could not make the sticker (${e?.message || e}).` }, { quoted: m })
  }
}

// ─── +Image <prompt> ──────────────────────────────────────────────────
export async function generateImage(prompt) {
  const base = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=flux&width=1024&height=1024&nologo=true`
  let lastErr = 'no response'
  for (const key of [...loadKeys(), null]) {
    try {
      const res = await fetch(key ? `${base}&key=${encodeURIComponent(key)}` : base, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(120_000),
      })
      const type = res.headers?.get?.('content-type') || ''
      if (res.ok && type.startsWith('image/')) {
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length) return buf
        lastErr = 'empty image'
        continue
      }
      lastErr = `HTTP ${res.status}`
      if ([401, 402, 403, 429].includes(res.status) || res.status >= 500) continue
      break
    } catch (e) {
      lastErr = e?.name === 'TimeoutError' ? 'timed out' : String(e?.message || e)
    }
  }
  throw new Error(lastErr)
}

export async function cmdImage(sock, m, text) {
  const jid = m.key.remoteJid
  const prompt = String(text).replace(/^\+image\b/i, '').trim().slice(0, 600)
  if (!prompt) {
    await sock.sendMessage(jid, { text: '⚠️ Describe the image after the command. Send *+Image help* for instructions.' }, { quoted: m })
    return
  }
  try {
    const buf = await generateImage(prompt)
    await sock.sendMessage(jid, { image: buf, caption: `🎨 ${prompt}` }, { quoted: m })
    console.log(`[cmd] +Image generated (${buf.length} bytes)`)
  } catch (e) {
    console.log(`[cmd] +Image failed: ${e?.message || e}`)
    await sock.sendMessage(jid, { text: `⚠️ Could not generate the image (${e?.message || e}).` }, { quoted: m })
  }
}

// ─── +Summary ─────────────────────────────────────────────────────────
const CHUNK_CHARS = 14_000
const MAX_CHUNKS = 25

const SUMMARY_PART_SYSTEM =
  'You summarize WhatsApp message logs. Output 5-10 short bullet points starting with "• " covering key topics, ' +
  'requests, plans, important facts and who said what (use the names). Messages may be English, Urdu or Roman Urdu; ' +
  'write the summary in English. No introduction.'
const SUMMARY_FINAL_SYSTEM =
  'You write the final summary of WhatsApp activity for the account owner (Asad). Combine the input into grouped ' +
  'bullet points starting with "• ", under short bold headings like *👤 Name* or *👥 Group name*. Put anything urgent ' +
  'or needing a reply under *⚠️ Needs attention*. At most 25 bullets, English, WhatsApp formatting only (*bold*), ' +
  'no tables, no markdown headings.'

function summaryLine(r) {
  const who = r.sender_name || userPart(r.sender_jid)
  const where = isPrivateRow(r) ? '' : `[${r.chat_name || 'Group'}] `
  let c = r.type === 'voice' ? '[voice note]' : String(r.content || '')
  if (c.length > 300) c = c.slice(0, 300) + '…'
  return `[${formatPkt(r.timestamp)}] ${where}${who}: ${c}${r.deleted === 1 ? ' (deleted)' : ''}`
}

function chunkLines(lines) {
  const chunks = []
  let cur = ''
  for (const l of lines) {
    if (cur.length + l.length + 1 > CHUNK_CHARS && cur) {
      chunks.push(cur)
      cur = ''
    }
    cur += (cur ? '\n' : '') + l
  }
  if (cur) chunks.push(cur)
  return chunks
}

export async function cmdSummary(sock, m, args) {
  const jid = m.key.remoteJid
  const send = (text) => sock.sendMessage(jid, { text }, { quoted: m })
  if (args.length && args[0].toLowerCase() !== 'all') {
    return send('⚠️ Only *+Summary All* is supported. Send *+Summary help* for instructions.')
  }

  const rows = await store.getAll()
  if (!rows.length) return send('Nothing recorded yet.')
  rows.sort((a, b) => a.timestamp - b.timestamp)
  const lines = rows.map(summaryLine)

  let chunks = chunkLines(lines)
  let skipped = 0
  if (chunks.length > MAX_CHUNKS) {
    skipped = chunks.length - MAX_CHUNKS
    chunks = chunks.slice(-MAX_CHUNKS) // keep the most recent
  }
  await send(`⏳ Summarizing ${rows.length} messages…`)

  try {
    let text
    if (chunks.length === 1) {
      text = await askChatGPT(chunks[0], SUMMARY_FINAL_SYSTEM)
    } else {
      let parts = []
      for (const c of chunks) parts.push(await askChatGPT(c, SUMMARY_PART_SYSTEM))
      // reduce until the partial summaries fit in one request
      while (parts.join('\n\n').length > CHUNK_CHARS && parts.length > 1) {
        const next = []
        let group = ''
        for (const p of parts) {
          if (group.length + p.length > CHUNK_CHARS && group) {
            next.push(await askChatGPT(group, SUMMARY_PART_SYSTEM))
            group = ''
          }
          group += (group ? '\n\n' : '') + p
        }
        if (group) next.push(await askChatGPT(group, SUMMARY_PART_SYSTEM))
        parts = next
      }
      text = await askChatGPT(parts.join('\n\n'), SUMMARY_FINAL_SYSTEM)
    }
    const head = `*🧾 SUMMARY — ${rows.length} messages*${skipped ? `\n_(oldest ${skipped} batches skipped: too many messages)_` : ''}\n\n`
    const out = chunkMsg(head + text)
    for (let i = 0; i < out.length; i++) await sock.sendMessage(jid, { text: out[i] }, i === 0 ? { quoted: m } : {})
    console.log(`[cmd] +Summary done (${rows.length} messages, ${chunks.length} batches)`)
  } catch (e) {
    console.log(`[cmd] +Summary failed: ${e?.message || e}`)
    await send(`⚠️ Could not summarize right now (${e?.message || e}).`)
  }
}

// ─── +Export ──────────────────────────────────────────────────────────
export function buildExport(rows) {
  rows = [...rows].sort((a, b) => a.timestamp - b.timestamp)
  const line = (r, withSender) => {
    let c = r.type === 'voice' ? '[Voice note]' : String(r.content || '')
    if (r.deleted === 1) c += ' (Deleted Message)'
    return `[${formatPkt(r.timestamp)}] ${withSender ? `${r.sender_name || userPart(r.sender_jid)}: ` : ''}${c}`
  }
  const people = new Map()
  const chats = new Map()
  for (const r of rows) {
    if (isPrivateRow(r)) {
      const key = userPart(r.sender_pn || r.sender_jid || r.chat_jid)
      let p = people.get(key)
      if (!p) people.set(key, (p = { name: r.sender_name || key, number: r.sender_pn, lines: [] }))
      p.name = r.sender_name || p.name
      p.lines.push(line(r, false))
    } else {
      let c = chats.get(r.chat_jid)
      if (!c) chats.set(r.chat_jid, (c = { name: r.chat_name || userPart(r.chat_jid), lines: [] }))
      c.name = r.chat_name || c.name
      c.lines.push(line(r, true))
    }
  }
  const out = [
    'ASAD MD — SAVED MESSAGES EXPORT',
    `Created: ${formatPkt(Date.now())} (GMT+5)`,
    `Messages: ${rows.length}`,
    '',
  ]
  if (people.size) {
    out.push('=== PRIVATE CHATS ===', '')
    for (const p of people.values()) {
      out.push(`--- ${p.name}${p.number ? ` (+${p.number})` : ''} ---`, ...p.lines, '')
    }
  }
  if (chats.size) {
    out.push('=== GROUPS & CHANNELS (mentions, name, number, replies) ===', '')
    for (const c of chats.values()) out.push(`--- ${c.name} ---`, ...c.lines, '')
  }
  return out.join('\n')
}

export async function cmdExport(sock, m) {
  const jid = m.key.remoteJid
  const rows = await store.getAll()
  if (!rows.length) {
    await sock.sendMessage(jid, { text: 'Nothing recorded yet.' }, { quoted: m })
    return
  }
  const d = new Date(Date.now() + 5 * 3600000)
  const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  await sock.sendMessage(
    jid,
    {
      document: Buffer.from(buildExport(rows), 'utf8'),
      mimetype: 'text/plain',
      fileName: `AsadMD-export-${stamp}.txt`,
      caption: `📦 ${rows.length} saved messages`,
    },
    { quoted: m }
  )
  console.log(`[cmd] +Export sent (${rows.length} rows)`)
}

// ─── +Stats ───────────────────────────────────────────────────────────
const fmtNum = (n) => Number(n).toLocaleString('en-US')
function fmtDuration(sec) {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const mi = Math.floor((sec % 3600) / 60)
  return [d ? `${d}d` : '', h || d ? `${h}h` : '', `${mi}m`].filter(Boolean).join(' ')
}
function dirSizeMB(dir) {
  try {
    let total = 0
    for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size
    return total / 1048576
  } catch {
    return 0
  }
}
const hour12 = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`

export async function buildStats() {
  const rows = await store.getAll()
  const priv = rows.filter(isPrivateRow)
  const grp = rows.filter((r) => !isPrivateRow(r))
  const count = (t) => rows.filter((r) => r.type === t).length
  const textLike = rows.filter((r) => r.type === 'text' || r.type === 'other').length
  const calls = rows.filter((r) => r.type === 'call')
  const missed = calls.filter((r) => /Missed/.test(r.content || '')).length
  const deleted = rows.filter((r) => r.deleted === 1).length

  const bySender = new Map()
  for (const r of rows) {
    if (r.type === 'call') continue
    const key = userPart(r.sender_pn || r.sender_jid)
    const e = bySender.get(key) || { name: r.sender_name || key, n: 0 }
    e.name = r.sender_name || e.name
    e.n += 1
    bySender.set(key, e)
  }
  const top = [...bySender.values()].sort((a, b) => b.n - a.n).slice(0, 5)

  const hours = new Array(24).fill(0)
  for (const r of rows) hours[new Date(r.timestamp + 5 * 3600000).getUTCHours()] += 1
  const busiest = hours.indexOf(Math.max(...hours))

  const times = rows.map((r) => r.timestamp)
  let pending = null
  try {
    const q = await pool.query(`SELECT COUNT(*)::int AS n FROM asadmd_schedules WHERE status = 'pending'`)
    pending = q.rows[0]?.n ?? 0
  } catch {
    /* table may not exist yet */
  }

  const voiceDir = path.join(process.cwd(), 'media', 'voice')
  const voiceFiles = (() => {
    try { return fs.readdirSync(voiceDir).length } catch { return 0 }
  })()
  const mem = process.memoryUsage().rss / 1048576

  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣']
  const lines = [
    '*`📊 Asad MD Stats 📊`*',
    '',
    `*⏱️ Bot Uptime:*  ${fmtDuration(process.uptime())}`,
    `*🧠 Memory Used:*  ${mem.toFixed(0)} MB`,
    `*🗓️ Recording Since:*  ${times.length ? formatPkt(Math.min(...times)) : '—'}`,
    '',
    `*📨 Messages Saved:*  \`${fmtNum(rows.length)}\``,
    `• 💬 Private chats: \`${fmtNum(priv.length)}\``,
    `• 👥 Groups & channels: \`${fmtNum(grp.length)}\``,
    `• 🗑️ Deleted by sender: \`${fmtNum(deleted)}\``,
    '',
    '*🗂️ By Type:*',
    `• 📝 Text: \`${fmtNum(textLike)}\``,
    `• 🎤 Voice notes: \`${fmtNum(count('voice'))}\``,
    `• 📷 Photos: \`${fmtNum(count('photo'))}\``,
    `• 🎥 Videos: \`${fmtNum(count('video'))}\``,
    `• 🖼️ Stickers & GIFs: \`${fmtNum(count('sticker') + count('gif'))}\``,
    `• 👁️ View-once: \`${fmtNum(count('viewonce'))}\``,
    `• 📞 Calls: \`${fmtNum(calls.length)}\` (missed: ${missed})`,
    '',
    '*🏆 Top Senders:*',
    ...(top.length ? top.map((t, i) => `${medals[i]} ${t.name} — \`${fmtNum(t.n)}\``) : ['• —']),
    '',
    `*⏰ Busiest Hour:*  ${rows.length ? hour12(busiest) : '—'} (GMT+5)`,
    `*🎤 Voice Files Stored:*  \`${voiceFiles}\` (${dirSizeMB(voiceDir).toFixed(1)} MB)`,
  ]
  if (pending !== null) lines.push(`*📅 Scheduled Pending:*  \`${pending}\``)
  return lines.join('\n')
}

export async function cmdStats(sock, m) {
  await sock.sendMessage(m.key.remoteJid, { text: await buildStats() }, { quoted: m })
}
