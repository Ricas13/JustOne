import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

function log(...a) {
  process.stdout.write(a.map(String).join(" ") + "\n");
}

const cache = new Map();

export function defaultSources() {
  return [
    {
      id: "toonami-est",
      name: "Toonami Aftermath EST",
      url: "http://api.toonamiaftermath.com:3000/est/playlist.m3u8",
      enabled: true,
    },
    {
      id: "toonami-pst",
      name: "Toonami Aftermath PST",
      url: "http://api.toonamiaftermath.com:3000/pst/playlist.m3u8",
      enabled: true,
    },
  ];
}

function sourcesFile() {
  return path.join(config.liveDir, "sources.json");
}

export async function readSources() {
  try {
    const raw = await fs.readFile(sourcesFile(), "utf8");
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length) return list;
  } catch {
    /* first run */
  }
  const list = defaultSources();
  await writeSources(list);
  return list;
}

export async function writeSources(list) {
  await fs.mkdir(config.liveDir, { recursive: true });
  await fs.writeFile(sourcesFile(), JSON.stringify(list, null, 2), "utf8");
}

export function parseM3u(text, source) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let meta = {};
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      const name = line.split(",").slice(1).join(",").trim();
      const group = /group-title="([^"]*)"/i.exec(line)?.[1] || source.name;
      const logo = /tvg-logo="([^"]*)"/i.exec(line)?.[1] || "";
      const tvg = /tvg-id="([^"]*)"/i.exec(line)?.[1] || "";
      meta = { name, group: `${source.name}${group && group !== source.name ? " / " + group : ""}`, logo, tvg };
    } else if (line && !line.startsWith("#")) {
      const url = line.trim();
      if (/^https?:\/\//i.test(url) && meta.name) {
        out.push({
          id: `ext-${source.id}-${out.length}`,
          sourceId: source.id,
          name: meta.name,
          group: meta.group,
          logo: meta.logo,
          url,
          kind: "ext",
        });
      }
      meta = {};
    }
  }
  return out;
}

export async function loadSourceM3u(source) {
  const r = await fetch(source.url, {
    headers: { "user-agent": "Mozilla/5.0 JustOne", accept: "*/*" },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error(source.id + " " + r.status);
  const text = await r.text();
  const list = parseM3u(text, source);
  cache.set(source.id, list);
  log("m3u", source.id, list.length);
  return list;
}

export async function loadAllExtra() {
  const sources = (await readSources()).filter((s) => s.enabled && s.url);
  const chunks = await Promise.all(
    sources.map(async (s) => {
      try {
        return await loadSourceM3u(s);
      } catch (e) {
        log("m3u fail", s.id, String(e.message || e));
        return cache.get(s.id) || [];
      }
    }),
  );
  return chunks.flat();
}

export function getExtChannel(id) {
  for (const list of cache.values()) {
    const hit = list.find((c) => c.id === id);
    if (hit) return hit;
  }
  return null;
}
