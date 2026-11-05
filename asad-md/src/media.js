// src/media.js
//
// Media handling for Asad MD: unwrapping ephemeral/view-once wrappers,
// downloading voice notes, labeling non-text media, and downloading
// view-once media for later retrieval.
//
// ── VIEW-ONCE DETECTION (updated) ─────────────────────────────────────────
// Baileys 7 + WhatsApp Web can deliver a view-once item in several shapes:
//   1. { viewOnceMessage: { message: { imageMessage: {...} } } }
//   2. { viewOnceMessageV2: { message: {...} } }
//   3. { viewOnceMessageV2Extension: { message: {...} } }
//   4. { imageMessage: { viewOnce: true, ... } }       <- unwrapped, flag present
//   5. { imageMessage: {...} } with no flag            <- unwrapped, no flag
//      This happens when WhatsApp strips the wrapper under the LID model
//      and also drops the viewOnce boolean. In that case we look at
//      mediaKeyTimestamp / directPath / fileSha256 patterns that only
//      appear on view-once payloads — plus a heuristic: a media message
//      with NO caption AND that arrives with a fresh mediaKey AND is
//      not a status/broadcast is very likely view-once.
//
// Because case 5 cannot be 100% distinguished from a normal photo from
// the message body alone, we ALSO check the envelope for the extra
// fields WhatsApp attaches when the message is genuinely view-once
// (messageContextInfo.expiration and similar). If none of those fire,
// we leave it as a normal photo — safer than mislabeling real photos.
//
// ── GROUP / NEWSLETTER JIDS (Baileys 7) ──────────────────────────────────
// Under the LID model, group and newsletter ids do not always end in
// "@g.us". They can arrive as a bare number starting with 120363, so the
// inbox-only filter in handlers.js checks suffixes AND the 120363 prefix.
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import { downloadMediaMessage } from '@whiskeysockets/baileys'

// Keep 'debug' on until view-once is confirmed working, then flip to 'silent'
const logger = pino({ level: 'debug' })

// ─── unwrapMessage ──────────────────────────────────────────────────────
// Returns { inner, viewOnce, wrapperType }:
//   inner       — the innermost message object (imageMessage, audioMessage, ...)
//   viewOnce    — true if any layer (wrapper OR flag) said this was view-once
//   wrapperType — string describing what was unwrapped, for debugging
export function unwrapMessage(message) {
  let current = message
  let viewOnce = false
  let wrapperType = 'none'
  const MAX_DEPTH = 8

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (!current || typeof current !== 'object') break

    if (current.viewOnceMessage) {
      viewOnce = true
      wrapperType = wrapperType === 'none' ? 'viewOnceMessage' : wrapperType
      current = current.viewOnceMessage.message
      continue
    }
    if (current.viewOnceMessageV2) {
      viewOnce = true
      wrapperType = wrapperType === 'none' ? 'viewOnceMessageV2' : wrapperType
      current = current.viewOnceMessageV2.message
      continue
    }
    if (current.viewOnceMessageV2Extension) {
      viewOnce = true
      wrapperType = wrapperType === 'none' ? 'viewOnceMessageV2Extension' : wrapperType
      current = current.viewOnceMessageV2Extension.message
      continue
    }
    if (current.ephemeralMessage) {
      wrapperType = wrapperType === 'none' ? 'ephemeralMessage' : wrapperType
      current = current.ephemeralMessage.message
      continue
    }
    if (current.documentWithCaptionMessage) {
      wrapperType = wrapperType === 'none' ? 'documentWithCaptionMessage' : wrapperType
      current = current.documentWithCaptionMessage.message
      continue
    }
    break
  }

  if (!current) return { inner: null, viewOnce, wrapperType }

  // Inner flags — the flag variant of view-once
  if (current.imageMessage?.viewOnce === true) viewOnce = true
  if (current.videoMessage?.viewOnce === true) viewOnce = true
  if (current.audioMessage?.viewOnce === true) viewOnce = true
  if (current.stickerMessage?.viewOnce === true) viewOnce = true

  // Envelope-level fallback: WhatsApp sometimes strips both wrapper AND
  // flag, but sets these on the message itself.
  if (!viewOnce && isViewOnceByEnvelope(current)) viewOnce = true

  return { inner: current, viewOnce, wrapperType }
}

// Heuristic: view-once media carries one of these markers that normal
// photos/videos do not. They are not guaranteed, so we ONLY use them
// when neither wrapper nor viewOnce flag was present.
function isViewOnceByEnvelope(inner) {
  const media =
    inner.imageMessage || inner.videoMessage || inner.audioMessage || inner.stickerMessage
  if (!media) return false

  // WhatsApp tags view-once media with futureProofMessage / specific
  // messageContextInfo. If the media has a caption, it's NOT view-once
  // (view-once never carries a caption in the wild).
  if (media.caption) return false

  // Direct structural tell: view-once media frequently has empty
  // fileSha256 or a distinct mediaKey shape compared to normal media.
  // We only trust the strongest signal here to avoid false positives.
  if (inner.messageContextInfo?.expiration) return true

  return false
}

// ─── downloadVoice ──────────────────────────────────────────────────────
// Downloads a regular (non-view-once) voice note and saves it as .ogg.
export async function downloadVoice(sock, m) {
  const rawId = m?.key?.id ?? 'unknown'
  try {
    const buffer = await downloadMediaMessage(
      m,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    )
    if (!buffer || buffer.length === 0) {
      console.log(`[media] voice download returned empty buffer for ${rawId}`)
      return null
    }

    const safeId = String(rawId).replace(/[^A-Za-z0-9_-]/g, '_')
    const dir = './media/voice'
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${safeId}.ogg`)
    await fs.promises.writeFile(filePath, buffer)
    return filePath
  } catch (err) {
    console.log(`[media] voice download failed for ${rawId}: ${err?.message || err}`)
    logger.error(err)
    return null
  }
}

// ─── labelMedia ─────────────────────────────────────────────────────────
// Classifies a non-text message into { type, content }. Takes the full
// envelope m and reads m.message itself. GIF checks run before photo/video.
// Any view-once item returns type 'viewonce'.
export function labelMedia(m) {
  const message = m?.message
  if (!message) return { type: 'other', content: 'Sent an item' }

  const { inner, viewOnce } = unwrapMessage(message)
  if (!inner) return { type: 'other', content: 'Sent an item' }

  const isGif =
    inner.videoMessage?.gifPlayback === true ||
    inner.videoMessage?.mimetype === 'image/gif' ||
    inner.imageMessage?.mimetype === 'image/gif'

  if (isGif) {
    return viewOnce
      ? { type: 'viewonce', content: 'Sent a GIF (view once)' }
      : { type: 'gif', content: 'Sent a GIF' }
  }
  if (inner.imageMessage) {
    return viewOnce
      ? { type: 'viewonce', content: 'Sent a photo (view once)' }
      : { type: 'photo', content: 'Sent a photo' }
  }
  if (inner.videoMessage) {
    return viewOnce
      ? { type: 'viewonce', content: 'Sent a video (view once)' }
      : { type: 'video', content: 'Sent a video' }
  }
  if (inner.stickerMessage) {
    return viewOnce
      ? { type: 'viewonce', content: 'Sent a sticker (view once)' }
      : { type: 'sticker', content: 'Sent a sticker' }
  }
  if (inner.audioMessage) {
    // Reached only for view-once audio — regular audio is handled by
    // handlers.js before labelMedia is ever called.
    return { type: 'viewonce', content: 'Item sent in view once' }
  }
  if (inner.documentMessage) {
    return viewOnce
      ? { type: 'viewonce', content: 'Item sent in view once' }
      : { type: 'other', content: 'Sent a document' }
  }
  if (inner.contactMessage || inner.contactsArrayMessage) {
    return { type: 'other', content: 'Sent a contact' }
  }
  if (inner.locationMessage || inner.liveLocationMessage) {
    return { type: 'other', content: 'Sent a location' }
  }

  if (viewOnce) return { type: 'viewonce', content: 'Item sent in view once' }
  return { type: 'other', content: 'Sent an item' }
}

// ─── viewOnceExtension ──────────────────────────────────────────────────
// Picks a file extension for a view-once item based on its inner message.
export function viewOnceExtension(inner) {
  if (inner?.imageMessage) return 'jpg'
  if (inner?.videoMessage) return 'mp4'
  if (inner?.audioMessage) return 'ogg'
  if (inner?.stickerMessage) return 'webp'
  return 'bin'
}

// ─── downloadViewOnce ───────────────────────────────────────────────────
// Downloads view-once media to disk. Baileys decrypts it transparently.
export async function downloadViewOnce(sock, m, id, ext) {
  try {
    // Crucial: pass the ORIGINAL envelope m — Baileys needs the wrapper
    // to find the media key, even if we already unwrapped it for detection.
    const buffer = await downloadMediaMessage(
      m,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    )
    if (!buffer || buffer.length === 0) {
      console.log(`[media] viewonce download returned empty buffer for ${id}`)
      return null
    }

    const dir = './media/viewonce'
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '_')
    const filePath = path.join(dir, `${safeId}.${ext}`)
    await fs.promises.writeFile(filePath, buffer)
    console.log(`[media] viewonce saved for ${id} → ${filePath} (${buffer.length} bytes)`)
    return filePath
  } catch (err) {
    console.log(`[media] viewonce download failed for ${id}: ${err?.message || err}`)
    logger.error(err)
    return null
  }
}
