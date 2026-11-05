// src/auth-store.js
//
// A Neon-Postgres-backed auth state for Baileys 7.
//
// Baileys normally stores its credentials in ./auth/*.json files via
// useMultiFileAuthState(). On a cloud host (Render, Fly, etc.) the
// filesystem is ephemeral — every restart wipes ./auth/ and forces a new
// pairing code, which is impossible to enter on a headless server.
//
// This module implements the same interface Baileys expects:
//   usePgAuthState()  →  { state, saveCreds, clearAuth }
//
// state = { creds, keys: { get(type, ids), set(data) } }
//
// All state is stored as JSON blobs in a single Neon table:
//   asadmd_auth(key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at BIGINT)
//
// The DATABASE_URL environment variable must be set.

import pg from 'pg'
import { initAuthCreds, proto } from '@whiskeysockets/baileys'

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
    max: 5,
    idleTimeoutMillis: 30_000,
  })
  return pool
}

let schemaReady = false
async function ensureSchema() {
  if (schemaReady) return
  const p = getPool()
  await p.query(`
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

async function readValue(key) {
  await ensureSchema()
  const r = await getPool().query('SELECT value FROM asadmd_auth WHERE key = $1', [key])
  return r.rows[0]?.value ?? null
}

async function writeValue(key, value) {
  await ensureSchema()
  await getPool().query(
    `INSERT INTO asadmd_auth (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), Date.now()]
  )
}

async function deleteValue(key) {
  await ensureSchema()
  await getPool().query('DELETE FROM asadmd_auth WHERE key = $1', [key])
}

// Buffer JSON replacer/reviver so Uint8Array round-trips correctly.
// Baileys stores signal keys as Uint8Array, which JSON.stringify would
// turn into plain objects. We tag them and restore on the way back.
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
  return JSON.parse(
    JSON.stringify(value),
    (k, v) => {
      if (v && typeof v === 'object' && typeof v.__buf === 'string') {
        return Buffer.from(v.__buf, 'base64')
      }
      return v
    }
  )
}

export async function usePgAuthState() {
  await ensureSchema()

  const storedCreds = await readValue(CREDS_KEY)
  const creds = storedCreds ? deserialize(storedCreds) : initAuthCreds()

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {}
        if (!ids || ids.length === 0) return result
        await ensureSchema()
        const keys = ids.map((id) => keyFor(type, id))
        const r = await getPool().query(
          'SELECT key, value FROM asadmd_auth WHERE key = ANY($1::text[])',
          [keys]
        )
        const prefix = `${type}:`
        for (const row of r.rows) {
          const id = row.key.slice(prefix.length)
          let val = deserialize(row.value)
          if (type === 'app-state-sync-key' && val) {
            val = proto.Message.AppStateSyncKeyData.fromObject(val)
          }
          result[id] = val
        }
        return result
      },
      set: async (data) => {
        // Batched: one round trip per chunk instead of one per key. Hundreds of
        // pre-keys are written at once and sequential writes to a remote
        // Postgres cause Baileys' "Pre-key upload timeout".
        await ensureSchema()
        const upsertKeys = []
        const upsertVals = []
        const deleteKeys = []
        for (const type of Object.keys(data || {})) {
          const bucket = data[type]
          for (const id of Object.keys(bucket || {})) {
            const value = bucket[id]
            if (value === null || value === undefined) {
              deleteKeys.push(keyFor(type, id))
            } else {
              upsertKeys.push(keyFor(type, id))
              upsertVals.push(JSON.stringify(serialize(value)))
            }
          }
        }
        const p = getPool()
        if (deleteKeys.length) {
          await p.query('DELETE FROM asadmd_auth WHERE key = ANY($1::text[])', [deleteKeys])
        }
        const CHUNK = 300
        for (let i = 0; i < upsertKeys.length; i += CHUNK) {
          await p.query(
            `INSERT INTO asadmd_auth (key, value, updated_at)
             SELECT t.k, t.v::jsonb, $3 FROM unnest($1::text[], $2::text[]) AS t(k, v)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
            [upsertKeys.slice(i, i + CHUNK), upsertVals.slice(i, i + CHUNK), Date.now()]
          )
        }
      },
    },
  }

  const saveCreds = async () => {
    await writeValue(CREDS_KEY, serialize(state.creds))
  }

  const clearAuth = async () => {
    await ensureSchema()
    await getPool().query('DELETE FROM asadmd_auth')
  }

  return { state, saveCreds, clearAuth }
}

export async function closePgAuth() {
  if (pool) {
    await pool.end()
    pool = null
    schemaReady = false
  }
}
