import crypto from "node:crypto";
import { config, withKey } from "./config.js";

const WINNER_TTL_MS = Math.max(5000, Number(process.env.JELLYFIN_EVENT_WINNER_TTL_MS || 60000));
const PROBE_TIMEOUT_MS = Math.max(1000, Number(process.env.JELLYFIN_EVENT_PROBE_TIMEOUT_MS || 5000));
const winners = new Map();
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const SOURCE_TAIL_RE = /\b(?:sky\s+sports|tnt\s+sports|bt\s+sport|espn|sport\s*tv|dazn|eurosport|be?in\s+sports?|fox\s+sports?|fs\s*[12]|nbc\s+sports?|cbs\s+sports?|canal\+?\s*sport|supersport|tsn|sportsnet|nfl\s+network|nba\s+tv|mlb\s+network|nhl\s+network|golf\s+channel|premier\s+sports?|viaplay\s+sports?|optus\s+sport|stan\s+sport|arena\s+sport|ziggo\s+sport|movistar\s+deportes|v\s+sport|backup|event|stream|feed|ppv|main\s+event)\b/i;

function text(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hash(value, length = 16) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, length);
}

export function eventDisplayTitle(value) {
  const name = text(value);
  const parts = name.split(/\s+(?:—|–|-)\s+/);
  if (parts.length < 2) return name;
  const tail = parts[parts.length - 1];
  if (!SOURCE_TAIL_RE.test(tail)) return name;
  return parts.slice(0, -1).join(" - ").trim();
}

function eventIdentity(value) {
  return eventDisplayTitle(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:uhd|fhd|hd|sd|4k|2160p|1080p|720p|576p|480p)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function qualityRank(value) {
  const hay = text(value).toLowerCase();
  if (/\b(?:4k|uhd|2160p?)\b/.test(hay)) return 500;
  if (/\b(?:fhd|1080p?)\b/.test(hay)) return 400;
  if (/\b(?:hd|720p?)\b/.test(hay)) return 300;
  if (/\b(?:sd|576p?|480p?)\b/.test(hay)) return 100;
  return 200;
}

export function qualityLabel(value) {
  const rank = qualityRank(value);
  if (rank >= 500) return "4K/UHD";
  if (rank >= 400) return "1080p/FHD";
  if (rank >= 300) return "HD/720p";
  if (rank <= 100) return "SD/480p";
  return "Unknown";
}

function sourceRank(value) {
  const hay = text(value).toLowerCase();
  let rank = 0;
  if (/\b(?:sky|espn|tnt|bein|dazn|eurosport|bbc|itv|sport\s*tv|canal\+|fox|nbc|cbs|arena\s+sport|v\s+sport)\b/.test(hay)) rank += 30;
  if (/\b(?:event|ppv|generic)\b/.test(hay)) rank -= 10;
  if (/\bbackup\b/.test(hay)) rank -= 30;
  return rank;
}

function candidateRows(channel) {
  const rows = Array.isArray(channel?.candidates) && channel.candidates.length
    ? channel.candidates
    : [{ url: channel?.url, label: channel?.name }];
  return rows
    .filter((candidate) => /^https?:\/\//i.test(String(candidate?.url || "")))
    .map((candidate) => {
      const label = text(candidate.label || channel?.name || candidate.url);
      return {
        url: String(candidate.url),
        label,
        quality: qualityLabel(`${label} ${channel?.name || ""}`),
        qualityRank: qualityRank(`${label} ${channel?.name || ""}`),
        sourceRank: sourceRank(label),
      };
    });
}

export function sortEventCandidates(candidates = []) {
  const seen = new Set();
  return [...candidates]
    .filter((candidate) => candidate?.url && !seen.has(candidate.url) && seen.add(candidate.url))
    .sort((a, b) =>
      Number(b.qualityRank || 0) - Number(a.qualityRank || 0)
      || Number(b.sourceRank || 0) - Number(a.sourceRank || 0)
      || collator.compare(String(a.label || ""), String(b.label || "")),
    );
}

function eventKey(channel) {
  const identity = eventIdentity(channel?.name || "");
  if (!identity) return "";
  return `${String(channel?.group || "Sports")}|${identity}`;
}

function mergedEvent(rows, key) {
  const candidates = sortEventCandidates(rows.flatMap(candidateRows));
  const best = rows.find((row) => candidateRows(row).some((candidate) => candidate.url === candidates[0]?.url)) || rows[0];
  const id = `event.${hash(key)}`;
  const title = eventDisplayTitle(best.name);
  const sourceTvgIds = [...new Set(rows.flatMap((row) => row.sourceTvgIds || []).filter(Boolean))];
  const programmes = (best.programmes || []).map((programme, index) => ({
    ...programme,
    title,
    description: `${candidates.length} source${candidates.length === 1 ? "" : "s"}; highest quality working source selected at playback time.`,
    icon: withKey(`${config.publicUrl}/jellyfin/artwork/program/${encodeURIComponent(`${id}.event.${index}`)}.png`),
  }));

  return {
    ...best,
    id,
    tvgId: `justone.${id}`,
    sourceTvgIds,
    iptvOrgId: "",
    name: title,
    candidates,
    eventFailover: true,
    sourceCount: candidates.length,
    url: withKey(`${config.publicUrl}/jellyfin/event/${encodeURIComponent(id)}.ts`),
    programmes,
    logo: withKey(`${config.publicUrl}/jellyfin/artwork/channel/${encodeURIComponent(id)}.png`),
    logoSource: "generated-sports-event",
  };
}

/**
 * Collapse only duplicate sports-event display rows. Ordinary TV channels and
 * single-source events retain their exact existing playback URL.
 *
 * The merged row stores every original playback URL in candidates[]; its M3U
 * URL is only a selector endpoint which redirects to one of those originals.
 */
export function collapseSportsEvents(lineup = []) {
  const groups = new Map();
  for (const channel of lineup) {
    if (channel?.kind !== "sport-slot" || !/^Sports\s*\|/i.test(String(channel.group || ""))) continue;
    const key = eventKey(channel);
    if (!key) continue;
    const rows = groups.get(key) || [];
    rows.push(channel);
    groups.set(key, rows);
  }

  const emitted = new Set();
  const out = [];
  for (const channel of lineup) {
    if (channel?.kind !== "sport-slot") {
      out.push(channel);
      continue;
    }
    const key = eventKey(channel);
    const rows = groups.get(key) || [channel];
    if (rows.length < 2) {
      out.push(channel);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push(mergedEvent(rows, key));
  }
  return out;
}

export function probeUrlForCandidate(url) {
  try {
    const parsed = new URL(String(url));
    if (/\/play\/live\/[^/]+\.ts$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\.ts$/i, ".m3u8");
    }
    return parsed.toString();
  } catch {
    return String(url || "");
  }
}

async function probeCandidate(candidate, fetchImpl, timeoutMs) {
  const probeUrl = probeUrlForCandidate(candidate.url);
  try {
    const response = await fetchImpl(probeUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 JustOne Jellyfin Event Selector",
        accept: "application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    if (contentType.includes("text/html")) return false;
    const reader = response.body?.getReader?.();
    if (!reader) return !/\.m3u8(?:$|\?)/i.test(probeUrl);
    const first = await reader.read();
    await reader.cancel().catch(() => {});
    if (!first?.value?.length) return false;
    const sample = new TextDecoder().decode(first.value).slice(0, 8192);
    if (/<(?:!doctype\s+html|html|body)\b/i.test(sample)) return false;
    if (/\.m3u8(?:$|\?)/i.test(probeUrl)) return /#EXTM3U/i.test(sample);
    return true;
  } catch {
    return false;
  }
}

export function clearEventWinnerCache() {
  winners.clear();
}

/**
 * Find a working source, highest quality to lowest quality. This function never
 * proxies, rewrites or serves media. The returned url is the exact original
 * candidate URL and the HTTP route must redirect the client to it.
 */
export async function selectWorkingEventCandidate(
  channel,
  { fetchImpl = fetch, now = Date.now(), timeoutMs = PROBE_TIMEOUT_MS } = {},
) {
  const candidates = sortEventCandidates(channel?.candidates || []);
  if (!candidates.length) return null;

  const cached = winners.get(channel.id);
  if (cached && cached.expiresAt > now) {
    const candidate = candidates.find((row) => row.url === cached.url);
    if (candidate && await probeCandidate(candidate, fetchImpl, timeoutMs)) return candidate;
    winners.delete(channel.id);
  }

  for (const candidate of candidates) {
    if (await probeCandidate(candidate, fetchImpl, timeoutMs)) {
      winners.set(channel.id, { url: candidate.url, expiresAt: now + WINNER_TTL_MS });
      return candidate;
    }
  }
  return null;
}
