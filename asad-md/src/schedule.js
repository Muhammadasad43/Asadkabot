// src/schedule.js — +Schedule / +Schedules / +Unschedule
//
//   +Schedule 03048648492 "Message text" [5:30PM 3-Nov]
//
// Times are Pakistan Standard Time (GMT+5). Schedules live in Postgres
// (asadmd_schedules), so they survive restarts/redeploys.
//
// NEVER start a bot reply with '+' (index.js treats those as commands).

import { pool } from './store.js'

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000

const pad = (n) => String(n).padStart(2, '0')

// ─── time helpers (PKT) ───────────────────────────────────────────────
function pktParts(ms) {
  const d = new Date(ms + PKT_OFFSET_MS)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
  }
}

export function formatPkt(ms) {
  const p = pktParts(Number(ms))
  const mer = p.h < 12 ? 'AM' : 'PM'
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12
  return `${pad(p.d)}/${pad(p.mo)}/${p.y} ${pad(h12)}:${pad(p.mi)} ${mer}`
}

// ─── phone ────────────────────────────────────────────────────────────
// 03048648492 / 3048648492 / 923048648492 -> Pakistan; +<anything> -> as given.
export function normalizePhone(raw) {
  const s = String(raw || '').replace(/[\s\-().]/g, '')
  if (!s) return null
  let digits
  if (s.startsWith('+')) digits = s.slice(1)
  else if (s.startsWith('00')) digits = s.slice(2)
  else if (s.startsWith('0')) digits = '92' + s.slice(1)
  else if (/^3\d{9}$/.test(s)) digits = '92' + s
  else digits = s // already has a country code
  return /^\d{8,15}$/.test(digits) ? digits : null
}

// ─── date/time ────────────────────────────────────────────────────────
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]
function monthFromWord(w) {
  const x = w.toLowerCase()
  if (x.length < 3) return 0
  const i = MONTH_NAMES.findIndex((n) => n.startsWith(x))
  return i === -1 ? 0 : i + 1
}

const TIME_TOKEN = /^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/i

// Returns { ms, assumedMeridiem } or { error }.
export function parseWhen(input, nowMs = Date.now()) {
  const now = pktParts(nowMs)
  const cleaned = String(input)
    .trim()
    .replace(/(\d)\s+(am|pm)\b/gi, '$1$2')
    .replace(/(\d)(st|nd|rd|th)\b/gi, '$1')
  const tokens = cleaned.split(/[\s,]+/).filter(Boolean)

  // find the time token (has ':' or am/pm)
  let timeTok = null
  let timeIdx = -1
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].match(TIME_TOKEN)
    if (m && (m[2] !== undefined || m[3] !== undefined)) {
      timeTok = m
      timeIdx = i
      break
    }
  }
  if (!timeTok) return { error: 'I could not find a time like 5:30PM or 17:30.' }
  tokens.splice(timeIdx, 1)

  // ── time of day
  let hour = Number(timeTok[1])
  const minute = timeTok[2] !== undefined ? Number(timeTok[2]) : 0
  const mer = timeTok[3] ? timeTok[3].toLowerCase()[0] : null // 'a' | 'p' | null
  if (minute > 59) return { error: 'Minutes must be 0-59.' }
  let hour24
  let assumedMeridiem = false
  if (mer) {
    if (hour < 1 || hour > 12) return { error: 'With AM/PM the hour must be 1-12.' }
    hour24 = (hour % 12) + (mer === 'p' ? 12 : 0)
  } else if (hour > 12 || hour === 0) {
    if (hour > 23) return { error: 'Hour must be 0-23.' }
    hour24 = hour // 24-hour clock
  } else {
    // no AM/PM given: use the AM/PM of the current time
    const pm = now.h >= 12
    hour24 = (hour % 12) + (pm ? 12 : 0)
    assumedMeridiem = true
  }

  // ── date
  const dateStr = tokens.join(' ').replace(/[-\/.]/g, ' ').trim()
  const parts = dateStr ? dateStr.split(/\s+/) : []
  const dateGiven = parts.length > 0
  const words = parts.filter((p) => /^[a-z]+$/i.test(p))
  const nums = parts.filter((p) => /^\d+$/.test(p))
  if (words.length + nums.length !== parts.length) {
    return { error: `I could not understand the date "${tokens.join(' ')}".` }
  }

  let year = now.y
  let month = now.mo
  let day = now.d
  const monthWord = words.find((w) => monthFromWord(w))
  const dayWord = words.find((w) => /^(today|tomorrow|tmrw|tmr)$/i.test(w))
  const unknown = words.filter((w) => w !== monthWord && w !== dayWord)
  if (unknown.length) return { error: `I could not understand "${unknown[0]}" in the date.` }

  const asYear = (s) => (s.length <= 2 ? 2000 + Number(s) : Number(s))
  if (dayWord) {
    if (/^t(o|m)/i.test(dayWord) && dayWord.toLowerCase() !== 'today') {
      const t = pktParts(nowMs + 24 * 60 * 60 * 1000)
      year = t.y; month = t.mo; day = t.d
    }
  } else if (monthWord) {
    month = monthFromWord(monthWord)
    if (nums.length === 1) {
      if (nums[0].length === 4 || Number(nums[0]) > 31) year = asYear(nums[0])
      else day = Number(nums[0])
    } else if (nums.length === 2) {
      if (nums[0].length === 4) { year = asYear(nums[0]); day = Number(nums[1]) }
      else { day = Number(nums[0]); year = asYear(nums[1]) }
    } else if (nums.length > 2) {
      return { error: 'Too many numbers in the date.' }
    }
  } else if (nums.length === 1) {
    day = Number(nums[0])
  } else if (nums.length === 2) {
    day = Number(nums[0]); month = Number(nums[1])
  } else if (nums.length === 3) {
    if (nums[0].length === 4) { year = asYear(nums[0]); month = Number(nums[1]); day = Number(nums[2]) }
    else { day = Number(nums[0]); month = Number(nums[1]); year = asYear(nums[2]) }
  } else if (nums.length > 3) {
    return { error: 'Too many numbers in the date.' }
  }

  // validate (rejects e.g. 31-Nov)
  const check = new Date(Date.UTC(year, month - 1, day))
  if (
    month < 1 || month > 12 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return { error: `${pad(day)}/${pad(month)}/${year} is not a valid date.` }
  }

  let ms = Date.UTC(year, month - 1, day, hour24, minute) - PKT_OFFSET_MS

  // No date given and that time has already passed today: move it to tomorrow.
  // If AM/PM was not given, tomorrow's AM is used (e.g. "[1:47]" at 1:58 PM
  // becomes 1:47 AM tomorrow).
  let shifted = false
  if (ms <= nowMs && !dateGiven) {
    const t = pktParts(nowMs + 24 * 60 * 60 * 1000)
    const h = assumedMeridiem ? hour % 12 : hour24
    ms = Date.UTC(t.y, t.mo - 1, t.d, h, minute) - PKT_OFFSET_MS
    shifted = true
  }
  return { ms, assumedMeridiem, shifted }
}

// ─── full command parsing ─────────────────────────────────────────────
export function parseScheduleCommand(text, nowMs = Date.now()) {
  const rest = String(text).replace(/^\+schedule\b/i, '').trim()

  const first = rest.search(/["“”„]/)
  const last = Math.max(rest.lastIndexOf('"'), rest.lastIndexOf('”'), rest.lastIndexOf('“'))
  if (first === -1 || last <= first) return { error: 'Put the message inside "quotes".' }

  const message = rest.slice(first + 1, last).trim()
  if (!message) return { error: 'The message is empty.' }

  const before = rest.slice(0, first)
  const after = rest.slice(last + 1)

  let timeRaw = null
  let phoneRaw = before
  const inAfter = after.match(/\[([^\]]+)\]/)
  const inBefore = before.match(/\[([^\]]+)\]/)
  if (inAfter) timeRaw = inAfter[1]
  else if (inBefore) {
    timeRaw = inBefore[1]
    phoneRaw = before.replace(inBefore[0], '')
  }
  if (!timeRaw) return { error: 'Put the time inside [brackets], e.g. [5:30PM 3-Nov].' }

  const digits = normalizePhone(phoneRaw)
  if (!digits) return { error: 'I could not read that phone number.' }

  const when = parseWhen(timeRaw, nowMs)
  if (when.error) return { error: when.error }
  if (when.ms <= nowMs) {
    return {
      error: `That time (${formatPkt(when.ms)}) has already passed. Now it is ${formatPkt(nowMs)} (GMT+5).`,
    }
  }
  return { digits, message, sendAt: when.ms, shifted: when.shifted }
}

// ─── database ─────────────────────────────────────────────────────────
let schemaReady = false
async function ensureSchema() {
  if (schemaReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asadmd_schedules (
      id         SERIAL PRIMARY KEY,
      jid        TEXT NOT NULL,
      phone      TEXT NOT NULL,
      message    TEXT NOT NULL,
      send_at    BIGINT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      attempts   INTEGER NOT NULL DEFAULT 0,
      notify_jid TEXT,
      created_at BIGINT NOT NULL,
      sent_at    BIGINT,
      error      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_asadmd_schedules_due ON asadmd_schedules (status, send_at);
  `)
  schemaReady = true
}

// ─── timing setting (saved in Postgres, survives restarts) ────────────
async function ensureSettings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asadmd_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
}

async function loadLead() {
  await ensureSettings()
  const r = await pool.query(`SELECT value FROM asadmd_settings WHERE key = 'schedule_lead_ms'`)
  if (r.rows[0]) {
    const v = Number(r.rows[0].value)
    if (Number.isFinite(v)) leadMs = v
  }
}

async function saveLead(v) {
  await ensureSettings()
  await pool.query(
    `INSERT INTO asadmd_settings (key, value) VALUES ('schedule_lead_ms', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(v)]
  )
  leadMs = v
}

export function getTimingLabel() {
  if (leadMs > 0) return `${leadMs} ms early`
  if (leadMs < 0) return `${-leadMs} ms delayed`
  return 'exactly on time (0 ms)'
}

// "+Schedule early=2500" / "+Schedule delay=3s"  ->  { lead } | { error } | null
function parseTiming(text) {
  const m = String(text).trim().match(/^\+schedule\s+(early|delay)\s*=\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*$/i)
  if (!m) return null
  let ms = Math.round(Number(m[2]) * (m[3] && m[3].toLowerCase() === 's' ? 1000 : 1))
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_TIMING_MS) {
    return { error: `Timing must be between 0 and ${MAX_TIMING_MS} ms.` }
  }
  return { lead: m[1].toLowerCase() === 'early' ? ms : -ms }
}

// ─── commands ─────────────────────────────────────────────────────────
const HELP_HINT = 'Send *+Schedule help* for instructions.'

export async function cmdSchedule(sock, m, text) {
  const jid = m.key.remoteJid

  // +Schedule early=<ms>  /  +Schedule delay=<ms>
  const timing = parseTiming(text)
  if (timing) {
    if (timing.error) {
      await sock.sendMessage(jid, { text: `⚠️ ${timing.error}\n${HELP_HINT}` }, { quoted: m })
      return
    }
    await saveLead(timing.lead)
    await sock.sendMessage(
      jid,
      { text: `⏱️ Scheduled messages will now be sent ${getTimingLabel()}.` },
      { quoted: m }
    )
    console.log(`[schedule] timing set: ${getTimingLabel()}`)
    return
  }

  const p = parseScheduleCommand(text)
  if (p.error) {
    await sock.sendMessage(jid, { text: `⚠️ ${p.error}\n${HELP_HINT}` }, { quoted: m })
    return
  }

  // resolve the real WhatsApp JID (handles LID); fall back to plain JID
  let targetJid = `${p.digits}@s.whatsapp.net`
  try {
    const res = await sock.onWhatsApp(p.digits)
    const hit = Array.isArray(res) ? res[0] : null
    if (hit && hit.exists === false) {
      await sock.sendMessage(jid, { text: `⚠️ +${p.digits} is not on WhatsApp. Nothing scheduled.` }, { quoted: m })
      return
    }
    if (hit?.jid) targetJid = hit.jid
  } catch {
    /* lookup failed: keep the plain JID */
  }

  await ensureSchema()
  const r = await pool.query(
    `INSERT INTO asadmd_schedules (jid, phone, message, send_at, notify_jid, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [targetJid, p.digits, p.message, p.sendAt, jid, Date.now()]
  )
  const id = r.rows[0].id
  const preview = p.message.length > 200 ? p.message.slice(0, 200) + '…' : p.message
  await sock.sendMessage(
    jid,
    {
      text:
        `✅ Message scheduled (#${id})\n` +
        `To: +${p.digits}\n` +
        `When: ${formatPkt(p.sendAt)} (GMT+5)\n` +
        `Message: "${preview}"`,
    },
    { quoted: m }
  )
  console.log(`[schedule] #${id} → +${p.digits} at ${formatPkt(p.sendAt)}${p.shifted ? ' (moved to tomorrow)' : ''}`)
}

export async function cmdScheduleList(sock, m) {
  const jid = m.key.remoteJid
  await ensureSchema()
  const r = await pool.query(
    `SELECT id, phone, message, send_at FROM asadmd_schedules
     WHERE status = 'pending' ORDER BY send_at ASC LIMIT 50`
  )
  if (r.rows.length === 0) {
    await sock.sendMessage(jid, { text: 'No pending scheduled messages.' }, { quoted: m })
    return
  }
  const lines = r.rows.map((x) => {
    const pv = x.message.length > 40 ? x.message.slice(0, 40) + '…' : x.message
    return `#${x.id} • +${x.phone}\n${formatPkt(Number(x.send_at))}\n"${pv}"`
  })
  await sock.sendMessage(
    jid,
    { text: `*⏰ PENDING (${r.rows.length}):*\n\n${lines.join('\n\n')}` },
    { quoted: m }
  )
}

export async function cmdUnschedule(sock, m, args) {
  const jid = m.key.remoteJid
  const id = Number(String(args[0] || '').replace(/^#/, ''))
  if (!Number.isInteger(id) || id <= 0) {
    await sock.sendMessage(jid, { text: '⚠️ Give the schedule number. Send *+Unschedule help* for instructions.' }, { quoted: m })
    return
  }
  await ensureSchema()
  const r = await pool.query(
    `UPDATE asadmd_schedules SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id]
  )
  await sock.sendMessage(
    jid,
    { text: r.rowCount ? `🗑️ Scheduled message #${id} cancelled.` : `⚠️ No pending schedule #${id}.` },
    { quoted: m }
  )
}

// ─── background sender ────────────────────────────────────────────────
// WhatsApp delivery takes a few seconds, so each message is sent LEAD_MS
// before its scheduled time so that it ARRIVES on the dot.
const DEFAULT_LEAD_MS = 2500
const MAX_TIMING_MS = 60 * 1000
const envLead = process.env.ASADMD_SCHEDULE_LEAD_MS
// > 0 = send that many ms early, < 0 = send that many ms late (delay)
let leadMs =
  envLead !== undefined && Number.isFinite(Number(envLead)) ? Number(envLead) : DEFAULT_LEAD_MS
const TICK_MS = 5 * 1000

let online = false
let timer = null
const armed = new Set() // schedule ids with a send timer already set

export function setSchedulerOnline(v) {
  online = Boolean(v)
}

async function notify(sock, row, text) {
  try {
    if (row.notify_jid) await sock.sendMessage(row.notify_jid, { text })
  } catch {
    /* non-fatal */
  }
}

async function fire(getSock, row) {
  armed.delete(row.id)
  const sock = getSock()
  if (!online || !sock) return // not connected: the next tick re-arms it

  // claim it (a cancelled schedule is no longer 'pending', so it is skipped)
  const claim = await pool.query(
    `UPDATE asadmd_schedules SET status = 'sending' WHERE id = $1 AND status = 'pending' RETURNING id`,
    [row.id]
  )
  if (!claim.rowCount) return

  const lateBy = Date.now() - Number(row.send_at)
  if (lateBy > 24 * 60 * 60 * 1000) {
    await pool.query(`UPDATE asadmd_schedules SET status = 'missed' WHERE id = $1`, [row.id])
    await notify(sock, row, `⚠️ Scheduled message #${row.id} to +${row.phone} was not sent (the bot was offline for over 24 hours past ${formatPkt(Number(row.send_at))}).`)
    return
  }

  try {
    await sock.sendMessage(row.jid, { text: row.message })
    await pool.query(
      `UPDATE asadmd_schedules SET status = 'sent', sent_at = $2 WHERE id = $1`,
      [row.id, Date.now()]
    )
    console.log(`[schedule] #${row.id} sent to +${row.phone}`)
    await notify(
      sock,
      row,
      `📤 Scheduled message #${row.id} sent to +${row.phone}` +
        (lateBy > 2 * 60 * 1000 ? ' (late: the bot was offline)' : '')
    )
  } catch (e) {
    const attempts = row.attempts + 1
    const failed = attempts >= 3
    await pool.query(
      `UPDATE asadmd_schedules SET status = $2, attempts = $3, error = $4 WHERE id = $1`,
      [row.id, failed ? 'failed' : 'pending', attempts, String(e?.message || e).slice(0, 300)]
    )
    console.log(`[schedule] #${row.id} send error (${attempts}/3): ${e?.message || e}`)
    if (failed) {
      await notify(sock, row, `❌ Scheduled message #${row.id} to +${row.phone} failed: ${e?.message || e}`)
    }
  }
}

async function tick(getSock) {
  if (!online) return
  try {
    await ensureSchema()
    const now = Date.now()
    const lookahead = Math.max(20 * 1000, leadMs + 10 * 1000)
    const due = await pool.query(
      `SELECT * FROM asadmd_schedules
       WHERE status = 'pending' AND send_at <= $1 ORDER BY send_at ASC LIMIT 50`,
      [now + lookahead]
    )
    let overdueSlot = 0
    for (const row of due.rows) {
      if (armed.has(row.id)) continue
      armed.add(row.id)
      let wait = Number(row.send_at) - leadMs - now
      if (wait <= 0) {
        wait = overdueSlot * 1500 // already due: send now, staggered
        overdueSlot += 1
      }
      setTimeout(() => {
        fire(getSock, row).catch((e) => console.log(`[schedule] fire error: ${e?.message || e}`))
      }, wait)
    }
  } catch (e) {
    console.log(`[schedule] tick error: ${e?.message || e}`)
  }
}

export function startScheduler(getSock) {
  if (timer) return
  ensureSchema()
    .then(() => loadLead())
    .then(() =>
      // a crash mid-send leaves 'sending' rows: put them back in the queue
      pool.query(`UPDATE asadmd_schedules SET status = 'pending' WHERE status = 'sending'`)
    )
    .catch((e) => console.log(`[schedule] init error: ${e?.message || e}`))
  timer = setInterval(() => tick(getSock), TICK_MS)
  console.log(`[schedule] scheduler started (timing: ${getTimingLabel()})`)
}
