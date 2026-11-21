// src/auth-store.js
//
// Baileys auth state (login keys), "local first, Postgres later":
//
//   • everything lives in memory and in ./data/auth-mirror.json, so the bot
//     keeps decrypting messages even when Postgres is down or out of quota
//   • changes are copied to Neon in batches (persist.js: every ~15 min, right
//     after pairing, and on shutdown), which lets the free database sleep
//   • at boot, Postgres is loaded if reachable, otherwise the local mirror
//
//   usePgAuthState()  →  { state, saveCreds, clearAuth }
//
// Table: asadmd_auth(key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at BIGINT)

import pg from 'pg'
import { initAuthCreds, proto } from '@whiskeysockets/baileys'
import {
  FLUSH_MS, RETRY_MS, readJson, writeJson, removeFile, debounced, registerFlusher, throttledLog,
} from './persist.js'

const { Pool } = pg

let pool = null
function getPool() {
  if (pool) return pool
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL env var is required for Postgres auth state')
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  })
  pool.on('error', (e) => throttledLog('auth-pool', `[auth] Postgres connection error: ${e?.message || e}`, 60_000))
  return pool
}

let schemaReady = false
async function ensureSchema() {
  if (schemaReady) return
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS asadmd_auth (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `)
  schemaReady = true
}

const CREDS_KEY = 'creds'
const keyFor = (type, id) => `${type}:${id}`

// Buffers are tagged so they survive JSON (Postgres + the local mirror).
function serialize(value) {
  return JSON.parse(
    JSON.stringify(value, (k, v) => {
      if (v instanceof Uint8Array) return { __buf: Buffer.from(v).toString('base64') }
      if (v && v.type === 'Buffer' && Array.isArray(v.data)) {
        return { __buf: Buffer.from(v.data).toString('base64') }
      }
      return v
    })
  )
}

function deserialize(value) {
  return JSON.parse(JSON.stringify(value), (k, v) => {
    if (v && typeof v === 'object' && typeof v.__buf === 'string') {
      return Buffer.from(v.__buf, 'base64')
    }
    return v
  })
}

// ─── state ────────────────────────────────────────────────────────────
const mem = new Map()    // key -> serialized value (everything)
const dirty = new Map()  // key -> serialized value | null (null = delete) not yet in Postgres
let clearPending = false
let needsReload = false
let dbOk = null
let flushing = false
let flushTimer = null
let flushAt = 0
let lastCredsRegistered = false

function writeMirror() {
  writeJson('auth-mirror.json', {
    entries: Object.fromEntries(mem),
    dirty: Object.fromEntries(dirty),
    clearPending,
  })
}
const saveMirror = debounced(writeMirror, 1500)

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

export async function flush() {
  if (flushing) return
  flushing = true
  try {
    if (dirty.size === 0 && !clearPending && !needsReload) {
      dbOk = dbOk ?? true
      return
    }
    await ensureSchema()
    const p = getPool()
    if (clearPending) {
      await p.query('DELETE FROM asadmd_auth')
      clearPending = false
    }
    const snapshot = [...dirty.entries()]
    const deletes = snapshot.filter(([, v]) => v === null).map(([k]) => k)
    const upserts = snapshot.filter(([, v]) => v !== null)
    if (deletes.length) await p.query('DELETE FROM asadmd_auth WHERE key = ANY($1::text[])', [deletes])
    const CHUNK = 300
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const part = upserts.slice(i, i + CHUNK)
      await p.query(
        `INSERT INTO asadmd_auth (key, value, updated_at)
         SELECT t.k, t.v::jsonb, $3 FROM unnest($1::text[], $2::text[]) AS t(k, v)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [part.map(([k]) => k), part.map(([, v]) => JSON.stringify(v)), Date.now()]
      )
    }
    for (const [k, v] of snapshot) if (dirty.get(k) === v) dirty.delete(k)

    if (needsReload) {
      const r = await p.query('SELECT key, value FROM asadmd_auth')
      for (const x of r.rows) if (!mem.has(x.key)) mem.set(x.key, x.value)
      needsReload = false
    }
    if (dbOk === false) console.log('[auth] Postgres is back — login keys saved')
    dbOk = true
    writeMirror()
  } catch (e) {
    dbOk = false
    throttledLog('auth-flush', `[auth] Postgres unreachable — login keys kept safe locally, retrying (${e?.message || e})`)
  } finally {
    flushing = false
    if (dbOk === false || dirty.size > 0 || clearPending || needsReload) {
      requestFlush(dbOk === false ? RETRY_MS : FLUSH_MS)
    }
  }
}

export async function usePgAuthState() {
  const local = readJson('auth-mirror.json', null)
  let loaded = false
  try {
    await ensureSchema()
    const r = await getPool().query('SELECT key, value FROM asadmd_auth')
    for (const x of r.rows) mem.set(x.key, x.value)
    loaded = true
    dbOk = true
  } catch (e) {
    dbOk = false
    console.log(`[auth] Postgres unavailable at boot (${e?.message || e}) — using the local copy`)
  }

  if (local) {
    if (!loaded) for (const [k, v] of Object.entries(local.entries || {})) mem.set(k, v)
    // unsaved local changes are newer than what Postgres has
    for (const [k, v] of Object.entries(local.dirty || {})) {
      if (v === null) mem.delete(k)
      else mem.set(k, v)
      dirty.set(k, v)
    }
    if (local.clearPending) clearPending = true
  }
  needsReload = !loaded
  console.log(`[auth] ready: ${mem.size} keys (${loaded ? 'from Postgres' : 'from local copy'}), ${dirty.size} waiting for Postgres`)

  const stored = mem.get(CREDS_KEY)
  const creds = stored ? deserialize(stored) : initAuthCreds()
  lastCredsRegistered = Boolean(creds.registered)
  if (dirty.size || clearPending || needsReload) requestFlush(dbOk ? 5_000 : RETRY_MS)
  registerFlusher('auth', flush)

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {}
        for (const id of ids || []) {
          const v = mem.get(keyFor(type, id))
          if (v === undefined) continue
          let val = deserialize(v)
          if (type === 'app-state-sync-key' && val) {
            val = proto.Message.AppStateSyncKeyData.fromObject(val)
          }
          result[id] = val
        }
        return result
      },
      set: async (data) => {
        for (const type of Object.keys(data || {})) {
          const bucket = data[type]
          for (const id of Object.keys(bucket || {})) {
            const k = keyFor(type, id)
            const value = bucket[id]
            if (value === null || value === undefined) {
              mem.delete(k)
              dirty.set(k, null)
            } else {
              const s = serialize(value)
              mem.set(k, s)
              dirty.set(k, s)
            }
          }
        }
        saveMirror()
        requestFlush(FLUSH_MS)
      },
    },
  }

  const saveCreds = async () => {
    const s = serialize(state.creds)
    mem.set(CREDS_KEY, s)
    dirty.set(CREDS_KEY, s)
    saveMirror()
    // right after pairing, save to Postgres quickly (a redeploy must not lose the login)
    if (!lastCredsRegistered && state.creds.registered) {
      lastCredsRegistered = true
      writeMirror()
      requestFlush(2_000)
    } else {
      requestFlush(FLUSH_MS)
    }
  }

  const clearAuth = async () => {
    mem.clear()
    dirty.clear()
    clearPending = true
    needsReload = false
    removeFile('auth-mirror.json')
    writeMirror()
    requestFlush(500)
  }

  return { state, saveCreds, clearAuth }
}

export async function closePgAuth() {
  try {
    await flush()
  } catch {
    /* non-fatal */
  }
  if (pool) {
    try {
      await pool.end()
    } catch {
      /* non-fatal */
    }
    pool = null
    schemaReady = false
  }
}
