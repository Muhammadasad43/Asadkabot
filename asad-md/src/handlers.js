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
    content: 'Sent a view-once item (content unavailable)',
    media_path: null,
    deleted: 0,
    deleted_at: null,
  })
  console.log(
    `[capture] ${m.pushName || m.key.remoteJid} → viewonce placeholder: ${id.slice(-6)}`
  )
}

export async function handleUpsert(sock, messages, type) {
  for (const m of messages || []) {
    try {
      if (!m || !m.key) continue

      const jid = m.key.remoteJid
      if (!jid) continue
      if (jid === 'status@broadcast') continue
      if (isNonInboxJid(jid)) continue
      if (m.key.fromMe === true) continue

      // Empty envelope from a personal contact — this is Baileys 7's
      // signature for a view-once message whose media key is withheld.
      if (!m.message) {
        await recordEmptyEnvelope(m)
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
      })

      const savedTag = msgType === 'viewonce' && media_path ? ' [saved]' : ''
      console.log(
        `[capture] ${sender_name} → ${msgType}: ${String(content).slice(0, 60)}${savedTag}`
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
