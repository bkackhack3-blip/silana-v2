import axios from "axios";
import { spawn } from "child_process";

const SUPPORTED_LANGS = {
  ar: "Arabic", en: "English", fr: "French", es: "Spanish", de: "German",
  it: "Italian", pt: "Portuguese", ru: "Russian", tr: "Turkish", id: "Indonesian",
  hi: "Hindi", ja: "Japanese", ko: "Korean", "zh-CN": "Chinese (Simplified)",
  nl: "Dutch", pl: "Polish", sv: "Swedish", ur: "Urdu", fa: "Persian", bn: "Bengali"
};

const MAX_CHUNK = 190; // Google TTS limit is ~200 characters per request

class GoogleTTS {
  constructor() {
    this.baseUrl = "https://translate.google.com/translate_tts";
  }

  // Split long text into chunks without cutting words
  splitText(text) {
    const words = text.replace(/\s+/g, " ").trim().split(" ");
    const chunks = [];
    let current = "";
    for (const word of words) {
      if ((current + " " + word).trim().length > MAX_CHUNK) {
        if (current) chunks.push(current);
        current = word.slice(0, MAX_CHUNK);
      } else {
        current = (current + " " + word).trim();
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  async fetchChunk(text, lang) {
    try {
      const response = await axios.get(this.baseUrl, {
        params: { ie: "UTF-8", tl: lang, q: text, client: "tw-ob" },
        responseType: "arraybuffer",
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
        }
      });
      return Buffer.from(response.data);
    } catch (error) {
      throw new Error(
        error.response?.statusText || error.message || "Failed to fetch TTS audio"
      );
    }
  }

  async generate(text, lang = "en") {
    const chunks = this.splitText(text);
    const buffers = [];
    for (const chunk of chunks) {
      buffers.push(await this.fetchChunk(chunk, lang));
    }
    return Buffer.concat(buffers);
  }
}

// Convert MP3 buffer to OGG/Opus (required by WhatsApp for voice notes)
const toOpus = (buffer) =>
  new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-vn",
      "-c:a", "libopus",
      "-b:a", "48k",
      "-f", "ogg",
      "pipe:1"
    ]);
    const out = [];
    ff.stdout.on("data", (d) => out.push(d));
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0 && out.length
        ? resolve(Buffer.concat(out))
        : reject(new Error("ffmpeg conversion failed"))
    );
    ff.stdin.on("error", () => {});
    ff.stdin.end(buffer);
  });

let handler = async (m, { conn, args, usedPrefix, command }) => {
  const react = (emoji) =>
    conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } }).catch(() => {});

  const guide = `🔊 *GOOGLE TEXT-TO-SPEECH*

Turn any text into a voice message using Google's voice.

*How to use:*
1. Send the command with a language code and your text:
   ${usedPrefix + command} <lang> <text>
2. Or reply to any text message with:
   ${usedPrefix + command} <lang>

*Examples:*
• ${usedPrefix + command} en Hello, how are you today?
• ${usedPrefix + command} ar مرحبا كيف حالك
• ${usedPrefix + command} fr Bonjour tout le monde
• Reply to a message, then send: ${usedPrefix + command} es

*Notes:*
• If you don't write a language code, English (en) is used.
• Long text is supported and will be read in one audio file.

*Language codes:*
${Object.entries(SUPPORTED_LANGS).map(([code, name]) => `${code} = ${name}`).join("\n")}`;

  // Read language + text from args or from the quoted message
  let lang = "ar";
  let text = "";

  const first = args[0];
  const matchedLang = first
    ? Object.keys(SUPPORTED_LANGS).find((c) => c.toLowerCase() === first.toLowerCase())
    : null;

  if (matchedLang) {
    lang = matchedLang;
    text = args.slice(1).join(" ").trim();
  } else {
    text = args.join(" ").trim();
  }

  if (!text && m.quoted) {
    text = (m.quoted.text || m.quoted.caption || m.quoted.msg?.caption || "").trim();
  }

  if (!text) return m.reply(guide);

  if (text.length > 1000) {
    return m.reply("❌ Text is too long. Please keep it under 1000 characters.");
  }

  try {
    await react("⏳");
    const tts = new GoogleTTS();
    const mp3 = await tts.generate(text, lang);

    // Try a real voice note first, fall back to a normal MP3 audio file
    try {
      const opus = await toOpus(mp3);
      await conn.sendMessage(
        m.chat,
        { audio: opus, mimetype: "audio/ogg; codecs=opus", ptt: true },
        { quoted: m }
      );
    } catch {
      await conn.sendMessage(
        m.chat,
        { audio: mp3, mimetype: "audio/mpeg", ptt: false },
        { quoted: m }
      );
    }

    await react("✅");
  } catch (error) {
    await react("❌");
    m.reply(`❌ Failed to generate audio.\n${error.message}`);
  }
};

handler.help = handler.command = ["tts", "googletts"];
handler.tags = ["tools"];
handler.limit = false;

export default handler;
