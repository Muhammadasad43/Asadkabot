// src/index.js
// Asad MD entry point: pairing-code login, reconnect logic, event wiring.
//
// Auth state lives in Postgres (src/auth-store.js) with a local disk
// cache in ./auth-cache/ so short Neon outages do not force a re-pair.
//
// Env vars:
//   DATABASE_URL   required — Neon Postgres connection string
//   ASADMD_PHONE_NUMBER   required on headless hosts; optional on Termux (interactive)
//   PORT           optional — health endpoint port (defaults to 10000)

import fs from 'node:fs';
import { startScheduler, setSchedulerOnline } from './schedule.js';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pino from 'pino';
import express from 'express';
import makeWASocket, {
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
  normalizeMessageContent,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys';

import './store.js'; // side effect: creates schema on first import
import { usePgAuthState, closePgAuth } from './auth-store.js';

const PREFIX = '+';
const MAX_COMMAND_AGE_SECONDS = 120;
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

// Local cache directory — mirrors auth state to disk so a Neon hiccup
// does not force a re-pair. Not authoritative; Postgres is the source
// of truth. Deleted only by manual intervention.
const AUTH_CACHE_DIR = './auth-cache';
fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true });
fs.mkdirSync('./media/voice', { recursive: true });
fs.mkdirSync('./media/viewonce', { recursive: true });

let phoneNumber = null;
let reconnectAttempts = 0;
const seenCommandIds = new Set();

// ---------- local auth cache helpers ----------

function cachePath(key) {
  return path.join(AUTH_CACHE_DIR, key.replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
}

function writeCache(key, value) {
  try {
    fs.writeFileSync(cachePath(key), JSON.stringify(value, (k, v) => {
      if (v instanceof Uint8Array) return { __buf: Buffer.from(v).toString('base64') };
      if (v && v.type === 'Buffer' && Array.isArray(v.data)) {
        return { __buf: Buffer.from(v.data).toString('base64') };
      }
      return v;
    }));
  } catch (e) {
    console.log(`[cache] write ${key} failed: ${e?.message || e}`);
  }
}

function readCache(key) {
  try {
    const p = cachePath(key);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'), (k, v) => {
      if (v && typeof v === 'object' && typeof v.__buf === 'string') {
        return Buffer.from(v.__buf, 'base64');
      }
      return v;
    });
  } catch (e) {
    console.log(`[cache] read ${key} failed: ${e?.message || e}`);
    return null;
  }
}

// Wraps the Postgres auth state with a local cache layer:
//   - reads: try Postgres first, fall back to cache on failure
//   - writes: always write to Postgres, always write to cache
// If Postgres is unreachable at boot but cache has valid creds, the bot
// still connects. saveCreds will retry Neon on the next save.
async function useCachedPgAuthState() {
  let pgState;
  let pgSaveCreds;
  let pgClearAuth;
  let pgAvailable = true;

  try {
    const r = await usePgAuthState();
    pgState = r.state;
    pgSaveCreds = r.saveCreds;
    pgClearAuth = r.clearAuth;
    console.log('[auth] Postgres auth state loaded');
  } catch (e) {
    pgAvailable = false;
    console.log(`[auth] Postgres unavailable at boot: ${e?.message || e}`);
    // fall back entirely to local cache
    const cachedCreds = readCache('creds');
    pgState = {
      creds: cachedCreds || initAuthCreds(),
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            const v = readCache(`${type}:${id}`);
            if (v !== null) out[id] = (type === 'app-state-sync-key' && v) ? proto.Message.AppStateSyncKeyData.fromObject(v) : v;
          }
          return out;
        },
        set: async () => {
          /* local-cache-only mode: writes handled by saveCreds below */
        },
      },
    };
  }

  // Always mirror creds to cache immediately after Postgres save
  const saveCreds = async () => {
    writeCache('creds', pgState.creds);
    if (pgAvailable && pgSaveCreds) {
      try {
        await pgSaveCreds();
      } catch (e) {
        console.log(`[auth] Postgres saveCreds failed (cache safe): ${e?.message || e}`);
      }
    }
  };

  return {
    state: pgState,
    saveCreds,
    clearAuth: async () => {
      // Wipe cache
      try {
        for (const f of fs.readdirSync(AUTH_CACHE_DIR)) fs.unlinkSync(path.join(AUTH_CACHE_DIR, f));
      } catch { /* non-fatal */ }
      if (pgAvailable && pgClearAuth) await pgClearAuth();
    },
  };
}

// ---------- guarded loading of Part 2 / Part 3 modules ----------

const MODULES = {
  handlers: { loader: () => import('./handlers.js'), file: 'handlers.js' },
  commands: { loader: () => import('./commands.js'), file: 'commands.js' },
};

async function callModule(name, fn, ...args) {
  const { loader, file } = MODULES[name];
  if (!fs.existsSync(new URL(`./${file}`, import.meta.url))) {
    console.log(`[Asad MD] ${file} not yet present - skipping ${fn}`);
    return;
  }
  let mod;
  try {
    mod = await loader();
  } catch (e) {
    console.error(`[Asad MD] failed to load ${file}:`, e);
    return;
  }
  if (typeof mod[fn] !== 'function') {
    console.log(`[Asad MD] ${file} has no export "${fn}" - skipping`);
    return;
  }
  try {
    await mod[fn](...args);
  } catch (e) {
    console.error(`[Asad MD] ${fn} threw an error:`, e);
  }
}

// ---------- helpers ----------

async function askPhoneNumber() {
  if (!process.stdin.isTTY) {
    console.error('[Asad MD] First-run login needs ASADMD_PHONE_NUMBER env var or an interactive terminal.');
    process.exit(1);
  }
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question(
        '\nEnter your WhatsApp number with country code, digits only (e.g. 923001234567): '
      );
      const digits = answer.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')) return digits;
      console.log('That does not look right. Use the country code, no "+", no leading 0, 8-15 digits.');
    }
  } finally {
    rl.close();
  }
}

function isSelfChat(sock, key) {
  const mine = new Set(
    [sock.user?.id, sock.user?.lid].filter(Boolean).map((j) => jidNormalizedUser(j))
  );
  return [key.remoteJid, key.remoteJidAlt]
    .filter(Boolean)
    .some((j) => mine.has(jidNormalizedUser(j)));
}

function getText(message) {
  const content = normalizeMessageContent(message);
  return content?.conversation ?? content?.extendedTextMessage?.text ?? '';
}

function toSeconds(ts) {
  if (ts && typeof ts.toNumber === 'function') ts = ts.toNumber();
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? (n > 1e12 ? n / 1000 : n) : 0;
}

async function maybeRunCommand(sock, m) {
  if (!m?.key?.fromMe || !m.message) return;
  if (!isSelfChat(sock, m.key)) return;

  const text = getText(m.message).trim();
  if (!text.startsWith(PREFIX)) return;

  const ts = toSeconds(m.messageTimestamp);
  if (ts && Date.now() / 1000 - ts > MAX_COMMAND_AGE_SECONDS) return;

  if (m.key.id) {
    if (seenCommandIds.has(m.key.id)) return;
    seenCommandIds.add(m.key.id);
    if (seenCommandIds.size > 500) seenCommandIds.delete(seenCommandIds.values().next().value);
  }

  await callModule('commands', 'handleCommand', sock, m, text);
}

// ---------- health endpoint ----------

function startHealthServer() {
  // Embedded mode (inside another service that already owns $PORT):
  // set ASADMD_EMBEDDED=1 to skip the health server.
  if (process.env.ASADMD_EMBEDDED === '1') return;
  const app = express();
  app.get('/health', (req, res) => res.status(200).send('ok'));
  app.get('/', (req, res) => res.status(200).send('Asad MD is running'));
  const port = Number(process.env.ASADMD_HEALTH_PORT || process.env.PORT) || 10000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`[Asad MD] health endpoint on :${port}`);
  });
}

// ---------- main ----------

let currentSock = null;

async function start() {
  const { state, saveCreds } = await useCachedPgAuthState();

  if (!state.creds.registered && !phoneNumber) {
    if (process.env.ASADMD_PHONE_NUMBER) {
      phoneNumber = String(process.env.ASADMD_PHONE_NUMBER).replace(/\D/g, '');
      console.log(`[Asad MD] Using ASADMD_PHONE_NUMBER from env: ${phoneNumber.slice(0, 4)}***`);
    } else if (process.stdin.isTTY) {
      phoneNumber = await askPhoneNumber();
    } else {
      console.error('[Asad MD] Headless environment: set ASADMD_PHONE_NUMBER env var.');
      process.exit(1);
    }
  }

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    console.log('[Asad MD] Could not fetch the latest WhatsApp Web version, using the library default.');
  }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });

  let pairingRequested = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        console.log('\n==============================================');
        console.log(`  PAIRING CODE:  ${pretty}`);
        console.log('==============================================');
        console.log('On your phone:');
        console.log('  WhatsApp -> Linked Devices -> Link with phone number');
        console.log('  (Android: tap the three-dot menu -> Linked devices -> Link a device)');
        console.log('  then choose "Link with phone number instead" and type the code above.\n');
      } catch (e) {
        pairingRequested = false;
        console.error('[Asad MD] Could not request a pairing code:', e?.message ?? e);
      }
    }

    if (connection === 'open') {
      currentSock = sock;
      setSchedulerOnline(true);
      reconnectAttempts = 0;
      const ownJid = jidNormalizedUser(sock.user.id);
      console.log(`[Asad MD] Logged in as ${ownJid}${sock.user.lid ? ` (LID: ${jidNormalizedUser(sock.user.lid)})` : ''}`);
      console.log('[Asad MD] Asad MD is online');
    }

    if (connection === 'close') {
      setSchedulerOnline(false);
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('[Asad MD] close reason:', lastDisconnect?.error?.message);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('\n[Asad MD] Logged out from WhatsApp. Not reconnecting.');
        console.log('Set a fresh ASADMD_PHONE_NUMBER and delete ./auth-cache/, or wipe the asadmd_auth table in Neon, then restart.');
        process.exit(1);
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        console.log('\n[Asad MD] This session was replaced by another connection. Not reconnecting.');
        console.log('Make sure only one copy of the bot is using this auth state, then start again.');
        process.exit(1);
      }

      const delay =
        statusCode === DisconnectReason.restartRequired
          ? 500
          : Math.min(3000 * ++reconnectAttempts, 30000);
      console.log(`[Asad MD] Connection closed (code ${statusCode ?? 'unknown'}). Reconnecting in ${Math.round((delay / 1000) * 10) / 10}s...`);
      setTimeout(() => {
        start().catch((e) => {
          console.error('[Asad MD] Restart failed:', e);
          process.exit(1);
        });
      }, delay);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    await callModule('handlers', 'handleUpsert', sock, messages, type);
    if (type !== 'notify') return;
    for (const m of messages) {
      await maybeRunCommand(sock, m);
    }
  });

  sock.ev.on('call', async (calls) => {
    await callModule('handlers', 'handleCall', sock, calls);
  });

  sock.ev.on('messages.update', async (updates) => {
    await callModule('handlers', 'handleRevoke', sock, updates);
  });
}

process.on('SIGINT', async () => {
  console.log('\n[Asad MD] Shutting down.');
  try { await closePgAuth(); } catch { /* non-fatal */ }
  process.exit(0);
});

process.on('unhandledRejection', (e) => {
  console.error('[Asad MD] Unhandled rejection:', e);
});

startHealthServer();
startScheduler(() => currentSock);
start().catch((e) => {
  console.error('[Asad MD] Fatal error while starting:', e);
  process.exit(1);
});
