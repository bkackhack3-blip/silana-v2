// @description YouTube Audio Downloader (MP3/M4A)
// @category DOWNLOADER
// @url https://www.youtube.com/

import axios from "axios";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_SIZE = 100 * 1024 * 1024; // 100 MB limit
const CHUNK_SIZE = 5 * 1024 * 1024; // download in 5 MB chunks
const ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

// ---------- Scraper ----------

function resolveVideoID(rawInput) {
    let input = (rawInput || "").trim();
    if (!input) throw new Error("No link provided.");
    if (ID_REGEX.test(input)) return input;
    if (!/^https?:\/\//i.test(input)) input = "https://" + input;

    let u;
    try { u = new URL(input); } catch { throw new Error("Invalid URL."); }

    if (u.hostname === "youtu.be") {
        const id = u.pathname.replace(/^\//, "");
        if (ID_REGEX.test(id)) return id;
    }
    const v = u.searchParams.get("v");
    if (v && ID_REGEX.test(v)) return v;

    for (const p of [/^\/(?:embed|shorts|v|live)\/([a-zA-Z0-9_-]{11})/, /^\/watch\/([a-zA-Z0-9_-]{11})/]) {
        const m = u.pathname.match(p);
        if (m) return m[1];
    }
    throw new Error("Unable to extract the video ID from this link.");
}

function parseMime(rawMime = "") {
    const parts = rawMime.split(";");
    const container = parts[0].trim();
    const codec = (parts[1] || "").trim().replace(/^codecs=/, "").replace(/"/g, "");
    return { container, codec };
}

async function fetchInnertube(videoID) {
    try {
        const { data } = await axios.post(
            "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
            {
                videoId: videoID,
                context: {
                    client: {
                        clientName: "ANDROID_VR",
                        clientVersion: "1.56.21",
                        deviceMake: "Oculus",
                        deviceModel: "Quest 3",
                        hl: "en",
                        gl: "US"
                    }
                }
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": UA,
                    "Origin": "https://www.youtube.com",
                    "Referer": `https://www.youtube.com/watch?v=${videoID}`
                },
                timeout: 25000
            }
        );
        return data;
    } catch (e) {
        console.error("[youtubemp3] innertube error:", e.message);
        return {};
    }
}

async function fetchWebHTML(videoID) {
    const { data } = await axios.get(`https://www.youtube.com/watch?v=${videoID}`, {
        headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
        timeout: 25000,
        responseType: "text"
    });
    const match = String(data).match(/ytInitialPlayerResponse\s*=\s*({.+?});\s*(?:var|<\/script>)/s);
    if (!match) throw new Error("initial_player_response_not_found");
    return JSON.parse(match[1]);
}

async function extractAudio(rawInput) {
    const videoID = resolveVideoID(rawInput);
    const inner = await fetchInnertube(videoID);

    let finalNode;
    let streamStatus = "UNAVAILABLE";
    const audioStreams = [];

    if (inner?.playabilityStatus?.status === "OK") {
        finalNode = inner;
        streamStatus = "OK";

        for (const f of inner.streamingData?.adaptiveFormats || []) {
            if (!f.url) continue;
            const { container, codec } = parseMime(f.mimeType);
            if (!container.startsWith("audio/")) continue;
            audioStreams.push({
                itag: f.itag,
                mimeType: f.mimeType,
                container,
                codec,
                bitrate: f.bitrate || 0,
                contentLength: Number(f.contentLength) || 0,
                directUrl: f.url
            });
        }
    } else {
        try {
            const web = await fetchWebHTML(videoID);
            if (!web?.videoDetails) throw new Error("no details");
            finalNode = web;
            streamStatus = "BOT_CHECK_LOGIN_REQUIRED";
        } catch {
            throw new Error(inner?.playabilityStatus?.reason || "Unable to retrieve video details.");
        }
    }

    const d = finalNode.videoDetails || {};
    const thumbs = d.thumbnail?.thumbnails || [];
    const best = [...thumbs].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];

    return {
        videoId: videoID,
        title: d.title || "Unknown",
        author: d.author || "Unknown",
        canonicalUrl: `https://www.youtube.com/watch?v=${videoID}`,
        durationSeconds: Number(d.lengthSeconds) || 0,
        isLive: !!d.isLiveContent,
        bestThumbnail: best?.url || `https://i.ytimg.com/vi/${videoID}/maxresdefault.jpg`,
        audioStreams,
        streamStatus
    };
}

// ---------- Helpers ----------

function formatDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = n => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatSize(bytes) {
    if (!bytes) return "unknown size";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function pickBestAudio(info) {
    // Prefer m4a (audio/mp4): best compatibility with WhatsApp
    const list = info.audioStreams.filter(a => a.container === "audio/mp4");
    const pool = list.length ? list : info.audioStreams;
    return [...pool].sort((a, b) => b.bitrate - a.bitrate)[0];
}

// Download the audio into a Buffer (chunked, so YouTube does not throttle or block it)
async function downloadBuffer(url, size) {
    const headers = {
        "User-Agent": UA,
        "Origin": "https://www.youtube.com",
        "Referer": "https://www.youtube.com/"
    };

    if (!size) {
        const res = await axios.get(url, { headers, responseType: "arraybuffer", timeout: 120000, maxContentLength: Infinity });
        return Buffer.from(res.data);
    }

    const parts = [];
    for (let start = 0; start < size; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, size - 1);
        const res = await axios.get(url, {
            headers: { ...headers, Range: `bytes=${start}-${end}` },
            responseType: "arraybuffer",
            timeout: 120000,
            maxContentLength: Infinity
        });
        // Server ignored the range and sent the whole file
        if (res.status === 200) return Buffer.from(res.data);
        parts.push(Buffer.from(res.data));
    }
    return Buffer.concat(parts);
}

const guide = (usedPrefix, command) => `🎵 *YouTube Audio Downloader (MP3)*

This feature downloads the audio of a YouTube video and sends it to you as an audio file.

*How to use:*
${usedPrefix + command} <YouTube link>

*Example:*
• ${usedPrefix + command} https://youtu.be/dQw4w9WgXcQ
• ${usedPrefix + command} https://www.youtube.com/watch?v=dQw4w9WgXcQ

*Supported links:*
watch, youtu.be, shorts, embed, live links, or the 11-character video ID.

*Tips:*
• Audio larger than 100 MB cannot be sent.
• The best available audio quality is chosen automatically.
• Live streams are not supported.`;

// ---------- Handler ----------

let handler = async (m, { conn, text, usedPrefix, command }) => {
    const link = (text || "").trim();
    if (!link) return conn.reply(m.chat, guide(usedPrefix, command), m);

    await conn.reply(m.chat, "⏳ Fetching your audio, please wait...", m);

    try {
        const info = await extractAudio(link);

        if (info.isLive) throw new Error("Live streams cannot be downloaded.");
        if (info.streamStatus !== "OK") {
            throw new Error("YouTube blocked direct download links for this video (bot check / login required). Try another video.");
        }

        const audio = pickBestAudio(info);
        if (!audio) throw new Error("No audio stream found.");
        if (audio.contentLength > MAX_SIZE) throw new Error(`Audio is too large (${formatSize(audio.contentLength)}).`);

        const caption = `🎵 *${info.title}*
👤 Channel: ${info.author}
⏱️ Duration: ${formatDuration(info.durationSeconds)}
📦 Size: ${formatSize(audio.contentLength)}
🔗 ${info.canonicalUrl}`;

        // 1) Info card with thumbnail
        await conn.sendMessage(m.chat, { image: { url: info.bestThumbnail }, caption }, { quoted: m });

        // 2) Download the audio and send it
        const buffer = await downloadBuffer(audio.directUrl, audio.contentLength);
        if (!buffer?.length) throw new Error("Downloaded audio is empty.");

        const safeName = info.title.replace(/[\\/:*?"<>|]/g, "").slice(0, 80) || "audio";
        await conn.sendMessage(
            m.chat,
            { audio: buffer, mimetype: "audio/mp4", fileName: `${safeName}.m4a`, ptt: false },
            { quoted: m }
        );
    } catch (e) {
        console.error("[youtubemp3] error:", e);
        await conn.reply(m.chat, `❌ Failed.\n${e.message}`, m);
    }
};

handler.help = handler.command = ["youtubemp3"];

handler.tags = ["downloader"];

handler.limit = false;

export default handler;
  
