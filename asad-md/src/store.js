// src/store.js — Neon Postgres version
//
// Same public API as the SQLite version, but backed by Postgres.
// Schema auto-creates on first import.
// Requires DATABASE_URL in the environment.

import pg from 'pg'
const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.error('[store] DATABASE_URL env var is required')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
})

const TYPES = new Set(['text', 'voice', 'photo', 'video', 'sticker', 'gif', 'viewonce', 'other'])

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
    CREATE INDEX IF NOT EXISTS idx_asadmd_messages_timestamp ON asadmd_messages (timestamp);
    CREATE INDEX IF NOT EXISTS idx_asadmd_messages_sender    ON asadmd_messages (sender_jid);
    CREATE INDEX IF NOT EXISTS idx_asadmd_messages_deleted   ON asadmd_messages (deleted, deleted_at);
  `)
  schemaReady = true
}

function row(r) {
  return r
    ? {
        id: r.id,
        chat_jid: r.chat_jid,
        sender_jid: r.sender_jid,
        sender_name: r.sender_name,
        timestamp: Number(r.timestamp),
        type: r.type,
        content: r.content,
        media_path: r.media_path,
        deleted: Number(r.deleted),
        deleted_at: r.deleted_at != null ? Number(r.deleted_at) : null,
      }
    : null
}

export const store = {
  async saveMessage(msg) {
    await ensureSchema()
    if (!msg || !msg.id) return null
    const type = TYPES.has(msg.type) ? msg.type : 'other'
    const isDeleted = msg.deleted ? 1 : 0
    await pool.query(
      `INSERT INTO asadmd_messages (id, chat_jid, sender_jid, sender_name, timestamp, type, content, media_path, deleted, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         sender_name = COALESCE(EXCLUDED.sender_name, asadmd_messages.sender_name),
         type        = CASE WHEN EXCLUDED.type = 'other' THEN asadmd_messages.type ELSE EXCLUDED.type END,
         content     = COALESCE(EXCLUDED.content, asadmd_messages.content),
         media_path  = COALESCE(EXCLUDED.media_path, asadmd_messages.media_path)`,
      [
        String(msg.id),
        str(msg.chat_jid),
        str(msg.sender_jid),
        str(msg.sender_name),
        toMs(msg.timestamp),
        type,
        str(msg.content),
        str(msg.media_path),
        isDeleted,
        isDeleted ? toMs(msg.deleted_at) : null,
      ]
    )
    const r = await pool.query('SELECT * FROM asadmd_messages WHERE id = $1', [String(msg.id)])
    return row(r.rows[0])
  },

  async getMessageById(id) {
    await ensureSchema()
    if (!id) return null
    const r = await pool.query('SELECT * FROM asadmd_messages WHERE id = $1', [String(id)])
    return row(r.rows[0])
  },

  async markDeleted(id) {
    await ensureSchema()
    if (!id) return null
    await pool.query(
      'UPDATE asadmd_messages SET deleted = 1, deleted_at = $1 WHERE id = $2 AND deleted = 0',
      [Date.now(), String(id)]
    )
    const r = await pool.query('SELECT * FROM asadmd_messages WHERE id = $1', [String(id)])
    return row(r.rows[0])
  },

  async getAll() {
    await ensureSchema()
    const r = await pool.query('SELECT * FROM asadmd_messages ORDER BY timestamp DESC, id DESC')
    return r.rows.map(row)
  },

  async getMessages({ limit = 20, sender } = {}) {
    await ensureSchema()
    const lim = Math.max(1, Math.min(10000, Number(limit) || 20))
    if (sender) {
      const p = `%${sender}%`
      const r = await pool.query(
        'SELECT * FROM asadmd_messages WHERE sender_jid ILIKE $1 OR sender_name ILIKE $1 ORDER BY timestamp DESC, id DESC LIMIT $2',
        [p, lim]
      )
      return r.rows.map(row)
    }
    const r = await pool.query(
      'SELECT * FROM asadmd_messages ORDER BY timestamp DESC, id DESC LIMIT $1',
      [lim]
    )
    return r.rows.map(row)
  },

  async getDeleted(limit = 20) {
    await ensureSchema()
    const lim = Math.max(1, Math.min(10000, Number(limit) || 20))
    const r = await pool.query(
      'SELECT * FROM asadmd_messages WHERE deleted = 1 ORDER BY deleted_at DESC, id DESC LIMIT $1',
      [lim]
    )
    return r.rows.map(row)
  },

  async searchText(keyword, limit = 50) {
    await ensureSchema()
    if (keyword === undefined || keyword === null || String(keyword).trim() === '') return []
    const lim = Math.max(1, Math.min(10000, Number(limit) || 50))
    const r = await pool.query(
      'SELECT * FROM asadmd_messages WHERE content ILIKE $1 ORDER BY timestamp DESC, id DESC LIMIT $2',
      [`%${String(keyword).trim()}%`, lim]
    )
    return r.rows.map(row)
  },

  async stats() {
    await ensureSchema()
    const [total, voice, del, per] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM asadmd_messages'),
      pool.query("SELECT COUNT(*)::int AS n FROM asadmd_messages WHERE type = 'voice'"),
      pool.query('SELECT COUNT(*)::int AS n FROM asadmd_messages WHERE deleted = 1'),
      pool.query(
        `SELECT COALESCE(NULLIF(MAX(sender_name),''), sender_jid, 'unknown') AS name,
                COUNT(*)::int AS count
         FROM asadmd_messages GROUP BY sender_jid ORDER BY count DESC`
      ),
    ])
    return {
      total: total.rows[0].n,
      voice: voice.rows[0].n,
      deleted: del.rows[0].n,
      perSender: per.rows.map((r) => ({ name: r.name, count: r.count })),
    }
  },

  async wipeAll() {
    await ensureSchema()
    const r = await pool.query('DELETE FROM asadmd_messages')
    return r.rowCount
  },
}

export default store
