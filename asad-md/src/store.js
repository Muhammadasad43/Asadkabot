// src/store.js — message archive: local first, Postgres as a lazy backup.
//
// All reads come from memory, all writes go to memory + ./data/messages.json
// immediately, and are copied to Neon Postgres in batches (see persist.js).
// If Postgres is down or out of quota the bot keeps working and saving; the
// queued rows are sent when the database comes back.

import pg from 'pg'
import {
  FLUSH_MS, RETRY_MS, readJson, writeJson, debounced, registerFlusher, throttledLog,
} from './persist.js'
const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.error('[store] DATABASE_URL env var is required')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
})
pool.on('error', (e) => throttledLog('store-pool', `[store] Postgres connection error: ${e?.message || e}`, 60_000))

const TYPES = new Set(['text', 'voice', 'photo', 'video', 'sticker', 'gif', 'viewonce', 'other', 'call'])

const str = (v) => (v === undefined || v === null ? null : String(v))
const toMs = (ts) => {
  if (ts && typeof ts.toNumber === 'function') ts = ts.toNumber()
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

let schemaReady = false
async function ensureSchema() {
  if (schemaReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asadmd_messages (
      id          TEXT PRIMARY KEY,
      chat_jid    TEXT,
      sender_jid  TEXT,
      sender_name TEXT,
      timestamp   BIGINT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'other',
      content     TEXT,
      media_path  TEXT,
      deleted     INTEGER NOT NULL DEFAULT 0,
      deleted_at  BIGINT
    );
    ALTER TABLE asadmd_messages ADD COLUMN IF NOT EXISTS chat_name TEXT;
    ALTER TABLE asadmd_messages ADD COLUMN IF NOT EXISTS chat_kind TEXT;
    ALTER TABLE asadmd_messages ADD COLUMN IF NOT EXISTS reason    TEXT;
    ALTER TABLE asadmd_messages ADD COLUMN IF NOT EXISTS sender_pn TEXT;
    CREATE INDEX IF NOT EXISTS idx_asadmd_messages_timestamp ON asadmd_messages (timestamp);
    CREATE INDEX IF NOT EXISTS idx_asadmd_messages_sender    ON asadmd_messages (sender_jid);
    CREATE INDEX IF NOT EXISTS idx_asadmd_messages_deleted   ON asadmd_messages (deleted, deleted_at);
  `)
  schemaReady = true
}

function row(r) {
  return {
    id: r.id,
    chat_jid: r.chat_jid ?? null,
    sender_jid: r.sender_jid ?? null,
    sender_name: r.sender_name ?? null,
    timestamp: Number(r.timestamp),
    type: r.type,
    content: r.content ?? null,
    media_path: r.media_path ?? null,
    deleted: Number(r.deleted) || 0,
    deleted_at: r.deleted_at != null ? Number(r.deleted_at) : null,
    chat_name: r.chat_name ?? null,
    chat_kind: r.chat_kind ?? null,
    reason: r.reason ?? null,
    sender_pn: r.sender_pn ?? null,
  }
}

// Same rules as the old SQL "ON CONFLICT DO UPDATE": keep first chat/sender/time,
// fill in missing details, never un-delete.
function mergeRow(old, neu) {
  if (!old) return neu
  return {
    ...old,
    sender_name: neu.sender_name ?? old.sender_name,
    type: neu.type === 'other' ? old.type : neu.type,
    content: neu.content ?? old.content,
    media_path: neu.media_path ?? old.media_path,
    chat_name: neu.chat_name ?? old.chat_name,
    chat_kind: neu.chat_kind ?? old.chat_kind,
    reason: neu.reason ?? old.reason,
    sender_pn: neu.sender_pn ?? old.sender_pn,
    deleted: Math.max(old.deleted, neu.deleted),
    deleted_at: neu.deleted_at ?? old.deleted_at,
  }
}

// ─── state ────────────────────────────────────────────────────────────
const rows = new Map()        // id -> row (everything we know)
const pendingRows = new Map() // id -> row not yet copied to Postgres
let wipePending = false       // a "delete everything" not yet applied in Postgres
let needsReload = false       // Postgres was unreachable at boot: merge it in later
let dbOk = null               // null = unknown, true/false after the last attempt
let flushing = false
let flushTimer = null
let flushAt = 0

const saveLocal = debounced(() => {
  writeJson('messages.json', {
    rows: [...rows.values()],
    pending: [...pendingRows.keys()],
    wipePending,
  })
}, 3000)

function saveLocalNow() {
  writeJson('messages.json', {
    rows: [...rows.values()],
    pending: [...pendingRows.keys()],
    wipePending,
  })
}

function requestFlush(ms) {
  const at = Date.now() + ms
  if (flushTimer && flushAt <= at) return
  if (flushTimer) clearTimeout(flushTimer)
  flushAt = at
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, ms)
}

async function upsertBatch(batch) {
  await pool.query(
    `INSERT INTO asadmd_messages
       (id, chat_jid, sender_jid, sender_name, timestamp, type, content, media_path, deleted, deleted_at, chat_name, chat_kind, reason, sender_pn)
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::text[], $7::text[],
       $8::text[], $9::int[], $10::bigint[], $11::text[], $12::text[], $13::text[], $14::text[])
     ON CONFLICT (id) DO UPDATE SET
       sender_name = COALESCE(EXCLUDED.sender_name, asadmd_messages.sender_name),
       type        = CASE WHEN EXCLUDED.type = 'other' THEN asadmd_messages.type ELSE EXCLUDED.type END,
       content     = COALESCE(EXCLUDED.content, asadmd_messages.content),
       media_path  = COALESCE(EXCLUDED.media_path, asadmd_messages.media_path),
       chat_name   = COALESCE(EXCLUDED.chat_name, asadmd_messages.chat_name),
       chat_kind   = COALESCE(EXCLUDED.chat_kind, asadmd_messages.chat_kind),
       reason      = COALESCE(EXCLUDED.reason, asadmd_messages.reason),
       sender_pn   = COALESCE(EXCLUDED.sender_pn, asadmd_messages.sender_pn),
       deleted     = GREATEST(asadmd_messages.deleted, EXCLUDED.deleted),
       deleted_at  = COALESCE(EXCLUDED.deleted_at, asadmd_messages.deleted_at)`,
    [
      batch.map((r) => r.id), batch.map((r) => r.chat_jid), batch.map((r) => r.sender_jid),
      batch.map((r) => r.sender_name), batch.map((r) => r.timestamp), batch.map((r) => r.type),
      batch.map((r) => r.content), batch.map((r) => r.media_path), batch.map((r) => r.deleted),
      batch.map((r) => r.deleted_at), batch.map((r) => r.chat_name), batch.map((r) => r.chat_kind),
      batch.map((r) => r.reason), batch.map((r) => r.sender_pn),
    ]
  )
}

export async function flush() {
  if (flushing) return
  flushing = true
  try {
    if (!wipePending && pendingRows.size === 0 && !needsReload) {
      dbOk = dbOk ?? true
      return
    }
    await ensureSchema()
    if (wipePending) {
      await pool.query('DELETE FROM asadmd_messages')
      wipePending = false
    }
    const batch = [...pendingRows.entries()]
    for (let i = 0; i < batch.length; i += 200) {
      await upsertBatch(batch.slice(i, i + 200).map(([, r]) => r))
    }
    for (const [id, r] of batch) if (pendingRows.get(id) === r) pendingRows.delete(id)

    if (needsReload) {
      const all = await pool.query('SELECT * FROM asadmd_messages')
      for (const r of all.rows) {
        const dbRow = row(r)
        rows.set(dbRow.id, rows.has(dbRow.id) ? mergeRow(dbRow, rows.get(dbRow.id)) : dbRow)
      }
      needsReload = false
      console.log(`[store] Postgres is back — merged ${all.rows.length} saved messages`)
    }
    if (dbOk === false) console.log('[store] Postgres is back — all queued messages saved')
    dbOk = true
    saveLocalNow()
  } catch (e) {
    dbOk = false
    throttledLog(
      'store-flush',
      `[store] Postgres unreachable — ${pendingRows.size} message(s) kept safe locally, retrying (${e?.message || e})`
    )
  } finally {
    flushing = false
    if (dbOk === false || wipePending || pendingRows.size > 0 || needsReload) {
      requestFlush(dbOk === false ? RETRY_MS : FLUSH_MS)
    }
  }
}

async function init() {
  const local = readJson('messages.json', null)
  let loaded = false
  try {
    await ensureSchema()
    const r = await pool.query('SELECT * FROM asadmd_messages')
    for (const x of r.rows) rows.set(x.id, row(x))
    loaded = true
    dbOk = true
  } catch (e) {
    dbOk = false
    console.log(`[store] Postgres unavailable at boot (${e?.message || e}) — using the local copy`)
  }

  if (local) {
    if (local.wipePending) {
      rows.clear()
      wipePending = true
    }
    const localById = new Map((local.rows || []).map((r) => [r.id, r]))
    if (!loaded) for (const r of localById.values()) rows.set(r.id, r)
    for (const id of local.pending || []) {
      const r = localById.get(id)
      if (!r) continue
      rows.set(id, mergeRow(rows.get(id), r))
      pendingRows.set(id, rows.get(id))
    }
  }
  needsReload = !loaded
  console.log(`[store] ready: ${rows.size} messages in memory, ${pendingRows.size} waiting for Postgres`)
  if (pendingRows.size || wipePending || needsReload) requestFlush(dbOk ? 5_000 : RETRY_MS)
  requestFlush(FLUSH_MS)
}
await init()
registerFlusher('messages', flush)

const sortedAll = () =>
  [...rows.values()].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))

export const store = {
  async saveMessage(msg) {
    if (!msg || !msg.id) return null
    const type = TYPES.has(msg.type) ? msg.type : 'other'
    const isDeleted = msg.deleted ? 1 : 0
    const incoming = {
      id: String(msg.id),
      chat_jid: str(msg.chat_jid),
      sender_jid: str(msg.sender_jid),
      sender_name: str(msg.sender_name),
      timestamp: toMs(msg.timestamp),
      type,
      content: str(msg.content),
      media_path: str(msg.media_path),
      deleted: isDeleted,
      deleted_at: isDeleted ? toMs(msg.deleted_at) : null,
      chat_name: str(msg.chat_name),
      chat_kind: str(msg.chat_kind),
      reason: str(msg.reason),
      sender_pn: str(msg.sender_pn),
    }
    const merged = mergeRow(rows.get(incoming.id), incoming)
    rows.set(merged.id, merged)
    pendingRows.set(merged.id, merged)
    saveLocal()
    requestFlush(pendingRows.size >= 500 ? 1_000 : FLUSH_MS)
    return { ...merged }
  },

  async getNameByJid(jids) {
    const set = new Set((jids || []).filter(Boolean))
    if (!set.size) return null
    let best = null
    for (const r of rows.values()) {
      if (!r.sender_name) continue
      if (!(set.has(r.sender_jid) || set.has(r.chat_jid))) continue
      if (!best || r.timestamp > best.timestamp) best = r
    }
    return best ? best.sender_name : null
  },

  async getMessageById(id) {
    if (!id) return null
    const r = rows.get(String(id))
    return r ? { ...r } : null
  },

  async markDeleted(id) {
    if (!id) return null
    const old = rows.get(String(id))
    if (!old) return null
    if (old.deleted === 0) {
      const upd = { ...old, deleted: 1, deleted_at: Date.now() }
      rows.set(upd.id, upd)
      pendingRows.set(upd.id, upd)
      saveLocal()
      requestFlush(FLUSH_MS)
      return { ...upd }
    }
    return { ...old }
  },

  async getAll() {
    return sortedAll().map((r) => ({ ...r }))
  },

  async getMessages({ limit = 20, sender } = {}) {
    const lim = Math.max(1, Math.min(10000, Number(limit) || 20))
    let list = sortedAll()
    if (sender) {
      const p = String(sender).toLowerCase()
      list = list.filter(
        (r) => String(r.sender_jid || '').toLowerCase().includes(p) || String(r.sender_name || '').toLowerCase().includes(p)
      )
    }
    return list.slice(0, lim).map((r) => ({ ...r }))
  },

  async getDeleted(limit = 20) {
    const lim = Math.max(1, Math.min(10000, Number(limit) || 20))
    return [...rows.values()]
      .filter((r) => r.deleted === 1)
      .sort((a, b) => (b.deleted_at || 0) - (a.deleted_at || 0))
      .slice(0, lim)
      .map((r) => ({ ...r }))
  },

  async searchText(keyword, limit = 50) {
    if (keyword === undefined || keyword === null || String(keyword).trim() === '') return []
    const k = String(keyword).trim().toLowerCase()
    const lim = Math.max(1, Math.min(10000, Number(limit) || 50))
    return sortedAll()
      .filter((r) => String(r.content || '').toLowerCase().includes(k))
      .slice(0, lim)
      .map((r) => ({ ...r }))
  },

  async stats() {
    const all = [...rows.values()]
    const per = new Map()
    for (const r of all) {
      const key = r.sender_jid || 'unknown'
      const e = per.get(key) || { name: r.sender_name || key, count: 0 }
      e.name = r.sender_name || e.name
      e.count += 1
      per.set(key, e)
    }
    return {
      total: all.length,
      voice: all.filter((r) => r.type === 'voice').length,
      deleted: all.filter((r) => r.deleted === 1).length,
      perSender: [...per.values()].sort((a, b) => b.count - a.count),
    }
  },

  async wipeAll() {
    const n = rows.size
    rows.clear()
    pendingRows.clear()
    wipePending = true
    saveLocalNow()
    requestFlush(1_000)
    return n
  },

  // true while Postgres is unreachable or its old history has not been merged in yet
  isDegraded() {
    return dbOk === false || needsReload
  },
  pendingCount() {
    return pendingRows.size
  },
}

export { pool }
export default store
