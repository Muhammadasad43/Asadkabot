// src/settings.js — small persistent settings (currently: the command prefix).
//
// The prefix lives in Postgres (table asadmd_settings) so it survives restarts and
// redeploys. Everything else in the bot still thinks in terms of '+': index.js
// converts "<prefix>Command" into "+Command" before handing it to commands.js,
// and replies are shown with the active prefix through applyPrefix().
//
// Lock-out safety: "+ResetPrefix" is ALWAYS recognised (from your own account),
// whatever the prefix is, and ASADMD_PREFIX can set the first-run default.

import { pool } from './store.js'

export const DEFAULT_PREFIX = '+'

// 1-2 symbols. Not letters/digits/spaces, and not WhatsApp formatting characters
// (* _ ~ `) or '@' (mentions) or '<' '>' (quotes / tags).
const PREFIX_RE = /^[!#$%&+,\-./:;=?^|]{1,2}$/

export function validatePrefix(p) {
  const v = String(p ?? '').trim()
  return PREFIX_RE.test(v) ? v : null
}

let current = validatePrefix(process.env.ASADMD_PREFIX) || DEFAULT_PREFIX
let ready = false

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asadmd_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `)
}

export async function loadSettings() {
  try {
    await ensureTable()
    const r = await pool.query("SELECT value FROM asadmd_settings WHERE key = 'prefix'")
    const saved = validatePrefix(r.rows[0]?.value)
    if (saved) current = saved
    ready = true
    console.log(`[settings] command prefix is "${current}"`)
  } catch (e) {
    console.log(`[settings] could not load (using "${current}"): ${e?.message || e}`)
  }
}

export function getPrefix() {
  return current
}

export async function setPrefix(p) {
  const v = validatePrefix(p)
  if (!v) throw new Error('invalid prefix')
  current = v // switch immediately; persistence below is best-effort
  try {
    if (!ready) { await ensureTable(); ready = true }
    await pool.query(
      `INSERT INTO asadmd_settings (key, value, updated_at) VALUES ('prefix', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [v, Date.now()]
    )
  } catch (e) {
    console.log(`[settings] could not save prefix (active until restart): ${e?.message || e}`)
    return false
  }
  return true
}

// Turn the "+Command" spelling used in help/reply texts into the active prefix.
// Only "+" directly followed by a letter and not preceded by a word char or "+"
// is touched, so "+92300…", "C++" and "+<country code>" stay as they are.
export function applyPrefix(text) {
  if (current === '+' || typeof text !== 'string') return text
  return text.replace(/(?<![\w+])\+(?=[A-Za-z])/g, current)
}

// Incoming text -> canonical "+Command" text, or null if it is not a command.
// A command is "<prefix><letter>…". "+ResetPrefix" always works.
export function toCanonical(text) {
  const t = String(text || '').trim()
  if (/^\+resetprefix$/i.test(t)) return '+ResetPrefix'
  if (!t.startsWith(current)) return null
  const rest = t.slice(current.length)
  if (!/^[A-Za-z]/.test(rest)) return null
  return '+' + rest
}
