# Asad MD: Message Capture (Part 2)

This document describes what the bot archives, what it deliberately ignores, and how to check that capture works.

## What Asad MD archives

Every incoming one-to-one message is saved to the local database.

- **Text** is stored in full. This covers plain messages, replies, and messages with link previews.
- **Captions** on photos and videos are stored as text. The photo or video file itself is not downloaded.
- **Voice notes** are downloaded and saved as .ogg files. The database row points to the file.
- **Everything else** (photos, videos, stickers, GIFs, documents, and so on) is stored as a short labeled placeholder such as "Sent a photo". Nothing is downloaded for these.

If a voice note fails to download, the row is still saved with the content "Voice note (download failed)" and no file path, so the record of it is not lost.

## View-once policy

View-once items are labeled only. They are never downloaded and never stored as text. This applies to view-once photos, videos, and voice notes, and to any caption attached to them. The row records that a view-once item arrived (type viewonce, content "Item sent in view once") and nothing more.

The reason is sender intent: someone who sends view-once has asked for the content not to be kept. The capture order checks for view-once before it looks at captions or audio, so a captioned view-once photo cannot leak its caption into the archive as plain text.

## Inbox-only rule

Only direct chats with other people are archived. By design, the bot skips:

- Group chats (JIDs ending in @g.us)
- Status updates (status@broadcast)
- Messages you sent yourself (fromMe)

Empty envelopes and messages already in the archive are also skipped, so replays never create duplicates.

## Offline-gap limitation

The bot can only archive what it receives while it is running. If it is offline when a message arrives, the message may be missing from the archive, unless WhatsApp replays it when the bot reconnects. Replayed messages are archived like any other.

Deletions have the same limit. If someone deletes a message while the bot is offline, the bot never sees the deletion, so that message will not be marked deleted.

## The two REVOKE paths

When someone deletes a message for everyone, WhatsApp can report it in two ways, and the bot handles both.

1. **Inside an upsert.** The deletion arrives as a new message whose body is a protocol message of type REVOKE, pointing at the original message id. The capture handler spots this and marks the original as deleted.
2. **Through messages.update.** The original message is updated, either with a revoke stub type or with a protocol message attached. The revoke handler covers all three known shapes of this update.

Both paths call the same "mark deleted" operation, so it is harmless if both fire for one deletion. The archived copy is always kept and only flagged as deleted.

## Files it touches

- `./data/asad.db`: the SQLite database holding all message records.
- `./media/voice/<id>.ogg`: downloaded voice notes, one file per message id.

Wiping the database does not delete the voice files in `./media/`. Remove those by hand if you want them gone.

## How to verify it works

Start the bot and confirm the console does not say that handlers.js is "not yet present". Then, from another phone or account, send messages to the linked number and watch the console.

1. **Text.** Send a short message. You should see a line like `[capture] Name → text: your message`.
2. **Voice note.** Send a voice note. You should see `[capture] Name → voice: Voice note`, and a new file should appear in `./media/voice/`.
3. **View-once photo.** Send one with a caption. You should see `[capture] Name → viewonce: Item sent in view once`, with no caption text and no new file.
4. **Delete.** Delete the text message for everyone. You should see `[revoke] message <id> deleted — archived copy kept`, or the `(via upsert)` variant. If the message was never archived, you will see `[revoke] missed deletion for <id> — not in archive` instead.
5. **Group check.** Send a message in a group. Nothing should be logged.
