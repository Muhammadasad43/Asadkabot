// src/commands.js
//
// Self-chat command interface for Asad MD.
//
// Commands:
//   +ShowNow                  — dump the archive grouped by sender
//   +YesVoice<N>              — send voice note N from the last +ShowNow
//   +YesView<N>               — send view-once item N from the last +ShowNow
//   +Schedule <num> "msg" [time] — schedule a message (see schedule.js)
//   +Schedule early=<ms> / delay=<ms> — send scheduled messages early/late
//   +ScheduleList / +Unschedule <N> — list / cancel scheduled messages
//   +Help                     — command list; "+<Command> help" for details
//   +DeleteAllChat            — confirms then wipes the messages table
//   +DeleteAllChat confirm    — actually wipes
//   +DeleteAllVoice           — confirms then deletes voice files on disk
//   +DeleteAllVoice confirm   — actually deletes
//
// ── NEVER START A BOT REPLY WITH '+' ─────────────────────────────────────
// index.js treats any self-chat message starting with '+' as a command.
// Bot replies must never start with '+', or they loop.

import fs from 'node:fs'
import { store } from './store.js'
import { cmdSchedule, cmdScheduleList, cmdUnschedule, getTimingLabel } from './schedule.js'
import { welcomeText, helpFor, commandKey, HELP_TOKENS } from './help.js'
import { cmdChatGPT } from './chatgpt.js'
import { cmdChatHistory, cmdSendVoice, cmdSendVoiceAll, ALLOW_SHARE } from './chathistory.js'

let pendingVoiceBatch = null // { voiceList, viewOnceList, chatJid, createdAt }
let pendingConfirm = null    // { command, chatJid, createdAt } — for +DeleteAll*

// "My own chat" can appear as a phone-number jid or a LID; treat both as the same chat.
const userPartOf = (j) => String(j || '').split('@')[0].split(':')[0]
let mineIds = new Set()
let knownSelfJid = null
function sameChat(a, b) {
  if (a === b) return true
  return mineIds.has(userPartOf(a)) && mineIds.has(userPartOf(b))
}

const BATCH_TTL_MS = 30 * 60 * 1000
const CONFIRM_TTL_MS = 60 * 1000
const SEPARATOR = '────────────────────────'
// Short centered divider between different people's messages
const CENTER_LINE = '                    ──────────'

// ─── helpers ────────────────────────────────────────────────────────────
function pad(n) {
  return String(n).padStart(2, '0')
}

// Pakistan Standard Time (GMT+5, no DST). Done with fixed-offset UTC math so
// it is correct no matter what timezone the server (Render = UTC) runs in.
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000

function h12(n) {
  return n % 12 === 0 ? 12 : n % 12
}

// "06/11/2026 03:21 AM"
function formatPkt(ms) {
  const d = new Date(Number(ms) + PKT_OFFSET_MS)
  if (Number.isNaN(d.getTime())) return 'unknown time'
  const h24 = d.getUTCHours()
  const meridiem = h24 < 12 ? 'AM' : 'PM'
  return (
    `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ` +
    `${pad(h12(h24))}:${pad(d.getUTCMinutes())} ${meridiem}`
  )
}

const formatTime = formatPkt
const formatDisplayTime = formatPkt

function chunkText(text, maxChars = 60000) {
  const PREFIX = '*(continued)*\n'
  const blocks = text.split('\n\n')
  const chunks = []
  let current = ''
  const room = () => maxChars - (chunks.length === 0 ? 0 : PREFIX.length)
  const flush = () => {
    if (current === '') return
    chunks.push(chunks.length === 0 ? current : PREFIX + current)
    current = ''
  }
  for (const block of blocks) {
    if (block.length > maxChars - PREFIX.length) {
      flush()
      let rest = block
      while (rest.length > 0) {
        const piece = rest.slice(0, room())
        rest = rest.slice(piece.length)
        current = piece
        flush()
      }
      continue
    }
    if (current === '') {
      current = block
    } else if (current.length + 2 + block.length <= room()) {
      current += '\n\n' + block
    } else {
      flush()
      current = block
    }
  }
  flush()
  return chunks.length ? chunks : [text]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function displayLineFor(r, voiceIndexByMsgId, viewOnceIndexByMsgId) {
  let line
  if (r.type === 'text') {
    line = r.content
  } else if (r.type === 'voice') {
    line = `🎤 Voice note (#${voiceIndexByMsgId.get(r.id) || '?'})`
  } else if (r.type === 'viewonce') {
    line = viewOnceIndexByMsgId.has(r.id)
      ? `📷 ${r.content} (View #${viewOnceIndexByMsgId.get(r.id)})`
      : `📷 ${r.content} [not saved]`
  } else {
    line = r.content
  }
  if (r.deleted === 1) line += '  (Deleted Message)'
  return line
}

// ─── +ShowNow ───────────────────────────────────────────────────────────
async function cmdShowNow(sock, m) {
  const jid = m.key.remoteJid

  let all = typeof store.getAll === 'function'
    ? await store.getAll()
    : await store.getMessages({ limit: 10000 })

  if (!all || all.length === 0) {
    await sock.sendMessage(jid, { text: 'Nothing recorded yet.' }, { quoted: m })
    return
  }

  const everything = all
  all = all.filter(
    (r) =>
      r.chat_jid &&
      !r.chat_jid.endsWith('@g.us') &&
      !r.chat_jid.endsWith('@newsletter') &&
      !/^120363/.test(r.chat_jid) &&
      r.chat_jid !== 'status@broadcast' &&
      !r.chat_jid.endsWith('@broadcast')
  )

  const groupRows = everything
    .filter((r) => r.chat_kind === 'group' || r.chat_kind === 'channel')
    .sort((a, b) => a.timestamp - b.timestamp)

  if (all.length === 0 && groupRows.length === 0) {
    await sock.sendMessage(jid, { text: 'Nothing recorded yet.' }, { quoted: m })
    return
  }

  all.sort((a, b) => a.timestamp - b.timestamp)

  const voiceList = []
  const voiceIndexByMsgId = new Map()
  for (const r of all) {
    if (r.type === 'voice' && r.media_path && fs.existsSync(r.media_path)) {
      const idx = voiceList.length + 1
      voiceList.push({ index: idx, id: r.id, sender_name: r.sender_name, timestamp: r.timestamp, media_path: r.media_path })
      voiceIndexByMsgId.set(r.id, idx)
    }
  }

  const viewOnceList = []
  const viewOnceIndexByMsgId = new Map()
  for (const r of all) {
    if (r.type === 'viewonce' && r.media_path && fs.existsSync(r.media_path)) {
      const idx = viewOnceList.length + 1
      viewOnceList.push({ index: idx, id: r.id, sender_name: r.sender_name, timestamp: r.timestamp, media_path: r.media_path, content: r.content })
      viewOnceIndexByMsgId.set(r.id, idx)
    }
  }

  // One block per contact, numbered 1,2,3... in the order they appear now.
  // Inside a block, consecutive messages from the same minute share one
  // bold timestamp header.
  const blocks = []
  const blockByKey = new Map()
  for (const r of all) {
    const key = r.sender_jid || r.sender_name
    let block = blockByKey.get(key)
    if (!block) {
      block = { sender_name: r.sender_name, groups: [] }
      blockByKey.set(key, block)
      blocks.push(block)
    }
    const stamp = formatPkt(r.timestamp)
    const line = displayLineFor(r, voiceIndexByMsgId, viewOnceIndexByMsgId)
    const last = block.groups[block.groups.length - 1]
    if (last && last.stamp === stamp) last.lines.push(line)
    else block.groups.push({ stamp, lines: [line] })
  }

  const groupTexts = blocks.map((b, i) => {
    // Timestamp goes at the end of the FIRST line of each same-minute group;
    // groups are separated by a blank line.
    const parts = b.groups.map((g) => {
      const [first, ...rest] = g.lines
      return [`${first} [ ${g.stamp} ]`, ...rest].join('\n')
    })
    return `\`[${i + 1}] ${b.sender_name}\`\n\n${parts.join('\n\n')}`
  })

  // Groups / channels / communities: only messages that mention me, say my
  // name, contain my number, or reply to me.
  const chatMap = new Map()
  for (const r of groupRows) {
    let c = chatMap.get(r.chat_jid)
    if (!c) chatMap.set(r.chat_jid, (c = { name: r.chat_name || userPartOf(r.chat_jid), groups: [] }))
    c.name = r.chat_name || c.name
    const base = r.type === 'voice' ? '🎤 Voice note' : r.type === 'viewonce' ? `📷 ${r.content}` : r.content
    const line = `${r.sender_name || userPartOf(r.sender_jid)}: ${base}${r.deleted === 1 ? '  (Deleted Message)' : ''}`
    const stamp = formatPkt(r.timestamp)
    const last = c.groups[c.groups.length - 1]
    if (last && last.stamp === stamp) last.lines.push(line)
    else c.groups.push({ stamp, lines: [line] })
  }
  const chatTexts = [...chatMap.values()].map((c, i) => {
    const parts = c.groups.map((g) => {
      const [first, ...rest] = g.lines
      return [`${first} [ ${g.stamp} ]`, ...rest].join('\n')
    })
    return `\`[G${i + 1}] ${c.name}\`\n\n${parts.join('\n\n')}`
  })

  let body = '*📝 MESSAGES:*' + '\n\n' + groupTexts.join('\n\n' + CENTER_LINE + '\n\n')
  if (chatTexts.length) {
    body +=
      (groupTexts.length ? '\n\n' : '') +
      '*👥 GROUPS & CHANNELS:*\n\n' +
      chatTexts.join('\n\n' + CENTER_LINE + '\n\n')
  }
  body += '\n' + SEPARATOR

  const trailing = []

  if (voiceList.length > 0) {
    const voiceLines = voiceList.map(
      (v) => `\`${v.sender_name}: Voice${v.index}\`  • ${formatDisplayTime(v.timestamp)}`
    )
    trailing.push(`*🎤 VOICE NOTES (Total: ${voiceList.length}):*\n${voiceLines.join('\n')}`)
  }

  if (viewOnceList.length > 0) {
    const viewLines = viewOnceList.map(
      (v) => `\`${v.sender_name}: View${v.index}\`  • ${formatDisplayTime(v.timestamp)}  • ${v.content}`
    )
    trailing.push(`*📷 VIEW-ONCE ITEMS (Total: ${viewOnceList.length}):*\n${viewLines.join('\n')}`)
  }

  if (trailing.length > 0) {
    body += '\n\n' + trailing.join('\n\n' + SEPARATOR + '\n\n')
  }

  const chunks = chunkText(body)
  for (let i = 0; i < chunks.length; i++) {
    await sock.sendMessage(jid, { text: chunks[i] }, i === 0 ? { quoted: m } : {})
    if (i < chunks.length - 1) await sleep(500)
  }

  pendingVoiceBatch = { voiceList, viewOnceList, chatJid: jid, createdAt: Date.now() }
  console.log(`[cmd] +ShowNow — served ${all.length} messages, ${voiceList.length} voices, ${viewOnceList.length} view-once`)
}

// ─── +YesVoice<N> ───────────────────────────────────────────────────────
async function cmdYesVoice(sock, m, cmdRaw) {
  const jid = m.key.remoteJid
  const match = /^\+yesvoice(\d+)$/i.exec(cmdRaw)
  if (!match) {
    await sock.sendMessage(jid, { text: 'Give a voice number. Send *+YesVoice help* for instructions.' }, { quoted: m })
    return
  }
  const N = parseInt(match[1], 10)

  if (pendingVoiceBatch === null || !sameChat(pendingVoiceBatch.chatJid, jid)) {
    await sock.sendMessage(jid, { text: 'Send ShowNow first to load the voice list.' }, { quoted: m })
    return
  }
  if (Date.now() - pendingVoiceBatch.createdAt > BATCH_TTL_MS) {
    await sock.sendMessage(jid, { text: 'Voice list expired. Send ShowNow again to refresh.' }, { quoted: m })
    return
  }

  const M = pendingVoiceBatch.voiceList.length
  if (M === 0) {
    await sock.sendMessage(jid, { text: 'No voice notes in the last ShowNow result.' }, { quoted: m })
    return
  }
  if (N < 1 || N > M) {
    await sock.sendMessage(jid, { text: `No voice note #${N}. You have ${M} voices — try YesVoice1 to YesVoice${M}.` }, { quoted: m })
    return
  }

  const v = pendingVoiceBatch.voiceList[N - 1]
  const record = await store.getMessageById(v.id)
  if (!record || !record.media_path || !fs.existsSync(record.media_path)) {
    await sock.sendMessage(jid, { text: `Voice note #${N} file is missing from disk.` }, { quoted: m })
    return
  }

  await sock.sendMessage(
    jid,
    { audio: { url: record.media_path }, mimetype: 'audio/ogg; codecs=opus', ptt: true },
    { quoted: m }
  )
  await sock.sendMessage(jid, {
    text: `🎤 Voice #${N} from ${record.sender_name} • ${formatTime(record.timestamp)}`,
  })
  console.log(`[cmd] +YesVoice${N} — sent voice #${N}`)
}

// ─── +YesView<N> ────────────────────────────────────────────────────────
async function cmdYesView(sock, m, cmdRaw) {
  const jid = m.key.remoteJid
  const match = cmdRaw.match(/^\+yesview(\d+)$/i)
  if (!match) {
    await sock.sendMessage(jid, { text: 'Give a view-once number. Send *+YesView help* for instructions.' }, { quoted: m })
    return
  }
  const N = parseInt(match[1], 10)

  if (!pendingVoiceBatch || !sameChat(pendingVoiceBatch.chatJid, jid)) {
    await sock.sendMessage(jid, { text: 'Send ShowNow first to load the view-once list.' }, { quoted: m })
    return
  }
  if (Date.now() - pendingVoiceBatch.createdAt > BATCH_TTL_MS) {
    await sock.sendMessage(jid, { text: 'View-once list expired. Send ShowNow again to refresh.' }, { quoted: m })
    return
  }

  const list = pendingVoiceBatch.viewOnceList || []
  const M = list.length
  if (M === 0) {
    await sock.sendMessage(jid, { text: 'No view-once items in the last ShowNow result.' }, { quoted: m })
    return
  }
  if (N < 1 || N > M) {
    await sock.sendMessage(jid, { text: `No view-once item #${N}. You have ${M} — try YesView1 to YesView${M}.` }, { quoted: m })
    return
  }

  const v = list[N - 1]
  const record = await store.getMessageById(v.id)
  if (!record || !record.media_path || !fs.existsSync(record.media_path)) {
    await sock.sendMessage(jid, { text: `View-once item #${N} file is missing from disk.` }, { quoted: m })
    return
  }

  const ext = (record.media_path.split('.').pop() || '').toLowerCase()
  const captionBase = `View #${N} (${record.content}) from ${record.sender_name} • ${formatDisplayTime(record.timestamp)}`

  if (ext === 'jpg' || ext === 'jpeg') {
    await sock.sendMessage(jid, { image: { url: record.media_path }, caption: `📷 ${captionBase}` }, { quoted: m })
  } else if (ext === 'mp4') {
    await sock.sendMessage(jid, { video: { url: record.media_path }, caption: `🎥 ${captionBase}` }, { quoted: m })
  } else if (ext === 'ogg') {
    await sock.sendMessage(jid, { audio: { url: record.media_path }, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: m })
    await sock.sendMessage(jid, { text: `🎤 ${captionBase}` })
  } else if (ext === 'webp') {
    await sock.sendMessage(jid, { sticker: { url: record.media_path } }, { quoted: m })
    await sock.sendMessage(jid, { text: `🎨 ${captionBase}` })
  } else {
    await sock.sendMessage(jid, { document: { url: record.media_path }, fileName: `viewonce-${N}.${ext}`, mimetype: 'application/octet-stream', caption: captionBase }, { quoted: m })
  }
  console.log(`[cmd] +YesView${N} — sent view-once item #${N} (${ext})`)
}

// ─── +DeleteAllChat ─────────────────────────────────────────────────────
// Two-step: first call shows row count and asks for confirmation, second
// call within 60s (with arg "confirm") wipes the messages table.
async function cmdDeleteAllChat(sock, m, args) {
  const jid = m.key.remoteJid

  if ((args[0] || '').toLowerCase() !== 'confirm') {
    const s = await store.stats()
    pendingConfirm = { command: 'deleteallchat', chatJid: jid, createdAt: Date.now() }
    await sock.sendMessage(
      jid,
      {
        text:
          `⚠️  This will permanently delete ALL ${s.total} message records (text, voice metadata, view-once placeholders).\n` +
          `Voice files on disk and auth state are NOT touched.\n\n` +
          `Reply "DeleteAllChat confirm" within 60 seconds to proceed.`,
      },
      { quoted: m }
    )
    return
  }

  if (!pendingConfirm || pendingConfirm.command !== 'deleteallchat' || !sameChat(pendingConfirm.chatJid, jid)) {
    await sock.sendMessage(jid, { text: 'No pending DeleteAllChat to confirm. Send DeleteAllChat first.' }, { quoted: m })
    return
  }
  if (Date.now() - pendingConfirm.createdAt > CONFIRM_TTL_MS) {
    pendingConfirm = null
    await sock.sendMessage(jid, { text: 'Confirmation expired. Send DeleteAllChat again.' }, { quoted: m })
    return
  }
  pendingConfirm = null

  const s = await store.stats()
  const removed = await store.wipeAll()
  await sock.sendMessage(
    jid,
    { text: `🗑️  Deleted ${removed} message records (was ${s.total}). Auth and voice files untouched.` },
    { quoted: m }
  )
  console.log(`[cmd] +DeleteAllChat — wiped ${removed} rows`)
}

// ─── +DeleteAllVoice ────────────────────────────────────────────────────
// Deletes every .ogg under ./media/voice/ and nulls media_path on voice
// rows in the DB. Message records stay so the timeline shows "file removed".
async function cmdDeleteAllVoice(sock, m, args) {
  const jid = m.key.remoteJid
  const dir = './media/voice'

  // Count files for the confirmation prompt
  let fileCount = 0
  if (fs.existsSync(dir)) fileCount = fs.readdirSync(dir).filter((f) => f.endsWith('.ogg')).length

  if ((args[0] || '').toLowerCase() !== 'confirm') {
    pendingConfirm = { command: 'deleteallvoice', chatJid: jid, createdAt: Date.now() }
    await sock.sendMessage(
      jid,
      {
        text:
          `⚠️  This will permanently delete ${fileCount} voice file(s) from disk.\n` +
          `Message records stay (they show as "Voice note (file removed)"), but audio can't be replayed.\n\n` +
          `Reply "DeleteAllVoice confirm" within 60 seconds to proceed.`,
      },
      { quoted: m }
    )
    return
  }

  if (!pendingConfirm || pendingConfirm.command !== 'deleteallvoice' || !sameChat(pendingConfirm.chatJid, jid)) {
    await sock.sendMessage(jid, { text: 'No pending DeleteAllVoice to confirm. Send DeleteAllVoice first.' }, { quoted: m })
    return
  }
  if (Date.now() - pendingConfirm.createdAt > CONFIRM_TTL_MS) {
    pendingConfirm = null
    await sock.sendMessage(jid, { text: 'Confirmation expired. Send DeleteAllVoice again.' }, { quoted: m })
    return
  }
  pendingConfirm = null

  let deleted = 0
  let failed = 0
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ogg')) continue
      try {
        fs.unlinkSync(`${dir}/${f}`)
        deleted++
      } catch (e) {
        failed++
        console.log(`[cmd] +DeleteAllVoice: could not delete ${f}: ${e.message}`)
      }
    }
  }

  // Detach media_path on voice rows so +YesVoiceN doesn't try to open a
  // missing file.
  try {
    const all = await store.getAll()
    for (const r of all) {
      if (r.type === 'voice' && r.media_path) {
        await store.saveMessage({ ...r, media_path: null, content: 'Voice note (file removed)' })
      }
    }
  } catch (e) {
    console.log('[cmd] +DeleteAllVoice: DB cleanup warning:', e.message)
  }

  await sock.sendMessage(
    jid,
    { text: `🎤 Deleted ${deleted} voice file(s)${failed ? `, ${failed} failed` : ''}. Message records kept.` },
    { quoted: m }
  )
  console.log(`[cmd] +DeleteAllVoice — deleted ${deleted} files, ${failed} failed`)
}

// ─── dispatcher ─────────────────────────────────────────────────────────
// Commands typed in OTHER people's chats are strict: exact spelling/casing and
// "-help" only. Anything else (like "+1") is silently ignored there.
const STRICT_RE =
  /^\+(?:ShowNow|Help|Schedule|ScheduleList|Unschedule|DeleteAllChat|DeleteAllVoice|ChatGPT|ChatHistory|SendVoiceAll|(?:YesVoice|YesView|SendVoice)\d+)$/

// Safe mode only (ASADMD_ALLOW_SHARE_IN_GROUPS=0): these show or change MY data,
// so outside my own chat they answer in my own chat. By default every command
// answers in the chat where it was typed.
const PRIVATE_KEYS = new Set([
  'shownow', 'yesvoice', 'yesview', 'schedule', 'schedulelist',
  'unschedule', 'deleteallchat', 'deleteallvoice',
])

function selfProxy(sock, m) {
  const mine = `${userPartOf(sock.user?.id)}@s.whatsapp.net`
  return { ...m, key: { ...m.key, remoteJid: knownSelfJid || mine, fromMe: true } }
}

export async function handleCommand(sock, m, text, ctx = { self: true }) {
  try {
    const self = ctx.self !== false
    mineIds = new Set([userPartOf(sock.user?.id), userPartOf(sock.user?.lid)].filter(Boolean))
    if (self) knownSelfJid = m.key.remoteJid

    const tokens = text.trim().split(/\s+/)
    const cmdRaw = tokens[0]
    const args = tokens.slice(1)

    if (!self && !STRICT_RE.test(cmdRaw)) return // not a real command here: stay silent

    const cmd = cmdRaw.toLowerCase() // in my own chat commands are never case-sensitive
    const key = commandKey(cmd)
    const origin = m.key.remoteJid
    const target = !self && !ALLOW_SHARE && PRIVATE_KEYS.has(key) ? selfProxy(sock, m) : m
    const jid = target.key.remoteJid
    const cctx = { self, selfJid: knownSelfJid || `${userPartOf(sock.user?.id)}@s.whatsapp.net` }

    // +Help  /  +Help <command>
    if (cmd === '+help') {
      const k = commandKey(args[0] || '')
      let t = helpFor(k)
      if (t && k === 'schedule') t += `\n\n*Current timing:* ${getTimingLabel()}`
      await sock.sendMessage(origin, { text: t || welcomeText() }, { quoted: m })
      return
    }

    // "+<Command> help" (own chat: help/-help/--help/-h/?)  ·  other chats: "-help" only
    const helpAsked =
      args.length === 1 && (self ? HELP_TOKENS.has(args[0].toLowerCase()) : args[0] === '-help')
    if (helpAsked) {
      let h = helpFor(key)
      if (h && key === 'schedule') h += `\n\n*Current timing:* ${getTimingLabel()}`
      if (h) {
        await sock.sendMessage(origin, { text: h }, { quoted: m })
        return
      }
    }

    if (cmd === '+shownow') {
      await cmdShowNow(sock, target)
    } else if (cmd.startsWith('+yesvoice')) {
      await cmdYesVoice(sock, target, cmdRaw)
    } else if (cmd.startsWith('+yesview')) {
      await cmdYesView(sock, target, cmdRaw)
    } else if (cmd === '+schedule') {
      await cmdSchedule(sock, target, text)
    } else if (cmd === '+schedulelist') {
      await cmdScheduleList(sock, target)
    } else if (cmd === '+unschedule') {
      await cmdUnschedule(sock, target, args)
    } else if (cmd === '+deleteallchat') {
      await cmdDeleteAllChat(sock, target, args)
    } else if (cmd === '+deleteallvoice') {
      await cmdDeleteAllVoice(sock, target, args)
    } else if (cmd === '+chatgpt') {
      await cmdChatGPT(sock, m, text)
    } else if (cmd === '+chathistory') {
      await cmdChatHistory(sock, m, args, cctx)
    } else if (cmd === '+sendvoiceall') {
      await cmdSendVoiceAll(sock, m, cctx)
    } else if (cmd.startsWith('+sendvoice')) {
      await cmdSendVoice(sock, m, cmdRaw, cctx)
    } else {
      await sock.sendMessage(jid, { text: 'Unknown command. Send *+Help* to see all commands.' })
    }
  } catch (e) {
    console.log(`[cmd] error: ${e?.message || e}`)
    try {
      await sock.sendMessage(m.key.remoteJid, { text: `Command failed: ${e.message}` })
    } catch (sendErr) {
      console.log(`[cmd] could not send error reply: ${sendErr?.message || sendErr}`)
    }
  }
}
