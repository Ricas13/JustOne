import type { ServerResponse } from "node:http";

import { fetchChannelList } from "../channels/fetch.js";
import { generateM3u8Playlist } from "../channels/m3u8.js";
import { PLAYER_IDS } from "../players/types.js";
import { buildProxyUrl } from "../proxy/links.js";
import { resolveLive } from "./resolve.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
};

const DIRECT_PROBE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function canPlayDirect(url: string, mimeType: string): Promise<boolean> {
  let response: Response | null = null;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": DIRECT_PROBE_UA,
        Accept: "*/*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }

    const contentType = String(response.headers.get("content-type") || mimeType || "").toLowerCase();
    const looksHls =
      contentType.includes("mpegurl") ||
      contentType.includes("m3u8") ||
      /\.m3u8(?:$|[?#])/i.test(response.url || url);

    if (!looksHls) {
      await response.body?.cancel().catch(() => undefined);
      return true;
    }

    const reader = response.body?.getReader();
    if (!reader) return false;
    const { value } = await reader.read();
    await reader.cancel().catch(() => undefined);
    const prefix = new TextDecoder().decode(value || new Uint8Array());
    return prefix.includes("#EXTM3U");
  } catch {
    try {
      await response?.body?.cancel();
    } catch {
      // ignore cleanup errors
    }
    return false;
  }
}

export async function handleChannelList(res: ServerResponse) {
  const channels = await fetchChannelList();
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(channels));
}

export async function handlePlaylist(res: ServerResponse, origin: string) {
  const channels = await fetchChannelList();
  const playlistText = generateM3u8Playlist(channels, origin);
  res.writeHead(200, {
    "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
    "Content-Disposition": 'attachment; filename="playlist.m3u8"',
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  });
  res.end(playlistText);
}

export async function handleStreamResolver(res: ServerResponse, channelId: number, origin: string) {
  for (const server of PLAYER_IDS) {
    try {
      const { resolved } = await resolveLive(channelId, server);
      const direct = resolved.playableUrl;
      const directOk = await canPlayDirect(direct, resolved.mimeType);
      const location = directOk ? direct : buildProxyUrl(direct, resolved.embedUrl, origin);
      res.writeHead(302, {
        Location: location,
        "X-DLHD-Delivery": directOk ? "direct" : "proxy",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end();
      return;
    } catch {
      // try next player
    }
  }

  res.writeHead(503, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(`Failed to resolve live stream for channel ${channelId}`);
}
