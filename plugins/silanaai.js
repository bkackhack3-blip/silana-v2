// instagram.com/noureddine_ouafy
import fetch from 'node-fetch';

const AFTER_READ_SECONDS = 2; // AI replies disappear this many seconds after being read

const gemini = {
  getNewCookie: async function () {
    const r = await fetch("https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=maGuAc&source-path=%2F&bl=boq_assistant-bard-web-server_20250814.06_p1&f.sid=-7816331052118000090&hl=en-US&_reqid=173780&rt=c", {
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "f.req=%5B%5B%5B%22maGuAc%22%2C%22%5B0%5D%22%2Cnull%2C%22generic%22%5D%5D%5D&",
      method: "POST"
    });
    const cookieHeader = r.headers.get('set-cookie');
    if (!cookieHeader) throw new Error('Failed to retrieve Gemini cookie.');
    return cookieHeader.split(';')[0];
  },

  ask: async function (prompt, previousId = null) {
    if (!prompt?.trim()) throw new Error("Invalid prompt.");

    let resumeArray = null, cookie = null;
    if (previousId) {
      try {
        const j = JSON.parse(atob(previousId));
        resumeArray = j.newResumeArray;
        cookie = j.cookie;
      } catch {
        previousId = null;
      }
    }

    const headers = {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-goog-ext-525001261-jspb": "[1,null,null,null,\"9ec249fc9ad08861\",null,null,null,[4]]",
      "cookie": cookie || await this.getNewCookie()
    };

    const b = [[prompt], ["en-US"], resumeArray];
    const a = [null, JSON.stringify(b)];
    const obj = { "f.req": JSON.stringify(a) };
    const body = new URLSearchParams(obj);

    const response = await fetch(`https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_assistant-bard-web-server_20250729.06_p0&f.sid=4206607810970164620&hl=en-US&_reqid=2813378&rt=c`, {
      headers,
      body,
      method: 'POST'
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const data = await response.text();
    const match = data.matchAll(/^\d+\n(.+?)\n/gm);
    const chunks = Array.from(match, m => m[1]);
    let text, newResumeArray, found = false;

    for (const chunk of chunks.reverse()) {
      try {
        const realArray = JSON.parse(chunk);
        const parse1 = JSON.parse(realArray[0][2]);
        if (parse1?.[4]?.[0]?.[1]?.[0]) {
          newResumeArray = [...parse1[1], parse1[4][0][0]];
          text = parse1[4][0][1][0].replace(/\*\*(.+?)\*\*/g, `*$1*`);
          found = true;
          break;
        }
      } catch {}
    }

    if (!found) throw new Error("Failed to parse Gemini response.");

    const id = btoa(JSON.stringify({ newResumeArray, cookie: headers.cookie }));
    return { text, id };
  }
};

const geminiSessions = {};
const processed = new Set(); // message ids already handled (prevents double replies)
const busy = new Set();      // senders currently waiting for an AI answer

// Same payload as the working "disappear" plugin (no quote fields)
const sendDisappearing = (conn, chat, text, seconds = AFTER_READ_SECONDS) =>
  conn.relayMessage(
    chat,
    {
      extendedTextMessage: {
        text,
        previewType: 0,
        contextInfo: {
          expiration: 0,
          ephemeralSettingTimestamp: Date.now(),
          disappearingMode: { initiator: 0, trigger: 1 },
          afterReadDuration: seconds
        },
        inviteLinkGroupTypeV2: 0
      }
    },
    {}
  );

let handler = async (m, { conn, text, usedPrefix, command }) => {
  const guide = `
📖 *Silana AI Guide*

*What is it?*
When enabled, the bot answers every normal message you send with AI. Each AI reply disappears ${AFTER_READ_SECONDS} second after you read it.

*How to use it:*
• ${usedPrefix + command} on → enable auto AI mode
• ${usedPrefix + command} off → disable auto AI mode
• ${usedPrefix + command} help → show this guide

*Notes:*
• Messages starting with . # / \\ ! are treated as commands and ignored by the AI.
• The timer starts after the message is read, not when it is sent.
• Disappearing messages use undocumented WhatsApp protocol fields, so they may change after WhatsApp updates.
`.trim();

  const arg = (text || '').trim().toLowerCase();
  if (!arg || arg === 'help') return m.reply(guide);

  const phone = m.sender.split('@')[0];
  conn.autoSilanaAI = conn.autoSilanaAI || {};

  if (arg === 'on') {
    conn.autoSilanaAI[phone] = true;
    if (conn.autoGemini) delete conn.autoGemini[phone]; // switch off the old autoai flag if it is still in memory
    m.reply('[ ✓ ] Silana AI mode enabled.');
  } else if (arg === 'off') {
    delete conn.autoSilanaAI[phone];
    delete geminiSessions[m.sender];
    m.reply('[ ✓ ] Silana AI mode disabled.');
  } else {
    m.reply(guide);
  }
};

// 🧠 Auto AI reply logic
handler.before = async (m, { conn }) => {
  conn.autoSilanaAI = conn.autoSilanaAI || {};
  if (m.isBaileys && m.fromMe) return;
  if (!m.text) return;

  const phone = m.sender.split('@')[0];
  if (!conn.autoSilanaAI[phone]) return;
  if (conn.autoGemini) delete conn.autoGemini[phone];
  if (/^[.#/\\!]/.test(m.text)) return;

  // Ignore duplicate events for the same message
  const msgId = m.id || m.key?.id;
  console.log('[silanaai] before() fired for message', msgId);
  if (msgId) {
    if (processed.has(msgId)) return;
    processed.add(msgId);
    if (processed.size > 500) processed.delete(processed.values().next().value);
  }

  // One request per user at a time
  if (busy.has(m.sender)) return;
  busy.add(m.sender);

  try {
    let result;
    try {
      result = await gemini.ask(m.text, geminiSessions[m.sender]);
    } catch (e) {
      // Retry once with a fresh session (old session/cookie may be expired)
      console.error('[silanaai] Gemini error, retrying with new session:', e?.message || e);
      delete geminiSessions[m.sender];
      result = await gemini.ask(m.text, null);
    }
    geminiSessions[m.sender] = result.id;

    try {
      await sendDisappearing(conn, m.chat, result.text);
      console.log('[silanaai] disappearing reply sent');
    } catch (e) {
      // Fallback: normal reply if the disappearing send fails
      console.error('[silanaai] Disappearing send failed:', e?.message || e);
      await conn.reply(m.chat, result.text, m);
    }
  } catch (e) {
    console.error('[silanaai] Error:', e?.message || e);
    m.reply('⚠️ Error while contacting Silana AI. Please try again later.');
  } finally {
    busy.delete(m.sender);
  }
};

handler.command = ['silanaai'];
handler.tags = ['ai'];
handler.help = ['silanaai'];
handler.limit = false;

export default handler;
