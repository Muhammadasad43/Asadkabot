// src/course.js — +TakegroupID and +WebDevCourse
//
// +TakegroupID   (run inside a group) shows the group's numeric ID and saves it
//                as the course group.
// +WebDevCourse  sends every video of the YouTube playlist to that group, one
//                message per video (title + link), first video to last, with a
//                pause between messages. Progress is saved in Postgres, so a
//                restart/redeploy resumes where it stopped.
//
// Videos are sent as LINKS (the videos are not downloaded or re-uploaded).
// The playlist is read with the official YouTube Data API: needs YOUTUBE_API_KEY.
//
// Replies never start with '+'.

import { pool } from './store.js'
import { isSchedulerOnline } from './schedule.js'

const PLAYLIST_ID = process.env.ASADMD_COURSE_PLAYLIST_ID || 'PLu0W_9lII9agq5TrH9XLIKQvv0iaF2X3w'
const DELAY_MS = Number(process.env.ASADMD_COURSE_DELAY_MS) || 8000
const ROW_ID = 'webdev'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isGroupJid = (j) =>
  /@g\.us$/.test(String(j || '')) ||
  (/^120363\d+$/.test(String(j || '').split('@')[0]) && !/@newsletter$/.test(String(j || '')))
const userPart = (j) => String(j || '').split('@')[0].split(':')[0]

// ─── storage ──────────────────────────────────────────────────────────
let schemaReady = false
async function ensureSchema() {
  if (schemaReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asadmd_course (
      id          TEXT PRIMARY KEY,
      group_jid   TEXT,
      title       TEXT,
      videos      JSONB,
      next_index  INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'idle',
      notify_jid  TEXT,
      updated_at  BIGINT
    )
  `)
  schemaReady = true
}

async function load() {
  await ensureSchema()
  const r = await pool.query('SELECT * FROM asadmd_course WHERE id = $1', [ROW_ID])
  const row = r.rows[0]
  if (!row) return null
  if (typeof row.videos === 'string') row.videos = JSON.parse(row.videos)
  return row
}

async function save(patch) {
  await ensureSchema()
  const cols = Object.keys(patch)
  const vals = cols.map((c) => (c === 'videos' && patch[c] != null ? JSON.stringify(patch[c]) : patch[c]))
  const allCols = ['id', ...cols, 'updated_at']
  const params = [ROW_ID, ...vals, Date.now()]
  const ph = allCols.map((_, i) => `$${i + 1}`).join(',')
  const set = [...cols, 'updated_at'].map((c) => `${c} = EXCLUDED.${c}`).join(', ')
  await pool.query(
    `INSERT INTO asadmd_course (${allCols.join(',')}) VALUES (${ph})
     ON CONFLICT (id) DO UPDATE SET ${set}`,
    params
  )
}

// ─── YouTube Data API ─────────────────────────────────────────────────
async function yt(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || `YouTube API HTTP ${res.status}`)
  return data
}

export async function fetchPlaylist(key) {
  const meta = await yt('playlists', { part: 'snippet', id: PLAYLIST_ID, key })
  const snip = meta.items?.[0]?.snippet
  const videos = []
  let pageToken
  do {
    const data = await yt('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: PLAYLIST_ID,
      maxResults: '50',
      pageToken,
      key,
    })
    for (const it of data.items || []) {
      const title = it.snippet?.title || ''
      const id = it.contentDetails?.videoId || it.snippet?.resourceId?.videoId
      if (!id || /^(private|deleted) video$/i.test(title)) continue
      videos.push({ id, title, position: Number(it.snippet?.position ?? videos.length) })
    }
    pageToken = data.nextPageToken
  } while (pageToken)
  videos.sort((a, b) => a.position - b.position) // first video -> last video
  return {
    title: snip ? `${snip.title}${snip.channelTitle ? ` — ${snip.channelTitle}` : ''}` : 'Web Development Course',
    videos: videos.map(({ id, title }) => ({ id, title })),
  }
}

// ─── sender loop ──────────────────────────────────────────────────────
let loopActive = false

function videoText(row, i) {
  const v = row.videos[i]
  return (
    `📚 *Video ${i + 1}/${row.videos.length}*\n${v.title}\n` +
    `https://www.youtube.com/watch?v=${v.id}&list=${PLAYLIST_ID}`
  )
}

async function runLoop(getSock) {
  if (loopActive) return
  loopActive = true
  let failures = 0
  try {
    for (;;) {
      const row = await load()
      if (!row || row.status !== 'running' || !row.group_jid || !row.videos?.length) break
      const sock = getSock()
      if (!isSchedulerOnline() || !sock) {
        await sleep(5000) // wait for the WhatsApp connection
        continue
      }
      const i = row.next_index
      try {
        if (i === 0) {
          await sock.sendMessage(row.group_jid, {
            text: `🎓 *${row.title}*\n${row.videos.length} videos, sent in order from the first to the last.`,
          })
          await sleep(1500)
        }
        await sock.sendMessage(row.group_jid, { text: videoText(row, i) })
        failures = 0
        console.log(`[course] sent video ${i + 1}/${row.videos.length}`)
        if (i + 1 >= row.videos.length) {
          await save({ next_index: i + 1, status: 'done' })
          await sock.sendMessage(row.group_jid, { text: '✅ Course complete. All videos have been sent.' })
          if (row.notify_jid) {
            await sock.sendMessage(row.notify_jid, { text: `✅ Web Dev Course finished: all ${row.videos.length} videos sent.` }).catch(() => {})
          }
          break
        }
        await save({ next_index: i + 1 })
      } catch (e) {
        failures += 1
        console.log(`[course] send error (${failures}/3): ${e?.message || e}`)
        if (failures >= 3) {
          await save({ status: 'paused' })
          if (row.notify_jid) {
            await sock.sendMessage(row.notify_jid, { text: `⚠️ Web Dev Course paused at video ${i + 1} (${e?.message || e}). Send *+WebDevCourse* to continue.` }).catch(() => {})
          }
          break
        }
        await sleep(5000)
        continue
      }
      await sleep(Math.round(DELAY_MS * (0.8 + Math.random() * 0.4)))
    }
  } finally {
    loopActive = false
  }
}

export function resumeCourse(getSock) {
  load()
    .then((row) => {
      if (row?.status === 'running') {
        console.log(`[course] resuming at video ${row.next_index + 1}`)
        runLoop(getSock)
      }
    })
    .catch((e) => console.log(`[course] resume error: ${e?.message || e}`))
}

// ─── commands ─────────────────────────────────────────────────────────
export async function cmdTakeGroupID(sock, m) {
  const jid = m.key.remoteJid
  if (!isGroupJid(jid)) {
    await sock.sendMessage(jid, { text: '⚠️ Run this command inside a group.' }, { quoted: m })
    return
  }
  let name = 'this group'
  try {
    name = (await sock.groupMetadata(jid))?.subject || name
  } catch {
    /* name is optional */
  }
  await save({ group_jid: jid, notify_jid: null })
  await sock.sendMessage(
    jid,
    { text: `🆔 *Group ID:* ${userPart(jid)}\n*Group:* ${name}\n\nSaved as the course group.` },
    { quoted: m }
  )
  console.log(`[course] course group saved: ${jid}`)
}

export async function cmdWebDevCourse(sock, m, args, ctx, getSock) {
  const origin = m.key.remoteJid
  const reply = (text) => sock.sendMessage(origin, { text }, { quoted: m })
  const sub = String(args[0] || '').toLowerCase()
  const row = await load()

  if (sub === 'status') {
    if (!row?.videos?.length) return reply('Course not started yet.')
    return reply(
      `📊 Sent ${Math.min(row.next_index, row.videos.length)}/${row.videos.length} • ${row.status}\nGroup: ${userPart(row.group_jid)}`
    )
  }

  if (sub === 'stop') {
    if (!row || row.status !== 'running') return reply('The course is not running.')
    await save({ status: 'stopped' })
    return reply(`⏹️ Stopped after ${row.next_index}/${row.videos.length} videos. Send *+WebDevCourse* to continue.`)
  }

  // target group: number given > this group > saved group
  let target = null
  if (/^\d{10,}$/.test(args[0] || '')) target = `${args[0]}@g.us`
  else if (isGroupJid(origin)) target = origin
  else target = row?.group_jid || null
  if (!target) return reply('⚠️ No group set. Run *+TakegroupID* inside the group first.')

  if (loopActive && row?.status === 'running') {
    return reply(`▶️ Already running: ${row.next_index}/${row.videos.length} sent.`)
  }

  const restart = sub === 'restart'
  if (row?.status === 'done' && !restart && row.group_jid === target) {
    return reply(`✅ Already completed (${row.videos.length} videos). Send *+WebDevCourse restart* to send it again.`)
  }

  let videos = row?.videos
  let title = row?.title
  let next = row?.next_index || 0
  if (restart || row?.group_jid !== target) next = 0 // new group or restart: from video 1

  if (restart || !videos?.length) {
    const key = (process.env.YOUTUBE_API_KEY || '').trim()
    if (!key) {
      return reply('⚠️ YOUTUBE_API_KEY is not set on the server. Send *+WebDevCourse help* for the setup steps.')
    }
    try {
      const pl = await fetchPlaylist(key)
      if (!pl.videos.length) return reply('⚠️ The playlist returned no videos.')
      videos = pl.videos
      title = pl.title
    } catch (e) {
      return reply(`⚠️ Could not read the playlist (${e?.message || e}).`)
    }
  }

  await save({ group_jid: target, videos, title, next_index: next, status: 'running', notify_jid: ctx?.self ? origin : (ctx?.selfJid || null) })
  const left = videos.length - next
  const mins = Math.ceil((left * DELAY_MS) / 60000)
  await reply(
    `▶️ Course started: ${videos.length} videos${next ? `, continuing from video ${next + 1}` : ''}.\n` +
      `Sending to group ${userPart(target)} about every ${Math.round(DELAY_MS / 1000)} s (~${mins} min).`
  )
  runLoop(getSock) // runs in the background
}
