import axios from "axios";

class MemeGenerator {
  constructor() {
    this.api = "https://api.memegen.link";
    this.chars = {
      " ": "_",
      _: "__",
      "-": "--",
      "\n": "~n",
      "?": "~q",
      "&": "~a",
      "%": "~p",
      "#": "~h",
      "/": "~s",
      "\\": "~b",
      "<": "~l",
      ">": "~g",
      '"': "''"
    };
  }

  encodeText(text) {
    if (!text || !text.trim()) return "_";
    return text
      .trim()
      .split("")
      .map((c) => this.chars[c] || c)
      .join("");
  }

  async getFonts() {
    try {
      const { data } = await axios.get(`${this.api}/fonts`, { timeout: 15000 });
      return data.map((v) => v.id);
    } catch {
      return ["impact", "arial", "helvetica", "comic-sans"];
    }
  }

  async getTemplates() {
    try {
      const { data } = await axios.get(`${this.api}/templates`, { timeout: 15000 });
      return data.map((t) => t.id);
    } catch {
      return ["buzz", "doge", "drake", "fine", "kermit"];
    }
  }

  createCustomUrl(bgUrl, top, bottom, font = null) {
    let url = `${this.api}/images/custom/${this.encodeText(top)}/${this.encodeText(bottom)}.png?background=${encodeURIComponent(bgUrl)}`;
    if (font) url += `&font=${encodeURIComponent(font)}`;
    return url;
  }

  createTemplateUrl(templateId, top, bottom, font = null) {
    let url = `${this.api}/images/${templateId}/${this.encodeText(top)}/${this.encodeText(bottom)}.png`;
    if (font) url += `?font=${encodeURIComponent(font)}`;
    return url;
  }

  async fetchBuffer(imageUrl) {
    const { data } = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 30000
    });
    return Buffer.from(data);
  }
}

let handler = async (m, { conn, args, usedPrefix, command }) => {
  const react = (emoji) =>
    conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } }).catch(() => {});

  const guide = `😂 *MEME GENERATOR*

Create memes from popular templates or from your own image link.

*How to use:*
1. Using a template:
   ${usedPrefix + command} <template> <top text> | <bottom text>
2. Using your own image link:
   ${usedPrefix + command} <image url> <top text> | <bottom text>
3. Choose a font (optional), add at the end:
   --font <font name>

*Browse options:*
• ${usedPrefix + command} templates → list templates
• ${usedPrefix + command} templates <word> → search templates
• ${usedPrefix + command} fonts → list fonts

*Examples:*
• ${usedPrefix + command} drake Studying | Making memes
• ${usedPrefix + command} doge much wow | very meme --font impact
• ${usedPrefix + command} https://example.com/photo.jpg When the bot works | First try

*Notes:*
• Use *|* to separate the top and bottom text.
• You can write only the top text and leave the bottom empty.
• The image link must be a direct public link (jpg, png, etc.).`;

  const memeGen = new MemeGenerator();

  if (!args.length) return m.reply(guide);

  const action = args[0].toLowerCase();

  try {
    // ---- Browse fonts ----
    if (action === "fonts") {
      await react("⏳");
      const fonts = await memeGen.getFonts();
      await react("✅");
      return m.reply(`🔤 *Available fonts (${fonts.length})*\n\n${fonts.join(", ")}\n\nUse: ${usedPrefix + command} <template> top | bottom --font <name>`);
    }

    // ---- Browse templates ----
    if (action === "templates" || action === "template") {
      await react("⏳");
      const keyword = args.slice(1).join(" ").trim().toLowerCase();
      let templates = await memeGen.getTemplates();
      if (keyword) templates = templates.filter((t) => t.includes(keyword));
      if (!templates.length) {
        await react("❌");
        return m.reply(`❌ No templates found for "${keyword}".`);
      }
      const total = templates.length;
      const shown = templates.slice(0, 80);
      await react("✅");
      return m.reply(
        `🖼️ *Templates${keyword ? ` matching "${keyword}"` : ""} (${total})*\n\n${shown.join(", ")}${total > shown.length ? `\n\n...and ${total - shown.length} more. Search with: ${usedPrefix + command} templates <word>` : ""}`
      );
    }

    // ---- Generate a meme ----
    let input = args.join(" ");

    // Extract optional --font
    let font = null;
    const fontMatch = input.match(/--font\s+(\S+)/i);
    if (fontMatch) {
      font = fontMatch[1];
      input = input.replace(fontMatch[0], "").trim();
    }

    // First word = template id or image URL, rest = texts
    const firstSpace = input.search(/\s/);
    const source = firstSpace === -1 ? input : input.slice(0, firstSpace);
    const textPart = firstSpace === -1 ? "" : input.slice(firstSpace + 1);

    const [topRaw = "", ...bottomParts] = textPart.split("|");
    const top = topRaw.trim();
    const bottom = bottomParts.join("|").trim();

    if (!top && !bottom) {
      return m.reply(`❌ Please write some text for the meme.\n\nExample: ${usedPrefix + command} ${source} Top text | Bottom text`);
    }

    await react("⏳");

    let memeUrl;
    if (/^https?:\/\/.+/i.test(source)) {
      memeUrl = memeGen.createCustomUrl(source, top, bottom, font);
    } else {
      const templates = await memeGen.getTemplates();
      const id = source.toLowerCase();
      if (!templates.includes(id)) {
        await react("❌");
        const similar = templates.filter((t) => t.includes(id)).slice(0, 10);
        return m.reply(
          `❌ Template "${source}" was not found.\n${similar.length ? `\nDid you mean: ${similar.join(", ")}\n` : ""}\nSee all templates with: ${usedPrefix + command} templates`
        );
      }
      memeUrl = memeGen.createTemplateUrl(id, top, bottom, font);
    }

    const image = await memeGen.fetchBuffer(memeUrl);

    await conn.sendMessage(
      m.chat,
      { image, caption: "😂 Here is your meme!" },
      { quoted: m }
    );
    await react("✅");
  } catch (error) {
    await react("❌");
    const status = error.response?.status;
    m.reply(
      status === 404 || status === 400
        ? "❌ Could not create the meme. Check that the template name or image link is correct."
        : `❌ Failed to generate the meme.\n${error.message}`
    );
  }
};

handler.help = handler.command = ["memegen"];
handler.tags = ["tools"];
handler.limit = false;

export default handler;
