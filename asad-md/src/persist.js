// src/persist.js — shared helpers for the "local first, Postgres later" storage.
//
// Idea: the bot keeps everything it needs in memory and in small files under
// ./data (so it keeps working and saving when Postgres is down or out of
// quota). Postgres is a lazy backup: changes are sent in batches every
// ASADMD_DB_FLUSH_SECONDS (default 900 = 15 min), which also lets a free Neon
// database go to sleep between batches instead of burning its compute hours.
//
// ./data lives on Render's disk: it survives crashes/restarts of the bot
// process, but NOT a redeploy (the shutdown hook below flushes first).

import fs from 'node:fs'
import path from 'node:path'

export const DATA_DIR = path.join(process.cwd(), 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const envSec = Number(process.env.ASADMD_DB_FLUSH_SECONDS)
export const FLUSH_MS = (Number.isFinite(envSec) && envSec >= 30 ? envSec : 900) * 1000
export const RETRY_MS = 2 * 60 * 1000 // retry delay while Postgres is unreachable

export function readJson(name, fallback = null) {
  try {
    const p = path.join(DATA_DIR, name)
    if (!fs.existsSync(p)) return fallback
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    console.log(`[persist] could not read ${name}: ${e?.message || e}`)
    return fallback
  }
}

// atomic write: temp file + rename, so a crash never leaves a half-written file
export function writeJson(name, obj) {
  const p = path.join(DATA_DIR, name)
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj))
  fs.renameSync(tmp, p)
}

export function removeFile(name) {
  try {
    fs.rmSync(path.join(DATA_DIR, name), { force: true })
  } catch {
    /* ignore */
  }
}

const lastLogged = new Map()
export function throttledLog(key, message, everyMs = 5 * 60 * 1000) {
  const now = Date.now()
  if (now - (lastLogged.get(key) || 0) >= everyMs) {
    lastLogged.set(key, now)
    console.log(message)
  }
}

// debounce helper: returns a function that runs fn at most once per `ms`
export function debounced(fn, ms) {
  let t = null
  return () => {
    if (t) return
    t = setTimeout(() => {
      t = null
      try {
        fn()
      } catch (e) {
        console.log(`[persist] write failed: ${e?.message || e}`)
      }
    }, ms)
  }
}

// ─── flush everything on shutdown (Render sends SIGTERM on redeploy) ───
const flushers = new Map()
export function registerFlusher(name, fn) {
  flushers.set(name, fn)
}

export async function flushAll() {
  for (const [name, fn] of flushers) {
    try {
      await fn()
    } catch (e) {
      console.log(`[persist] flush ${name} failed: ${e?.message || e}`)
    }
  }
}

let installed = false
export function installShutdownFlush() {
  if (installed) return
  installed = true
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      console.log(`\n[Asad MD] ${sig} received — saving to the database before exit…`)
      await Promise.race([flushAll(), new Promise((r) => setTimeout(r, 20_000))])
      process.exit(0)
    })
  }
}
