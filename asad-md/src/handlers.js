// src/handlers.js — view-once placeholder logging
//
// Two changes vs. previous version:
//   1. Empty-envelope incoming messages (hasMsg=false on a personal chat)
//      are logged as 'viewonce' placeholders with content
//      'Sent a view-once item (content unavailable)'.
//      This is what WhatsApp delivers for view-once media from a linked
//      device when the media key is withheld by the server.
//   2. A new entry point handleUpdateUpsert(sock, updates) is exported for
//      index.js to call on messages.update. If WhatsApp later delivers the
//      real payload for a placeholder row, we upgrade it.

import pino from 'pino'
import { store } from './store.js'
import {
  downloadVoice,
  downloadViewOnce,
  labelMedia,
  unwrapMessage,
  viewOnceExtension,
} from './media.js'

const logger = pino({ level: 'silent' })

const REVOKE_TYPE = 0

function isRevokeType(t) {
  return t === REVOKE_TYPE || t === 'REVOKE'
}

function isNonInboxJid(jid) {
  return (
    jid.endsWith('@g.us') ||
    jid.endsWith('@newsletter') ||
    /^120363/.test(jid) ||
    jid.endsWith('@broadcast') ||
    jid === 'status@broadcast'
  )
}


// ─── Group / channel / community filter ───────────────────────────────
// Non-private chats are only logged when the message concerns ME:
//   mention (@me) · my name · my number · a reply to something I sent.
const userPart = (j) => String(j || '').split('@')[0].split(':')[0]
const NAME_WORDS = (process.env.ASADMD_NAME_KEYWORDS || 'asad')
  .split(',')
  .map((w) => w.trim())
  .filter(Boolean)
const NAME_RE = NAME_WORDS.length
  ? new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${NAME_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`,
      'iu'
    )
  : null

function messageText(inner) {
  return (
    inner?.conversation ||
    inner?.extendedTextMessage?.text ||
    inner?.imageMessage?.caption ||
    inner?.videoMessage?.caption ||
    inner?.documentMessage?.caption ||
    ''
  )
}

function findContextInfo(inner) {
  if (!inner || typeof inner !== 'object') return null
  for (const v of Object.values(inner)) {
    if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo
  }
  return null
}

function numberRegex(pn) {
  if (!pn) return null
  const forms = [`\\+?${pn}`]
  if (pn.startsWith('92') && pn.length >= 11) forms.push(`0?${pn.slice(2)}`) // local Pakistani form
  return new RegExp(`(?<!\\d)(?:${forms.join('|')})(?!\\d)`)
}

// -> array of reasons ('mention' | 'name' | 'number' | 'reply'); empty = don't log
export function whyAboutMe(sock, inner) {
  const pn = userPart(sock.user?.id)
  const mine = new Set([pn, userPart(sock.user?.lid)].filter(Boolean))
  const reasons = []
  const ctx = findContextInfo(inner)

  if (Array.isArray(ctx?.mentionedJid) && ctx.mentionedJid.some((j) => mine.has(userPart(j)))) {
    reasons.push('mention')
  }
  if (ctx?.participant && ctx.quotedMessage && mine.has(userPart(ctx.participant))) {
    reasons.push('reply')
  }
  const text = messageText(inner)
  if (text) {
    if (NAME_RE && NAME_RE.test(text)) reasons.push('name')
    const re = numberRegex(pn)
    if (re && re.test(text.replace(/[\s\-()]/g, ''))) reasons.push('number')
  }
  return reasons
}

// first jid that is a phone-number jid -> digits
function pnOf(...jids) {
  for (const j of jids) {
    if (j && String(j).endsWith('@s.whatsapp.net')) return userPart(j)
  }
  return null
}

const chatNameCache = new Map() // jid -> { name, at }
async function chatNameFor(sock, jid) {
  const hit = chatNameCache.get(jid)
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.name
  let name = null
  try {
    if (!String(jid).endsWith('@newsletter')) {
      name = (await sock.groupMetadata(jid))?.subject || null
    }
  } catch {
    /* no access / rate limited */
  }
  if (!name) name = String(jid).endsWith('@newsletter') ? 'Channel' : 'Group'
  chatNameCache.set(jid, { name, at: Date.now() })
  return name
}

// Logs an empty-envelope incoming message as a view-once placeholder.
// Called when Baileys delivers count=1 but hasMsg=false on a personal chat.
async function recordEmptyEnvelope(m) {
  const id = m.key.id
  const existing = await store.getMessageById(id)
  if (existing) return

  await store.saveMessage({
    id,
    chat_jid: m.key.remoteJid,
    sender_jid: m.key.participant || m.key.remoteJid,
    sender_name: m.pushName || String(m.key.remoteJid).split('@')[0],
    timestamp: Number(m.messageTimestamp) * 1000,
    type: 'viewonce',
    chat_kind: 'private',
    sender_pn: pnOf(m.key.remoteJidAlt, m.key.participantAlt, m.key.remoteJid),
    content: 'Sent a view-once item (content unavailable)',
    media_path: null,
    deleted: 0,
    deleted_at: null,
  })
  console.log(
    `[capture] ${m.pushName || m.key.remoteJid} → viewonce placeholder: ${id.slice(-6)}`
  )
}

// ─── Voice / video call logging ───────────────────────────────────────
// Baileys 'call' events: status = offer | ringing | accept | reject | timeout | terminate
const callState = new Map() // callId -> { isVideo, result }

export async function handleCall(sock, calls) {
  for (const c of calls || []) {
    try {
      if (!c || !c.id) continue
      const peer = c.chatId || c.from
      if (!peer || c.isGroup || String(peer).endsWith('@g.us')) continue

      const prev = callState.get(c.id) || {}
      const isVideo = c.isVideo ?? prev.isVideo ?? false
      let result = prev.result
      switch (c.status) {
        case 'offer':     result = 'Incoming'; break
        case 'accept':    result = 'Answered'; break
        case 'reject':    result = 'Declined'; break
        case 'timeout':   result = 'Missed'; break
        case 'terminate': result = prev.result === 'Answered' ? 'Answered' : 'Missed'; break
        default: break // ringing etc.: no change
      }
      if (!result) result = 'Incoming'
      callState.set(c.id, { isVideo, result })
      if (callState.size > 500) callState.delete(callState.keys().next().value)

      const from = c.from || peer
      const name =
        (await store.getNameByJid([from, peer])) || String(from).split('@')[0]
      const when = c.date ? new Date(c.date).getTime() : Date.now()

      await store.saveMessage({
        id: `call:${c.id}`,
        chat_jid: peer,
        sender_jid: from,
        sender_name: name,
        timestamp: Number.isFinite(when) ? when : Date.now(),
        type: 'call',
        content: `${isVideo ? '🎥 Video call' : '📞 Voice call'} (${result})`,
        media_path: null,
        deleted: 0,
        deleted_at: null,
      })
      console.log(`[call] ${name} → ${isVideo ? 'video' : 'voice'} call: ${result}`)
    } catch (err) {
      console.log(`[call] error: ${err?.message || err}`)
    }
  }
}

export async function handleUpsert(sock, messages, type) {
  for (const m of messages || []) {
    try {
      if (!m || !m.key) continue

      const jid = m.key.remoteJid
      if (!jid) continue
      if (jid === 'status@broadcast') continue
      const nonInbox = isNonInboxJid(jid)
      if (m.key.fromMe === true) continue

      // Empty envelope from a personal contact — this is Baileys 7's
      // signature for a view-once message whose media key is withheld.
      if (!m.message) {
        if (!nonInbox) await recordEmptyEnvelope(m)
        continue
      }

      const existing = await store.getMessageById(m.key.id)
      if (existing) continue

      const proto = m.message?.protocolMessage
      if (proto && isRevokeType(proto.type)) {
        const targetId = proto.key?.id
        if (targetId) {
          const rec = await store.markDeleted(targetId)
          console.log(`[revoke] (via upsert) ${targetId} ${rec ? 'kept' : 'missed'}`)
        }
        continue
      }

      const id = m.key.id
      const chat_jid = jid
      const sender_jid = m.key.participant || jid
      const sender_name = m.pushName || sender_jid.split('@')[0]
      const timestamp = Number(m.messageTimestamp) * 1000

      const { inner, viewOnce } = unwrapMessage(m.message)
      if (!inner) continue

      // Groups / channels / communities: only keep messages that concern me.
      let reasons = []
      if (nonInbox) {
        reasons = whyAboutMe(sock, inner)
        if (reasons.length === 0) continue
      }
      const chat_kind = !nonInbox ? 'private' : jid.endsWith('@newsletter') ? 'channel' : 'group'
      const chat_name = nonInbox ? await chatNameFor(sock, jid) : null
      const sender_pn = pnOf(m.key.participantAlt, m.key.remoteJidAlt, m.key.participant, jid)

      let msgType
      let content
      let media_path = null

      if (viewOnce) {
        const r = labelMedia(m)
        msgType = r.type
        content = r.content
        const ext = viewOnceExtension(inner)
        const p = await downloadViewOnce(sock, m, id, ext)
        if (!p) console.log(`[viewonce] download failed for ${id} — recording placeholder`)
        media_path = p || null
        if (!media_path) {
          content = content + ' (content unavailable)'
        }
      } else if (inner.conversation) {
        msgType = 'text'
        content = inner.conversation
      } else if (inner.extendedTextMessage?.text) {
        msgType = 'text'
        content = inner.extendedTextMessage.text
      } else if (inner.imageMessage?.caption) {
        msgType = 'text'
        content = inner.imageMessage.caption
      } else if (inner.videoMessage?.caption) {
        msgType = 'text'
        content = inner.videoMessage.caption
      } else if (inner.audioMessage) {
        const p = await downloadVoice(sock, m)
        if (p) {
          msgType = 'voice'
          content = 'Voice note'
          media_path = p
        } else {
          msgType = 'voice'
          content = 'Voice note (download failed)'
          media_path = null
        }
      } else {
        const r = labelMedia(m)
        msgType = r.type
        content = r.content
        media_path = null
      }

      await store.saveMessage({
        id,
        chat_jid,
        sender_jid,
        sender_name,
        timestamp,
        type: msgType,
        content,
        media_path: media_path || null,
        deleted: 0,
        deleted_at: null,
        chat_name,
        chat_kind,
        reason: reasons.length ? reasons.join(',') : null,
        sender_pn,
      })

      const savedTag = msgType === 'viewonce' && media_path ? ' [saved]' : ''
      console.log(
        `[capture] ${sender_name}${nonInbox ? ` @ ${chat_name} (${reasons.join('+')})` : ''} → ${msgType}: ${String(content).slice(0, 60)}${savedTag}`
      )
    } catch (err) {
      console.log(`[capture] error: ${err?.message || err}`)
      logger.error(err)
    }
  }
}

// Handles messages.update events. Two responsibilities:
//   1. Revoke detection (unchanged behavior).
//   2. If a placeholder 'viewonce' row got updated with a real payload,
//      upgrade it via handleUpsert's normal path. (Rare, but possible
//      when WhatsApp syncs the payload after the primary device opens it.)
export async function handleRevoke(sock, updates) {
  for (const u of updates || []) {
    try {
      let id = null
      const upd = u?.update

      if (upd && (upd.messageStubType === 1 || upd.messageStubType === 'REVOKE')) {
        id = u.key?.id
      }
      if (!id && upd?.message === null && isRevokeType(upd?.protocolMessage?.type)) {
        id = upd.protocolMessage.key?.id
      }
      if (!id && isRevokeType(upd?.protocolMessage?.type)) {
        id = upd.protocolMessage.key?.id
      }

      if (id) {
        const rec = await store.markDeleted(id)
        if (rec) console.log(`[revoke] message ${id} deleted — archived copy kept`)
        else console.log(`[revoke] missed deletion for ${id} — not in archive`)
        continue
      }

      // Non-revoke update: if it carries a real payload for an existing
      // placeholder row, upgrade that row in place.
      if (upd?.message && u?.key?.id) {
        const existing = await store.getMessageById(u.key.id)
        if (existing && existing.type === 'viewonce' && !existing.media_path) {
          // Treat this as a late-arriving view-once payload
          await handleUpsert(sock, [{ key: u.key, message: upd.message, messageTimestamp: upd.messageTimestamp ?? existing.timestamp / 1000, pushName: existing.sender_name }], 'notify')
          console.log(`[viewonce] late payload upgrade for ${u.key.id}`)
        }
      }
    } catch (err) {
      console.log(`[revoke] error: ${err?.message || err}`)
      logger.error(err)
    }
  }
}
