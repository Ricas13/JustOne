import { text } from "./util.js";

function safeUrl(value) {
  const raw = text(value);
  if (!raw) throw new Error("playlist URL is required");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("playlist URL is invalid");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("playlist URL must use http or https");
  return parsed;
}

function providerLabel(parsed) {
  return parsed.hostname.replace(/^www\./i, "") || "IPTV";
}

export function deriveXtreamXmltvUrl(value) {
  let parsed;
  try { parsed = safeUrl(value); } catch { return ""; }
  if (!/\/(?:get|playlist)\.php$/i.test(parsed.pathname)) return "";
  const username = parsed.searchParams.get("username");
  const password = parsed.searchParams.get("password");
  if (!username || !password) return "";
  const dir = parsed.pathname.replace(/[^/]+$/, "");
  const epg = new URL(`${dir}xmltv.php`, parsed.origin);
  epg.searchParams.set("username", username);
  epg.searchParams.set("password", password);
  return epg.toString();
}

export function normaliseSourceInput(input = {}, existing = []) {
  const parsed = safeUrl(input.url);
  const autoProvider = providerLabel(parsed);
  const provider = text(input.provider) || autoProvider;
  const sameProvider = existing.filter((row) => text(row.provider).toLowerCase() === provider.toLowerCase()).length;
  const lineNumber = sameProvider + 1;
  const account = text(input.account) || `Line ${lineNumber}`;
  const name = text(input.name) || `${provider} - ${account}`;
  const maxStreamsText = text(input.maxStreams);
  const maxStreamsRaw = maxStreamsText ? Number(maxStreamsText) : Number.NaN;
  if (maxStreamsText && (!Number.isFinite(maxStreamsRaw) || maxStreamsRaw <= 0)) {
    throw new Error("maxStreams must be a positive number");
  }
  const maxStreams = maxStreamsText ? Math.floor(maxStreamsRaw) : 1;
  const priorityText = text(input.priority);
  const priorityRaw = priorityText ? Number(priorityText) : Number.NaN;
  if (priorityText && !Number.isFinite(priorityRaw)) {
    throw new Error("priority must be a number");
  }
  const priority = priorityText ? priorityRaw : (existing.length + 1) * 10;
  const detectedEpgUrl = text(input.detectedEpgUrl) || deriveXtreamXmltvUrl(parsed.toString());

  return {
    ...input,
    name,
    provider,
    account,
    maxStreams,
    priority,
    url: parsed.toString(),
    detectedEpgUrl,
    enabled: input.enabled !== false,
  };
}

export function parseBulkPlaylistText(value) {
  const rows = [];
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (/^https?:\/\//i.test(line)) {
      rows.push({ url: line });
      continue;
    }

    const separators = ["|", "\t"];
    let matched = false;
    for (const separator of separators) {
      const index = line.indexOf(separator);
      if (index <= 0) continue;
      const name = line.slice(0, index).trim();
      const url = line.slice(index + separator.length).trim();
      if (/^https?:\/\//i.test(url)) {
        rows.push({ name, url });
        matched = true;
        break;
      }
    }
    if (!matched) rows.push({ invalid: line });
  }
  return rows;
}

export function duplicateSourceByUrl(existing = [], url) {
  const target = safeUrl(url).toString();
  return existing.find((row) => {
    try {
      return safeUrl(row.url).toString() === target;
    } catch {
      return false;
    }
  }) || null;
}
