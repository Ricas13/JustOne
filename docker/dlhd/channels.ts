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
const DIRECT_PROBE_TIMEOUT_MS = 5000;
const DIRECT_MANIFEST_MAX_BYTES = 512 * 1024;

function directHeaders(range = false): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": DIRECT_PROBE_UA,
    Accept: "*/*",
  };
  if (range) headers.Range = "bytes=0-0";
  return headers;
}

function httpUrl(value: string, base?: string): string | null {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

async function readManifest(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > DIRECT_MANIFEST_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= DIRECT_MANIFEST_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      total += value.length;
      if (total > DIRECT_MANIFEST_MAX_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

async function probeBinary(url: string): Promise<boolean> {
  let response: Response | null = null;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: directHeaders(true),
      redirect: "follow",
      signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    await response.body?.cancel().catch(() => undefined);
    return !contentType.includes("text/html") && !contentType.includes("application/json");
  } catch {
    try {
      await response?.body?.cancel();
    } catch {
      // ignore cleanup errors
    }
    return false;
  }
}

function firstVariant(text: string, base: string): string | null {
  const lines = text.split(/\r?\n/);
  let afterStreamInf = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#EXT-X-STREAM-INF:/i.test(trimmed)) {
      afterStreamInf = true;
      continue;
    }
    if (trimmed.startsWith("#")) continue;
    if (afterStreamInf) return httpUrl(trimmed, base);
  }
  return null;
}

function firstAttributeUri(text: string, tag: RegExp, base: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!tag.test(trimmed)) continue;
    const match = /URI=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/i.exec(trimmed);
    const raw = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!raw) continue;
    const resolved = httpUrl(raw, base);
    if (resolved) return resolved;
  }
  return null;
}

function firstMediaSegment(text: string, base: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return httpUrl(trimmed, base);
  }
  return null;
}

async function canPlayDirect(url: string, mimeType: string, depth = 0): Promise<boolean> {
  let response: Response | null = null;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: directHeaders(false),
      redirect: "follow",
      signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS),
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
      return !contentType.includes("text/html") && !contentType.includes("application/json");
    }

    const manifest = await readManifest(response);
    if (!manifest?.includes("#EXTM3U")) return false;
    const base = response.url || url;

    if (/#EXT-X-STREAM-INF:/i.test(manifest)) {
      if (depth >= 2) return false;
      const variant = firstVariant(manifest, base);
      if (!variant || !(await canPlayDirect(variant, "application/x-mpegURL", depth + 1))) return false;

      const rendition = firstAttributeUri(manifest, /^#EXT-X-MEDIA:/i, base);
      if (rendition && !(await canPlayDirect(rendition, "application/x-mpegURL", depth + 1))) {
        return false;
      }
      return true;
    }

    const key = firstAttributeUri(manifest, /^#EXT-X-KEY:/i, base);
    if (key && !(await probeBinary(key))) return false;

    const map = firstAttributeUri(manifest, /^#EXT-X-MAP:/i, base);
    if (map && !(await probeBinary(map))) return false;

    const segment = firstMediaSegment(manifest, base);
    return Boolean(segment && (await probeBinary(segment)));
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
