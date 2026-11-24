// src/devices.js — secondary WhatsApp accounts linked via +LinkDevice.
//
// Each linked device is its OWN WhatsApp connection (its own socket, its own
// login, its own message archive). Asad never sees their content — he can
// only link a new number (with that person's own participation: THEY enter
// the pairing code on THEIR phone) and delink one later to free memory.
//
// Tables (separate from Asad's own asadmd_auth / asadmd_messages):
//   asadmd_devices        — one row per linked number: status, name, settings
//   asadmd_device_auth    — login keys, namespaced by phone number
//   asadmd_device_messages — their saved messages (content gzip-compressed)

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import pino from 'pino'
import makeWASocket, {
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
  normalizeMessageContent,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys'
import { pool } from './store.js'
import { normalizePhone, formatPkt } from './schedule.js'
import { downloadVoice, downloadViewOnce, labelMedia, unwrapMessage, viewOnceExtension } from './media.js'
import { messageText, findContextInfo, numberRegex } from './handlers.js'

const logger = pino({ level: 'silent' })
const SEPARATOR = '────────────────────────'

const MAX_DEVICES = (() => {
  const n = Number(process.env.ASADMD_MAX_DEVICES)
  return Number.isInteger(n) && n > 0 ? n : 3
})()

// ─── schema ─────────────────────────────────────────────────────────────
let schemaReady = false
async function ensureSchema() {
  if (schemaReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asadmd_devices (
      phone           TEXT PRIMARY KEY,
      name            TEXT,
      save_all_groups INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending',
      linked_by       TEXT,
      linked_at       BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asadmd_device_auth (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asadmd_device_messages (
      device_phone TEXT NOT NULL,
      id           TEXT NOT NULL,
      chat_jid     TEXT,
      sender_jid   TEXT,
      sender_name  TEXT,
      timestamp    BIGINT NOT NULL,
      type         TEXT NOT NULL DEFAULT 'other',
      content      TEXT,
      media_path   TEXT,
      deleted      INTEGER NOT NULL DEFAULT 0,
      deleted_at   BIGINT,
      chat_name    TEXT,
      chat_kind    TEXT,
      reason       TEXT,
      PRIMARY KEY (device_phone, id)
    );
    CREATE INDEX IF NOT EXISTS idx_asadmd_device_messages_phone_ts
      ON asadmd_device_messages (device_phone, timestamp);
  `)
  schemaReady = true
}

// ─── content compression (devices only — keeps their storage small) ─────
function gz(text) {
  if (text === null || text === undefined) return null
  return zlib.gzipSync(Buffer.from(String(text), 'utf8')).toString('base64')
}
function gunz(b64) {
  if (!b64) return null
  try {
    return zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')
  } catch {
    return b64 // older/plain row — show as-is
  }
}

// ─── per-device message store ────────────────────────────────────────────
async function deviceSaveMessage(phone, msg) {
  await ensureSchema()
  await pool.query(
    `INSERT INTO asadmd_device_messages
       (device_phone, id, chat_jid, sender_jid, sender_name, timestamp, type, content, media_path, deleted, deleted_at, chat_name, chat_kind, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (device_phone, id) DO UPDATE SET
       content    = COALESCE(EXCLUDED.content, asadmd_device_messages.content),
       media_path = COALESCE(EXCLUDED.media_path, asadmd_device_messages.media_path),
       deleted    = GREATEST(asadmd_device_messages.deleted, EXCLUDED.deleted),
       deleted_at = COALESCE(EXCLUDED.deleted_at, asadmd_device_messages.deleted_at)`,
    [
      phone, msg.id, msg.chat_jid, msg.sender_jid, msg.sender_name, msg.timestamp, msg.type,
      gz(msg.content), msg.media_path, msg.deleted ? 1 : 0, msg.deleted_at ?? null,
      msg.chat_name ?? null, msg.chat_kind ?? null, msg.reason ?? null,
    ]
  )
}

async function deviceGetById(phone, id) {
  await ensureSchema()
  const r = await pool.query(
    'SELECT * FROM asadmd_device_messages WHERE device_phone = $1 AND id = $2',
    [phone, id]
  )
  if (!r.rows[0]) return null
  return { ...r.rows[0], content: gunz(r.rows[0].content) }
}

async function deviceMarkDeleted(phone, id) {
  await ensureSchema()
  await pool.query(
    `UPDATE asadmd_device_messages SET deleted = 1, deleted_at = $3
     WHERE device_phone = $1 AND id = $2 AND deleted = 0`,
    [phone, id, Date.now()]
  )
}

export async function deviceGetAll(phone) {
  await ensureSchema()
  const r = await pool.query(
    'SELECT * FROM asadmd_device_messages WHERE device_phone = $1 ORDER BY timestamp ASC',
    [phone]
  )
  return r.rows.map((row) => ({ ...row, content: gunz(row.content) }))
}

async function deviceWipeMessages(phone) {
  await ensureSchema()
  await pool.query('DELETE FROM asadmd_device_messages WHERE device_phone = $1', [phone])
}

// ─── per-device Baileys auth state ───────────────────────────────────────
function serialize(value) {
  return JSON.parse(JSON.stringify(value, (k, v) => {
    if (v instanceof Uint8Array) return { __buf: Buffer.from(v).toString('base64') }
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return { __buf: Buffer.from(v.data).toString('base64') }
    return v
  }))
}
function deserialize(value) {
  return JSON.parse(JSON.stringify(value), (k, v) =>
    v && typeof v === 'object' && typeof v.__buf === 'string' ? Buffer.from(v.__buf, 'base64') : v
  )
}
const authKey = (phone, type, id) => `${phone}::${type}::${id}`
const credsKey = (phone) => `${phone}::creds`

async function useDeviceAuthState(phone) {
  await ensureSchema()
  const credsRow = await pool.query('SELECT value FROM asadmd_device_auth WHERE key = $1', [credsKey(phone)])
  const creds = credsRow.rows[0] ? deserialize(credsRow.rows[0].value) : initAuthCreds()

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {}
        if (!ids?.length) return result
        const keys = ids.map((id) => authKey(phone, type, id))
        const r = await pool.query(
          'SELECT key, value FROM asadmd_device_auth WHERE key = ANY($1::text[])',
          [keys]
        )
        const prefix = `${phone}::${type}::`
        for (const row of r.rows) {
          const id = row.key.slice(prefix.length)
          let val = deserialize(row.value)
          if (type === 'app-state-sync-key' && val) val = proto.Message.AppStateSyncKeyData.fromObject(val)
          result[id] = val
        }
        return result
      },
      set: async (data) => {
        const upKeys = [], upVals = [], delKeys = []
        for (const type of Object.keys(data || {})) {
          for (const id of Object.keys(data[type] || {})) {
            const value = data[type][id]
            const k = authKey(phone, type, id)
            if (value === null || value === undefined) delKeys.push(k)
            else { upKeys.push(k); upVals.push(JSON.stringify(serialize(value))) }
          }
        }
        if (delKeys.length) await pool.query('DELETE FROM asadmd_device_auth WHERE key = ANY($1::text[])', [delKeys])
        if (upKeys.length) {
          await pool.query(
            `INSERT INTO asadmd_device_auth (key, value, updated_at)
             SELECT t.k, t.v::jsonb, $3 FROM unnest($1::text[], $2::text[]) AS t(k, v)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
            [upKeys, upVals, Date.now()]
          )
        }
      },
    },
  }

  // Saves run one after another, always writing the LATEST creds, so a slow database
  // can never let an older snapshot overwrite a newer one.
  let chain = Promise.resolve()
  const writeCreds = () =>
    pool.query(
      `INSERT INTO asadmd_device_auth (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [credsKey(phone), JSON.stringify(serialize(state.creds)), Date.now()]
    )
  const saveCreds = () => {
    const run = chain.then(writeCreds, writeCreds)
    chain = run.catch(() => {})
    return run
  }

  return { state, saveCreds }
}

async function wipeDeviceAuth(phone) {
  await ensureSchema()
  await pool.query('DELETE FROM asadmd_device_auth WHERE key LIKE $1', [`${phone}::%`])
}

// ─── device settings (name / save-all-groups) ────────────────────────────
export async function getDeviceRow(phone) {
  await ensureSchema()
  const r = await pool.query('SELECT * FROM asadmd_devices WHERE phone = $1', [phone])
  return r.rows[0] || null
}
async function listDeviceRows() {
  await ensureSchema()
  const r = await pool.query('SELECT * FROM asadmd_devices ORDER BY linked_at ASC')
  return r.rows
}
async function setDeviceStatus(phone, status) {
  await pool.query('UPDATE asadmd_devices SET status = $2 WHERE phone = $1', [phone, status])
}
async function setDeviceName(phone, name) {
  await pool.query('UPDATE asadmd_devices SET name = $2 WHERE phone = $1', [phone, name])
}
async function setDeviceSaveAll(phone, on) {
  await pool.query('UPDATE asadmd_devices SET save_all_groups = $2 WHERE phone = $1', [phone, on ? 1 : 0])
}

// ─── live sockets ─────────────────────────────────────────────────────
const live = new Map() // phone -> { sock }
const isNonInboxJid = (jid) =>
  jid.endsWith('@g.us') || jid.endsWith('@newsletter') || /^120363/.test(jid) ||
  jid.endsWith('@broadcast') || jid === 'status@broadcast'

function pnOf(...jids) {
  for (const j of jids) if (j && String(j).endsWith('@s.whatsapp.net')) return String(j).split('@')[0]
  return null
}

const nameRegexFor = (name) =>
  name
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}\\p{N}])`, 'iu')
    : null

function whyAboutDevice(sock, inner, ownName) {
  const pn = String(sock.user?.id || '').split(':')[0]
  const mine = new Set([pn, String(sock.user?.lid || '').split(':')[0]].filter(Boolean))
  const reasons = []
  const ctx = findContextInfo(inner)
  if (Array.isArray(ctx?.mentionedJid) && ctx.mentionedJid.some((j) => mine.has(String(j).split('@')[0]))) {
    reasons.push('mention')
  }
  if (ctx?.participant && ctx.quotedMessage && mine.has(String(ctx.participant).split('@')[0])) {
    reasons.push('reply')
  }
  const text = messageText(inner)
  if (text) {
    const nameRe = nameRegexFor(ownName)
    if (nameRe && nameRe.test(text)) reasons.push('name')
    const re = numberRegex(pn)
    if (re && re.test(text.replace(/[\s\-()]/g, ''))) reasons.push('number')
  }
  return reasons
}

const chatNameCache = new Map()
async function chatNameFor(sock, jid) {
  const hit = chatNameCache.get(jid)
  if (hit && Date.now() - hit.at < 3600000) return hit.name
  let name = null
  try {
    if (!jid.endsWith('@newsletter')) name = (await sock.groupMetadata(jid))?.subject || null
  } catch { /* no access */ }
  if (!name) name = jid.endsWith('@newsletter') ? 'Channel' : 'Group'
  chatNameCache.set(jid, { name, at: Date.now() })
  return name
}

async function handleDeviceUpsert(phone, sock, row, messages) {
  const fresh = await getDeviceRow(phone) // settings can change live
  const ownName = fresh?.name || row.name
  const saveAll = !!(fresh?.save_all_groups ?? row.save_all_groups)

  for (const m of messages || []) {
    try {
      if (!m?.key || m.key.fromMe) continue
      const jid = m.key.remoteJid
      if (!jid || jid === 'status@broadcast') continue
      if (jid.endsWith('@newsletter')) continue // channels: never, for anyone

      const nonInbox = isNonInboxJid(jid)
      if (!m.message) continue // empty envelope (view-once key withheld) — skip for devices

      if (await deviceGetById(phone, m.key.id)) continue

      const proto_ = m.message?.protocolMessage
      if (proto_ && (proto_.type === 0 || proto_.type === 'REVOKE')) {
        if (proto_.key?.id) await deviceMarkDeleted(phone, proto_.key.id)
        continue
      }

      const { inner, viewOnce } = unwrapMessage(m.message)
      if (!inner) continue

      let reasons = []
      if (nonInbox) {
        if (!saveAll) {
          reasons = whyAboutDevice(sock, inner, ownName)
          if (reasons.length === 0) continue
        } else {
          reasons = ['all']
        }
      }
      const chat_kind = nonInbox ? 'group' : 'private'
      const chat_name = nonInbox ? await chatNameFor(sock, jid) : null
      const sender_jid = m.key.participant || jid
      const sender_name = m.pushName || sender_jid.split('@')[0]
      const timestamp = Number(m.messageTimestamp) * 1000

      let msgType, content, media_path = null
      if (viewOnce) {
        const r = labelMedia(m)
        msgType = r.type
        content = r.content
        const p = await downloadViewOnce(sock, m, m.key.id, viewOnceExtension(inner))
        media_path = p || null
        if (!media_path) content += ' (content unavailable)'
      } else if (inner.conversation) { msgType = 'text'; content = inner.conversation }
      else if (inner.extendedTextMessage?.text) { msgType = 'text'; content = inner.extendedTextMessage.text }
      else if (inner.imageMessage?.caption) { msgType = 'text'; content = inner.imageMessage.caption }
      else if (inner.videoMessage?.caption) { msgType = 'text'; content = inner.videoMessage.caption }
      else if (inner.audioMessage) {
        const p = await downloadVoice(sock, m)
        msgType = 'voice'
        content = p ? 'Voice note' : 'Voice note (download failed)'
        media_path = p
      } else {
        const r = labelMedia(m)
        msgType = r.type
        content = r.content
      }

      await deviceSaveMessage(phone, {
        id: m.key.id, chat_jid: jid, sender_jid, sender_name, timestamp, type: msgType,
        content, media_path, chat_name, chat_kind, reason: reasons.join(',') || null,
      })
    } catch (e) {
      console.log(`[device ${phone}] capture error: ${e?.message || e}`)
    }
  }
}

// ─── pairing / connection lifecycle ───────────────────────────────────
//
// One "session" per linked number. Why sessions (this fixes "code arrives but the
// other phone says Unable to connect"):
//  • The login keys stay IN MEMORY for the whole life of the session and are reused
//    on every reconnect. Before, each reconnect re-read them from Postgres, and
//    WhatsApp's "restart right after pairing" (code 515) could read stale keys
//    because the save to the (remote, sleepy) database had not finished yet.
//  • Key saves are queued and awaited in order (see useDeviceAuthState).
//  • If the connection drops while the code is still unused, a NEW code is
//    requested on the new socket and sent to you, instead of silently leaving a
//    dead code on the screen.
//  • You get a message in your chat when the device is linked, or when pairing
//    failed / timed out, with the reason code.
const PAIR_WINDOW_MS = 4 * 60 * 1000 // a brand-new link may stay "pending" this long
const MAX_CODE_REFRESH = 3
const sessions = new Map() // phone -> session
let mainSock = null

export function setMainSock(s) {
  mainSock = s
}

let waVersionCache = null
async function getWaVersion() {
  if (waVersionCache) return waVersionCache
  try {
    const r = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ])
    waVersionCache = r.version
  } catch { /* use library default */ }
  return waVersionCache
}

async function notifyAdmin(session, text) {
  if (!mainSock || !session?.adminJid) return
  try {
    await mainSock.sendMessage(session.adminJid, { text })
  } catch (e) {
    console.log(`[device ${session.phone}] could not notify admin: ${e?.message || e}`)
  }
}

function teardownSocket(session) {
  const old = session.sock
  session.sock = null
  session.online = false
  if (old) {
    try { old.ev.removeAllListeners('connection.update') } catch { /* ignore */ }
    try { old.end(undefined) } catch { /* ignore */ }
  }
}

async function stopSession(phone, { logout = false } = {}) {
  const session = sessions.get(phone)
  live.delete(phone)
  if (!session) return
  session.stopped = true
  clearTimeout(session.pairTimer)
  clearTimeout(session.retryTimer)
  if (logout && session.sock) {
    try { await session.sock.logout() } catch { /* ignore */ }
  }
  teardownSocket(session)
  sessions.delete(phone)
}

async function failPairing(session, why) {
  const phone = session.phone
  console.log(`[device ${phone}] pairing failed: ${why}`)
  await stopSession(phone)
  await wipeDeviceAuth(phone).catch(() => {})
  await setDeviceStatus(phone, 'delinked').catch(() => {})
  await notifyAdmin(
    session,
    `⚠️ Linking +${phone} did not finish (${why}).\n` +
      `Send *+LinkDevice ${phone}* again and have them enter the new code straight away.`
  )
}

async function openSocket(session) {
  const phone = session.phone
  if (session.stopped) return
  teardownSocket(session)

  const { state, saveCreds } = session.auth
  const version = await getWaVersion()
  if (session.stopped) return

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    defaultQueryTimeoutMs: 60_000,
    getMessage: async () => undefined,
  })
  session.sock = sock
  live.set(phone, { sock })
  let askedForCode = false

  sock.ev.on('creds.update', () => { saveCreds().catch((e) => console.log(`[device ${phone}] save creds failed: ${e?.message || e}`)) })

  sock.ev.on('connection.update', async (update) => {
    if (session.sock !== sock || session.stopped) return // an older socket — ignore
    const { connection, lastDisconnect, qr } = update

    // WhatsApp only emits "qr" while the account is NOT logged in yet — that is the
    // moment to ask for a pairing code (once per socket).
    if (qr && session.pairing && !askedForCode) {
      askedForCode = true
      try {
        const raw = await sock.requestPairingCode(phone)
        const code = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
        console.log(`[device ${phone}] pairing code issued${session.codesIssued ? ' (refresh)' : ''}`)
        session.codesIssued = (session.codesIssued || 0) + 1
        if (session.codesIssued === 1) {
          session.resolveCode?.(code)
        } else {
          await notifyAdmin(
            session,
            `🔄 The connection restarted before +${phone} entered the code.\n` +
              `Use this NEW code instead: *${code}* (the old one no longer works).`
          )
        }
      } catch (e) {
        askedForCode = false
        console.log(`[device ${phone}] could not request pairing code: ${e?.message || e}`)
        if (!session.codesIssued) session.resolveCode?.(null)
      }
    }

    if (connection === 'open') {
      session.online = true
      session.attempts = 0
      session.userName = sock.user?.name || null
      await setDeviceStatus(phone, 'linked').catch(() => {})
      console.log(`[device ${phone}] linked and online`)
      if (session.pairing) {
        session.pairing = false
        clearTimeout(session.pairTimer)
        await notifyAdmin(session, `✅ +${phone} is now linked${session.userName ? ` (${session.userName})` : ''}. It stays connected while the server is running.`)
      }
    }

    if (connection === 'close') {
      session.online = false
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const msg = lastDisconnect?.error?.message
      console.log(`[device ${phone}] connection closed (code ${statusCode ?? 'unknown'}${msg ? `: ${msg}` : ''})`)
      live.delete(phone)

      if (statusCode === DisconnectReason.loggedOut) {
        if (session.pairing) return failPairing(session, 'WhatsApp rejected the link, code 401')
        await stopSession(phone)
        await wipeDeviceAuth(phone).catch(() => {})
        await setDeviceStatus(phone, 'delinked').catch(() => {})
        await notifyAdmin(session, `⚠️ +${phone} removed this device from their WhatsApp (Linked Devices), so it was delinked. Their saved messages are kept for +Backup until you use +DelinkDevice.`)
        return
      }
      if (statusCode === DisconnectReason.connectionReplaced) {
        await stopSession(phone)
        await setDeviceStatus(phone, 'delinked').catch(() => {})
        console.log(`[device ${phone}] replaced by another connection — not reconnecting`)
        return
      }

      // Unused code and the socket died: allow a few fresh codes inside the window.
      if (session.pairing) {
        if (Date.now() - session.createdAt > PAIR_WINDOW_MS) return failPairing(session, 'time ran out')
        if ((session.codesIssued || 0) > MAX_CODE_REFRESH) return failPairing(session, 'connection kept dropping')
      }

      // After a successful pairing WhatsApp asks for an immediate restart (515).
      const delay =
        statusCode === DisconnectReason.restartRequired
          ? 300
          : Math.min(2000 * ++session.attempts, 30000)
      clearTimeout(session.retryTimer)
      session.retryTimer = setTimeout(() => {
        openSocket(session).catch((e) => console.log(`[device ${phone}] reconnect failed: ${e?.message || e}`))
      }, delay)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (session.sock !== sock) return
    if (type !== 'notify') return
    await handleDeviceUpsert(phone, sock, session.row, messages)
    for (const m of messages) {
      if (m?.key?.fromMe && m.message) {
        const text = (normalizeMessageContent(m.message)?.conversation ||
          normalizeMessageContent(m.message)?.extendedTextMessage?.text || '').trim()
        const mine = new Set([jidNormalizedUser(sock.user?.id), jidNormalizedUser(sock.user?.lid || '')].filter(Boolean))
        const self = [m.key.remoteJid, m.key.remoteJidAlt].filter(Boolean).some((j) => mine.has(jidNormalizedUser(j)))
        if (self && (text.startsWith('+') || text.startsWith('.'))) {
          // devices use the fixed '+' prefix regardless of Asad's own +ChangePrefix
          const cmdText = text.replace(/^\./, '+')
          if (cmdText.startsWith('+')) await handleDeviceCommand(phone, sock, m, cmdText).catch((e) =>
            console.log(`[device ${phone}] command error: ${e?.message || e}`)
          )
        }
      }
    }
  })
}

async function createSession(row, { pairing, adminJid }) {
  const phone = row.phone
  await stopSession(phone) // never two sockets for one number
  const auth = await useDeviceAuthState(phone)
  const session = {
    phone, row, auth, adminJid: adminJid || null,
    pairing, createdAt: Date.now(), attempts: 0, codesIssued: 0,
    sock: null, online: false, stopped: false,
    resolveCode: null, pairTimer: null, retryTimer: null, userName: null,
  }
  sessions.set(phone, session)
  if (pairing) {
    // Give up (and free the memory) if nobody finishes the link in time.
    session.pairTimer = setTimeout(() => {
      if (session.pairing && !session.stopped) failPairing(session, 'nobody entered the code in time').catch(() => {})
    }, PAIR_WINDOW_MS + 15_000)
  }
  return session
}

export async function startLinkedDevices() {
  await ensureSchema()
  const rows = await listDeviceRows()
  // A "pending" row after a restart has a dead code — clean it so +LinkDevice works again.
  for (const r of rows.filter((x) => x.status === 'pending')) {
    await wipeDeviceAuth(r.phone).catch(() => {})
    await setDeviceStatus(r.phone, 'delinked').catch(() => {})
    console.log(`[device ${r.phone}] stale pending link cleaned up`)
  }
  const active = rows.filter((r) => r.status === 'linked')
  let i = 0
  for (const row of active.slice(0, MAX_DEVICES)) {
    const delay = i++ * 1500 // stagger so memory/CPU do not spike at boot
    setTimeout(async () => {
      try {
        const session = await createSession(row, { pairing: false, adminJid: row.linked_by })
        await openSocket(session)
      } catch (e) {
        console.log(`[device ${row.phone}] start failed: ${e?.message || e}`)
      }
    }, delay)
  }
  if (active.length) console.log(`[devices] reconnecting ${Math.min(active.length, MAX_DEVICES)} linked device(s)`)
}

// ─── Asad's management commands ──────────────────────────────────────
export async function cmdLinkDevice(sock, m, args) {
  const jid = m.key.remoteJid
  const reply = (text) => sock.sendMessage(jid, { text }, { quoted: m })
  const digits = normalizePhone(args.join(''))
  if (!digits) return reply('⚠️ Give a valid number. Example: +LinkDevice 03048648492')

  const myOwn = String(sock.user?.id || '').split(':')[0]
  if (digits === myOwn) return reply('⚠️ That is your own number — it is already the main device.')

  await ensureSchema()
  const existing = await getDeviceRow(digits)
  if (existing && existing.status === 'linked') {
    return reply(`⚠️ +${digits} is already linked. Use +DelinkDevice first to re-link.`)
  }
  const rows = await listDeviceRows()
  const activeCount = rows.filter((r) => r.phone !== digits && (r.status === 'pending' || r.status === 'linked')).length
  if (activeCount >= MAX_DEVICES) {
    return reply(`⚠️ Device limit reached (${MAX_DEVICES}). Delink one first, or raise ASADMD_MAX_DEVICES in Render.`)
  }

  setMainSock(sock)
  // A previous unfinished attempt for this number is simply replaced.
  await stopSession(digits)
  await wipeDeviceAuth(digits)
  const row = { phone: digits, name: existing?.name ?? null, save_all_groups: existing?.save_all_groups ?? 0 }
  await pool.query(
    `INSERT INTO asadmd_devices (phone, status, linked_by, linked_at)
     VALUES ($1, 'pending', $2, $3)
     ON CONFLICT (phone) DO UPDATE SET status = 'pending', linked_by = $2, linked_at = $3`,
    [digits, jid, Date.now()]
  )

  const session = await createSession(row, { pairing: true, adminJid: jid })
  const codePromise = new Promise((res) => (session.resolveCode = res))
  openSocket(session).catch((e) => {
    console.log(`[device ${digits}] start failed: ${e?.message || e}`)
    session.resolveCode?.(null)
  })
  const code = await Promise.race([codePromise, new Promise((r) => setTimeout(() => r(null), 45_000))])

  if (!code) {
    await failPairing(session, 'no pairing code received from WhatsApp').catch(() => {})
    return
  }
  await reply(
    `✅ Your code for linking the device is *${code}*\n\n` +
    `Tell +${digits} to open WhatsApp → Linked Devices → Link a device → *Link with phone number instead*, ` +
    `and enter this code *within 60 seconds*. The phone must be online.\n` +
    `I will message you here as soon as it is linked (or if it fails).`
  )
  console.log(`[device ${digits}] pairing code sent to admin`)
}

export async function cmdDelinkDevice(sock, m, args) {
  const jid = m.key.remoteJid
  const reply = (text) => sock.sendMessage(jid, { text }, { quoted: m })
  const digits = normalizePhone(args.join(''))
  if (!digits) return reply('⚠️ Give a valid number. Example: +DelinkDevice 03048648492')

  await ensureSchema()
  const row = await getDeviceRow(digits)
  const hasData = row && ((await pool.query('SELECT 1 FROM asadmd_device_messages WHERE device_phone = $1 LIMIT 1', [digits])).rowCount > 0)
  if (!row || (row.status === 'delinked' && !hasData)) return reply(`⚠️ +${digits} is not linked.`)

  await stopSession(digits, { logout: true })
  await wipeDeviceAuth(digits)
  await deviceWipeMessages(digits)
  await setDeviceStatus(digits, 'delinked')
  await reply(`🗑️ +${digits} has been delinked. Their saved data has been removed to free up server memory.`)
  console.log(`[device ${digits}] delinked by request`)
}

export async function cmdLinkedDevices(sock, m) {
  const jid = m.key.remoteJid
  await ensureSchema()
  const rows = (await listDeviceRows()).filter((r) => r.status === 'pending' || r.status === 'linked')
  if (!rows.length) {
    await sock.sendMessage(jid, { text: `No linked devices. (Limit: ${MAX_DEVICES} — set with ASADMD_MAX_DEVICES.)` }, { quoted: m })
    return
  }
  const lines = await Promise.all(rows.map(async (r, i) => {
    const c = await pool.query(
      `SELECT COUNT(*)::int AS msgs, COUNT(*) FILTER (WHERE type = 'voice')::int AS voices
       FROM asadmd_device_messages WHERE device_phone = $1`,
      [r.phone]
    )
    const { msgs, voices } = c.rows[0]
    const online = sessions.get(r.phone)?.online ? '🟢 online' : '🔴 offline'
    return `*Device No.${i + 1}* +${r.phone}${r.name ? ` (${r.name})` : ''} — ${r.status}, ${online} — ${msgs} messages, ${voices} voices`
  }))
  await sock.sendMessage(
    jid,
    { text: `*📱 LINKED DEVICES (${rows.length}/${MAX_DEVICES}):*\n\n${lines.join('\n')}\n\n${SEPARATOR}` },
    { quoted: m }
  )
}

// ─── commands available ON a linked device itself (their own chat only) ──
let devicePendingVoice = new Map() // phone -> { list, createdAt }

function groupByMinute(items) {
  const groups = []
  for (const it of items) {
    const stamp = formatPkt(it.ts)
    const last = groups[groups.length - 1]
    if (last && last.stamp === stamp) last.lines.push(it.line)
    else groups.push({ stamp, lines: [it.line] })
  }
  return groups
}

async function cmdDeviceShowNow(sock, m, phone) {
  const jid = m.key.remoteJid
  const rows = (await deviceGetAll(phone)).filter((r) => r.chat_kind === 'private' || r.reason)
  if (!rows.length) {
    await sock.sendMessage(jid, { text: 'Nothing recorded yet.' }, { quoted: m })
    return
  }
  const voices = []
  const byPerson = new Map()
  const order = []
  for (const r of rows) {
    const key = r.sender_jid
    let b = byPerson.get(key)
    if (!b) { b = { name: r.sender_name, items: [] }; byPerson.set(key, b); order.push(b) }
    let line = r.type === 'voice'
      ? (r.media_path && fs.existsSync(r.media_path) ? `🎤 Voice note → +YesVoice${(voices.push({ ...r }), voices.length)}` : '🎤 Voice note (file no longer stored)')
      : r.type === 'viewonce' ? `📷 ${r.content}` : r.content
    if (r.deleted) line += '  (Deleted Message)'
    b.items.push({ ts: r.timestamp, line })
  }
  devicePendingVoice.set(phone, { list: voices, createdAt: Date.now() })

  const blocks = order.map((b, i) => {
    const groups = groupByMinute(b.items)
    const parts = groups.map((g) => { const [f, ...rest] = g.lines; return [`${f} [ ${g.stamp} ]`, ...rest].join('\n') })
    return `\`[${i + 1}] ${b.name}\`\n\n${parts.join('\n\n')}`
  })
  const body = `*📝 YOUR MESSAGES:*\n\n${blocks.join('\n\n                    ──────────\n\n')}\n${SEPARATOR}`
  for (const chunk of body.match(/[\s\S]{1,3800}/g) || [body]) {
    await sock.sendMessage(jid, { text: chunk }, { quoted: m })
  }
}

async function cmdDeviceYesVoice(sock, m, phone, cmdRaw) {
  const jid = m.key.remoteJid
  const match = /^\+yesvoice(\d+)$/i.exec(cmdRaw)
  const state = devicePendingVoice.get(phone)
  if (!match || !state) return sock.sendMessage(jid, { text: '⚠️ Send +ShowNow first.' }, { quoted: m })
  const N = parseInt(match[1], 10)
  const v = state.list[N - 1]
  if (!v) return sock.sendMessage(jid, { text: `No voice #${N}.` }, { quoted: m })
  if (!v.media_path || !fs.existsSync(v.media_path)) return sock.sendMessage(jid, { text: 'That file is no longer stored.' }, { quoted: m })
  await sock.sendMessage(jid, { audio: fs.readFileSync(v.media_path), mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: m })
}

async function handleDeviceCommand(phone, sock, m, text) {
  const jid = m.key.remoteJid
  const tokens = text.trim().split(/\s+/)
  const cmd = tokens[0].toLowerCase()
  const args = tokens.slice(1)
  const reply = (t) => sock.sendMessage(jid, { text: t }, { quoted: m })

  if (cmd === '+help') {
    return reply(
      '*`👾 Your Asad MD Linked Device 👾`*\n\n' +
      '• `+ShowNow` — your saved messages & voices\n' +
      '• `+YesVoice<N>` — send a saved voice note\n' +
      '• `+SetName <name>` — save group messages that mention this name\n' +
      '• `+SaveAllGroupChats` — save every message in your groups\n' +
      '• `+StopGroupChats` — only save messages that mention you (default)\n' +
      '• `+DeleteAllChat` / `+DeleteAllVoice confirm` — erase your saved data\n' +
      '• `+Help` — this list\n\n' +
      'Only you can see this. Channels are never saved.'
    )
  }
  if (cmd === '+shownow') return cmdDeviceShowNow(sock, m, phone)
  if (cmd.startsWith('+yesvoice')) return cmdDeviceYesVoice(sock, m, phone, cmd)
  if (cmd === '+setname') {
    const name = args.join(' ').trim()
    if (!name) return reply('⚠️ Usage: +SetName Ayyan')
    await setDeviceName(phone, name.slice(0, 40))
    return reply(`✅ Group messages mentioning "${name}" (or replies to you) will now be saved.`)
  }
  if (cmd === '+saveallgroupchats') {
    await setDeviceSaveAll(phone, true)
    return reply('✅ All your group messages and voices will now be saved.')
  }
  if (cmd === '+stopgroupchats') {
    await setDeviceSaveAll(phone, false)
    return reply('✅ Back to saving only messages that mention or reply to you in groups.')
  }
  if (cmd === '+deleteallchat' && args[0]?.toLowerCase() === 'confirm') {
    await deviceWipeMessages(phone)
    return reply('🗑️ All your saved messages have been deleted.')
  }
  if (cmd === '+deleteallchat') return reply('⚠️ This deletes everything saved for you. Send +DeleteAllChat confirm.')
  if (cmd === '+deleteallvoice' && args[0]?.toLowerCase() === 'confirm') {
    const rows = await deviceGetAll(phone)
    for (const r of rows) if (r.type === 'voice' && r.media_path) { try { fs.unlinkSync(r.media_path) } catch { /* ignore */ } }
    return reply('🗑️ Your saved voice files have been deleted.')
  }
  if (cmd === '+deleteallvoice') return reply('⚠️ This deletes your voice files. Send +DeleteAllVoice confirm.')
  // anything else: silently ignored, same as Asad's own strict-elsewhere rule
}
