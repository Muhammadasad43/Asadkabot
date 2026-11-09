// src/chathistory.js — +ChatHistory, +SendVoice<N>, +SendVoiceAll
//
// Privacy rule: another person's saved private messages/voices are only posted
// into (a) your own chat, or (b) that same person's inbox. If you run these
// commands in a group, the result goes to your own chat instead — unless you
// set ASADMD_ALLOW_SHARE_IN_GROUPS=1.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { store } from './store.js'
import { formatPkt, normalizePhone } from './schedule.js'

const ALLOW_SHARE = process.env.ASADMD_ALLOW_SHARE_IN_GROUPS === '1'
const STATE_TTL_MS = 60 * 60 * 1000
const MAX_MERGE = 100
const CENTER_LINE = '                    ──────────'

const userPart = (j) => String(j || '').split('@')[0].split(':')[0]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const selfJidOf = (sock) => `${userPart(sock.user?.id)}@s.whatsapp.net`

const isGroupish = (jid) =>
  /@g\.us$|@newsletter$|@broadcast$/.test(String(jid || '')) || /^120363/.test(String(jid || ''))
const isPrivateRow = (r) => (!r.chat_kind || r.chat_kind === 'private') && !isGroupish(r.chat_jid)

// originChatJid -> { voices: [{ id, path, name, timestamp }], ownInbox, createdAt }
const states = new Map()

function chunkText(text, max = 30000) {
  const out = []
  let cur = ''
  for (const block of text.split('\n\n')) {
    if ((cur + '\n\n' + block).length > max && cur) {
      out.push(cur)
      cur = block
    } else cur = cur ? cur + '\n\n' + block : block
  }
  if (cur) out.push(cur)
  return out
}

function lineFor(r, voiceNo) {
  let line
  if (r.type === 'voice') {
    line = voiceNo ? `🎤 Voice note → +SendVoice${voiceNo}` : '🎤 Voice note (file no longer stored)'
  } else if (r.type === 'viewonce') {
    line = `📷 ${r.content}`
  } else {
    line = r.content
  }
  if (r.deleted === 1) line += '  (Deleted Message)'
  return line
}

function groupByMinute(items) {
  // items: [{ ts, line }] ascending -> [{ stamp, lines }]
  const groups = []
  for (const it of items) {
    const stamp = formatPkt(it.ts)
    const last = groups[groups.length - 1]
    if (last && last.stamp === stamp) last.lines.push(it.line)
    else groups.push({ stamp, lines: [it.line] })
  }
  return groups
}

const renderGroups = (groups) =>
  groups
    .map((g) => {
      const [first, ...rest] = g.lines
      return [`${first} [ ${g.stamp} ]`, ...rest].join('\n')
    })
    .join('\n\n')

// Which JIDs (user parts) identify this number? Includes the LID if known.
async function variantsForNumber(sock, digits) {
  const set = new Set([digits])
  try {
    const lid = await sock.signalRepository?.lidMapping?.getLIDForPN?.(`${digits}@s.whatsapp.net`)
    if (lid) set.add(userPart(lid))
  } catch {
    /* mapping unavailable */
  }
  return set
}

function rowMatches(r, variants) {
  return (
    variants.has(userPart(r.sender_jid)) ||
    variants.has(userPart(r.chat_jid)) ||
    (r.sender_pn && variants.has(r.sender_pn))
  )
}

function resolveDest(sock, origin, ctx, ownInbox) {
  if (ctx.self || ownInbox || ALLOW_SHARE) return origin
  return ctx.selfJid || selfJidOf(sock)
}

// ─── +ChatHistory ─────────────────────────────────────────────────────
export async function cmdChatHistory(sock, m, args, ctx) {
  const origin = m.key.remoteJid
  const reply = (text) => sock.sendMessage(origin, { text }, { quoted: m })

  let all = await store.getAll()
  let rows
  let ownInbox = false

  if (args.length > 0) {
    const digits = normalizePhone(args.join(''))
    if (!digits) return reply('⚠️ I could not read that number. Send *+ChatHistory help* for instructions.')
    const variants = await variantsForNumber(sock, digits)
    rows = all.filter((r) => rowMatches(r, variants))
    const here = new Set([userPart(origin), userPart(m.key.remoteJidAlt)].filter(Boolean))
    ownInbox = !ctx.self && !isGroupish(origin) && [...variants].some((v) => here.has(v))
  } else if (ctx.self) {
    rows = all // everything saved: private chats + group mentions
  } else if (!isGroupish(origin)) {
    // run inside someone's inbox: everything they sent you
    const variants = new Set([userPart(origin), userPart(m.key.remoteJidAlt)].filter(Boolean))
    rows = all.filter((r) => isPrivateRow(r) && rowMatches(r, variants))
    ownInbox = true
  } else {
    return reply('⚠️ Add a number after the command. Send *+ChatHistory help* for instructions.')
  }

  const dest = resolveDest(sock, origin, ctx, ownInbox)
  const send = (text, first) =>
    sock.sendMessage(dest, { text }, first && dest === origin ? { quoted: m } : {})

  if (!rows.length) {
    await send('No saved messages found.', true)
    return
  }
  rows.sort((a, b) => a.timestamp - b.timestamp || String(a.id).localeCompare(String(b.id)))

  // number the voice notes in ascending time order (only files still on disk)
  const voices = []
  const voiceNo = new Map()
  for (const r of rows) {
    if (r.type === 'voice' && r.media_path && fs.existsSync(r.media_path)) {
      voices.push({ id: r.id, path: r.media_path, name: r.sender_name, timestamp: r.timestamp })
      voiceNo.set(r.id, voices.length)
    }
  }

  // private chats: one numbered block per person
  const personBlocks = []
  const byPerson = new Map()
  // groups/channels: one block per chat
  const chatBlocks = []
  const byChat = new Map()
  for (const r of rows) {
    if (isPrivateRow(r)) {
      const key = userPart(r.sender_pn || r.sender_jid || r.chat_jid)
      let b = byPerson.get(key)
      if (!b) personBlocks.push((b = { name: r.sender_name, items: [] })), byPerson.set(key, b)
      b.name = r.sender_name || b.name
      b.items.push({ ts: r.timestamp, line: lineFor(r, voiceNo.get(r.id)) })
    } else {
      let b = byChat.get(r.chat_jid)
      if (!b) chatBlocks.push((b = { name: r.chat_name || userPart(r.chat_jid), items: [] })), byChat.set(r.chat_jid, b)
      b.name = r.chat_name || b.name
      b.items.push({ ts: r.timestamp, line: `${r.sender_name || userPart(r.sender_jid)}: ${lineFor(r, voiceNo.get(r.id))}` })
    }
  }

  const parts = ['*📝 MESSAGES:*']
  const personTexts = personBlocks.map(
    (b, i) => `\`[${i + 1}] ${b.name}\`\n\n${renderGroups(groupByMinute(b.items))}`
  )
  if (personTexts.length) parts.push(personTexts.join('\n\n' + CENTER_LINE + '\n\n'))
  if (chatBlocks.length) {
    const chatTexts = chatBlocks.map(
      (b, i) => `\`[G${i + 1}] ${b.name}\`\n\n${renderGroups(groupByMinute(b.items))}`
    )
    parts.push('*👥 GROUPS & CHANNELS:*\n\n' + chatTexts.join('\n\n' + CENTER_LINE + '\n\n'))
  }
  if (voices.length > 1) parts.push(`🎤 All ${voices.length} voices merged → +SendVoiceAll`)

  const chunks = chunkText(parts.join('\n\n'))
  for (let i = 0; i < chunks.length; i++) {
    await send(chunks[i], i === 0)
    if (i < chunks.length - 1) await sleep(500)
  }

  states.set(origin, { voices, ownInbox, createdAt: Date.now() })
  console.log(`[cmd] +ChatHistory — ${rows.length} rows, ${voices.length} voices → ${dest === origin ? 'same chat' : 'own chat'}`)
}

// ─── +SendVoice<N> ────────────────────────────────────────────────────
function getState(origin) {
  const st = states.get(origin)
  if (!st) return { error: 'Send *+ChatHistory* first to load the voice list.' }
  if (Date.now() - st.createdAt > STATE_TTL_MS) return { error: 'Voice list expired. Send *+ChatHistory* again.' }
  return { st }
}

export async function cmdSendVoice(sock, m, cmdRaw, ctx) {
  const origin = m.key.remoteJid
  const reply = (text) => sock.sendMessage(origin, { text }, { quoted: m })
  const match = /^\+sendvoice(\d+)$/i.exec(cmdRaw)
  if (!match) return reply('⚠️ Give a voice number. Send *+SendVoice help* for instructions.')
  const N = parseInt(match[1], 10)

  const { st, error } = getState(origin)
  if (error) return reply(error)
  if (!st.voices.length) return reply('No voice notes in the last +ChatHistory result.')
  if (N < 1 || N > st.voices.length) {
    return reply(`No voice #${N}. Available: 1 to ${st.voices.length}.`)
  }
  const v = st.voices[N - 1]
  if (!fs.existsSync(v.path)) return reply(`Voice #${N} file is missing from disk.`)

  const dest = resolveDest(sock, origin, ctx, st.ownInbox)
  const q = dest === origin ? { quoted: m } : {}
  await sock.sendMessage(dest, { audio: fs.readFileSync(v.path), mimetype: 'audio/ogg; codecs=opus', ptt: true }, q)
  await sock.sendMessage(dest, { text: `🎤 Voice #${N} from ${v.name} • ${formatPkt(v.timestamp)}` })
  console.log(`[cmd] +SendVoice${N} sent`)
}

// ─── +SendVoiceAll (merge with ffmpeg) ────────────────────────────────
export function mergeVoices(paths) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asadmd-merge-'))
    const out = path.join(dir, 'merged.ogg')
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

    const args = ['-y', '-hide_banner', '-loglevel', 'error']
    paths.forEach((p) => args.push('-i', p))
    const norm = paths.map((_, i) => `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono[a${i}]`)
    const cat = paths.map((_, i) => `[a${i}]`).join('') + `concat=n=${paths.length}:v=0:a=1[out]`
    args.push('-filter_complex', `${norm.join(';')};${cat}`, '-map', '[out]', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', out)

    let stderr = ''
    let child
    try {
      child = spawn('ffmpeg', args)
    } catch (e) {
      cleanup()
      return reject(e)
    }
    const killer = setTimeout(() => child.kill('SIGKILL'), 180_000)
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(killer)
      cleanup()
      reject(e.code === 'ENOENT' ? new Error('ffmpeg is not installed on the server') : e)
    })
    child.on('close', (code) => {
      clearTimeout(killer)
      try {
        if (code !== 0) return reject(new Error(`ffmpeg failed: ${stderr.slice(-200)}`))
        resolve(fs.readFileSync(out))
      } catch (e) {
        reject(e)
      } finally {
        cleanup()
      }
    })
  })
}

export async function cmdSendVoiceAll(sock, m, ctx) {
  const origin = m.key.remoteJid
  const reply = (text) => sock.sendMessage(origin, { text }, { quoted: m })

  const { st, error } = getState(origin)
  if (error) return reply(error)
  const voices = st.voices.filter((v) => fs.existsSync(v.path))
  if (!voices.length) return reply('No voice notes in the last +ChatHistory result.')
  if (voices.length > MAX_MERGE) {
    return reply(`⚠️ ${voices.length} voices is too many to merge at once (max ${MAX_MERGE}).`)
  }

  voices.sort((a, b) => a.timestamp - b.timestamp) // ascending order
  let buf
  try {
    buf = await mergeVoices(voices.map((v) => v.path))
  } catch (e) {
    console.log(`[cmd] +SendVoiceAll failed: ${e?.message || e}`)
    return reply(`⚠️ Could not merge the voices (${e?.message || e}).`)
  }

  const dest = resolveDest(sock, origin, ctx, st.ownInbox)
  const q = dest === origin ? { quoted: m } : {}
  await sock.sendMessage(dest, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true }, q)
  await sock.sendMessage(dest, { text: `🎤 ${voices.length} voices merged (oldest first)` })
  console.log(`[cmd] +SendVoiceAll sent ${voices.length} voices`)
}
