// @description YouTube Video Downloader (MP4)
// @category DOWNLOADER
// @url https://www.youtube.com/

import axios from "axios";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_SIZE = 100 * 1024 * 1024; // 100 MB limit
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
    } catch {
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

function buildStream(node, hasAudio) {
    const { container, codec } = parseMime(node.mimeType);
    return {
        itag: node.itag,
        quality: node.qualityLabel || "",
        resolution: node.width && node.height ? `${node.width}x${node.height}` : "",
        mimeType: node.mimeType,
        container,
        codec,
        bitrate: node.bitrate || 0,
        hasAudio,
        contentLength: Number(node.contentLength) || 0,
        directUrl: node.url
    };
}

async function extractYouTube(rawInput) {
    const videoID = resolveVideoID(rawInput);
    const inner = await fetchInnertube(videoID);

    let finalNode;
    let streamStatus = "UNAVAILABLE";
    const audioStreams = [];
    const videoStreams = [];

    if (inner?.playabilityStatus?.status === "OK") {
        finalNode = inner;
        streamStatus = "OK";

        for (const f of inner.streamingData?.formats || []) {
            if (!f.url) continue;
            videoStreams.push(buildStream(f, true)); // muxed: video + audio
        }
        for (const f of inner.streamingData?.adaptiveFormats || []) {
            if (!f.url) continue;
            const { container } = parseMime(f.mimeType);
            if (container.startsWith("audio/")) audioStreams.push(buildStream(f, true));
            else if (container.startsWith("video/")) videoStreams.push(buildStream(f, false));
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
        viewCount: Number(d.viewCount) || 0,
        isLive: !!d.isLiveContent,
        bestThumbnail: best?.url || `https://i.ytimg.com/vi/${videoID}/maxresdefault.jpg`,
        audioStreams,
        videoStreams,
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

// ---------- Handler ----------

function pickBestVideo(info) {
    // Only muxed streams (video + audio together) can be sent directly
    const muxed = info.videoStreams.filter(v => v.hasAudio && v.container === "video/mp4");
    return [...muxed].sort((a, b) => b.bitrate - a.bitrate)[0];
}

const guide = (usedPrefix, command) => `🎬 *YouTube Video Downloader (MP4)*

This feature downloads a YouTube video and sends it to you as an MP4 file.

*How to use:*
${usedPrefix + command} <YouTube link>

*Example:*
• ${usedPrefix + command} https://youtu.be/dQw4w9WgXcQ
• ${usedPrefix + command} https://www.youtube.com/watch?v=dQw4w9WgXcQ

*Supported links:*
watch, youtu.be, shorts, embed, live links, or the 11-character video ID.

*Tips:*
• Videos larger than 100 MB cannot be sent.
• Quality is limited to what YouTube provides with sound included (usually 360p–720p).
• Live streams are not supported.`;

let handler = async (m, { conn, text, usedPrefix, command }) => {
    const link = (text || "").trim();
    if (!link) return conn.reply(m.chat, guide(usedPrefix, command), m);

    await conn.reply(m.chat, "⏳ Fetching your video, please wait...", m);

    try {
        const info = await extractYouTube(link);

        if (info.isLive) throw new Error("Live streams cannot be downloaded.");
        if (info.streamStatus !== "OK") {
            throw new Error("YouTube blocked direct download links for this video (bot check / login required). Try another video.");
        }

        const video = pickBestVideo(info);
        if (!video) throw new Error("No downloadable video stream found.");
        if (video.contentLength > MAX_SIZE) throw new Error(`Video is too large (${formatSize(video.contentLength)}).`);

        const caption = `🎬 *${info.title}*
👤 Channel: ${info.author}
⏱️ Duration: ${formatDuration(info.durationSeconds)}
📺 Quality: ${video.quality || video.resolution} (${formatSize(video.contentLength)})
🔗 ${info.canonicalUrl}`;

        await conn.sendFile(m.chat, video.directUrl, `${info.title}.mp4`, caption, m);
    } catch (e) {
        console.error(e);
        await conn.reply(m.chat, `❌ Failed.\n${e.message}`, m);
    }
};

handler.help = handler.command = ["youtubemp4"];

handler.tags = ["downloader"];

handler.limit = false;

export default handler;
      
