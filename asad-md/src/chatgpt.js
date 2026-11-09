// src/chatgpt.js — +ChatGPT <question>
// Uses the OpenAI GPT model served by Pollinations (same API/keys as the Flask app).

const API_URL = 'https://gen.pollinations.ai/v1/chat/completions'
const SYSTEM_PROMPT =
  'You are ChatGPT answering inside WhatsApp. Be clear and reasonably concise. ' +
  'Use plain text with WhatsApp formatting only (*bold*, _italic_), no markdown tables or headings.'

// Same key loading as app.py: POLLINATIONS_API_KEY first, then any POLLINATION* var.
function loadKeys() {
  const keys = []
  const primary = (process.env.POLLINATIONS_API_KEY || '').trim()
  if (primary) keys.push(primary)
  for (const [name, val] of Object.entries(process.env)) {
    if (name.startsWith('POLLINATION') && name !== 'POLLINATIONS_API_KEY') {
      const v = String(val || '').trim()
      if (v && !keys.includes(v)) keys.push(v)
    }
  }
  return keys
}

export async function askChatGPT(query) {
  const model = process.env.ASADMD_CHATGPT_MODEL || 'openai'
  const attempts = [...loadKeys(), null] // null = try without a key as a last resort
  let lastErr = 'no response'

  for (const key of attempts) {
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (key) headers.Authorization = `Bearer ${key}`
      const res = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: query },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (res.ok) {
        const data = await res.json()
        const text = data?.choices?.[0]?.message?.content
        if (text && String(text).trim()) return String(text).trim()
        lastErr = 'empty answer'
        continue
      }
      lastErr = `HTTP ${res.status}`
      // key problems / rate limits / server errors: try the next key
      if ([401, 402, 403, 429].includes(res.status) || res.status >= 500) continue
      break
    } catch (e) {
      lastErr = e?.name === 'TimeoutError' ? 'timed out' : String(e?.message || e)
    }
  }
  throw new Error(lastErr)
}

function chunk(text, size = 3800) {
  const out = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size)
    if (cut < size * 0.5) cut = size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

export async function cmdChatGPT(sock, m, text) {
  const jid = m.key.remoteJid
  const query = String(text).replace(/^\+chatgpt\b/i, '').trim()
  if (!query) {
    await sock.sendMessage(jid, { text: '⚠️ Write your question after the command. Send *+ChatGPT help* for instructions.' }, { quoted: m })
    return
  }
  try {
    const answer = await askChatGPT(query)
    const parts = chunk(answer)
    for (let i = 0; i < parts.length; i++) {
      // never start with '+', and mark it as the bot's answer
      await sock.sendMessage(jid, { text: `🤖 ${parts[i]}` }, i === 0 ? { quoted: m } : {})
    }
    console.log(`[cmd] +ChatGPT answered (${answer.length} chars)`)
  } catch (e) {
    console.log(`[cmd] +ChatGPT failed: ${e?.message || e}`)
    await sock.sendMessage(jid, { text: `⚠️ ChatGPT could not answer right now (${e?.message || e}).` }, { quoted: m })
  }
}
