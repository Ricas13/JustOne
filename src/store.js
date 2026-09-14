import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { deriveXtreamXmltvUrl } from "./sources.js";

const statePath = path.join(config.dataDir, "state.json");
const snapshotPath = path.join(config.dataDir, "snapshot.json");
const guidePath = path.join(config.dataDir, "guide.xml");
const providerCacheDir = path.join(config.dataDir, "provider-cache");

const EMPTY_STATE = {
  version: 1,
  sources: [],
  guides: [],
  aliases: {},
  overrides: {},
};

async function ensureDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

async function atomicWrite(file, content) {
  await ensureDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

function safeCacheId(sourceId) {
  return String(sourceId || "source").replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function providerKeyForUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return "";
  }
}

export async function ensureProviderCacheDir() {
  await fs.mkdir(providerCacheDir, { recursive: true });
  return providerCacheDir;
}

export function providerCachePath(sourceId) {
  return path.join(providerCacheDir, `${safeCacheId(sourceId)}.m3u`);
}

export function providerCacheMetaPath(sourceId) {
  return path.join(providerCacheDir, `${safeCacheId(sourceId)}.json`);
}

export async function loadProviderCacheMeta(sourceId) {
  try {
    return JSON.parse(await fs.readFile(providerCacheMetaPath(sourceId), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveProviderCacheMeta(sourceId, meta) {
  await ensureProviderCacheDir();
  await atomicWrite(providerCacheMetaPath(sourceId), `${JSON.stringify(meta, null, 2)}\n`);
}

export async function providerCacheExists(sourceId) {
  try {
    const stat = await fs.stat(providerCachePath(sourceId));
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function disabledProviderKeys(state) {
  return new Set(
    (state.sources || [])
      .filter((row) => row.epgDisabled === true)
      .map((row) => providerKeyForUrl(row.url))
      .filter(Boolean)
  );
}

function withAutoXtreamGuides(state) {
  const guides = [...(state.guides || [])];
  const manualUrls = new Set(guides.map((guide) => String(guide.url || "")));
  const seenProviders = new Set();
  const disabledProviders = disabledProviderKeys(state);
  let autoIndex = 0;

  for (const source of (state.sources || []).filter((row) => row.enabled !== false)) {
    let parsed;
    try { parsed = new URL(source.url); } catch { continue; }
    const providerKey = `${parsed.protocol}//${parsed.host}`.toLowerCase();
    if (disabledProviders.has(providerKey) || seenProviders.has(providerKey)) continue;
    seenProviders.add(providerKey);

    const url = String(source.detectedEpgUrl || deriveXtreamXmltvUrl(source.url) || "");
    if (!url || manualUrls.has(url)) continue;
    autoIndex += 1;
    guides.push({
      id: `auto_xtream_${source.id}`,
      name: `${source.provider || parsed.hostname} - auto XMLTV`,
      url,
      priority: 50 + autoIndex,
      enabled: true,
      auto: true,
      sourceId: source.id,
    });
  }
  return { ...state, guides };
}

export async function loadState() {
  await ensureDir();
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    const state = { ...structuredClone(EMPTY_STATE), ...parsed };
    return withAutoXtreamGuides(state);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveState(EMPTY_STATE);
    return withAutoXtreamGuides(structuredClone(EMPTY_STATE));
  }
}

export async function saveState(state) {
  const disabledProviders = disabledProviderKeys(state);
  const sources = (state.sources || []).map((source) => {
    const providerKey = providerKeyForUrl(source.url);
    return disabledProviders.has(providerKey) ? { ...source, epgDisabled: true } : source;
  });
  const persisted = {
    ...state,
    sources,
    guides: (state.guides || []).filter((guide) => guide.auto !== true),
  };
  await atomicWrite(statePath, `${JSON.stringify(persisted, null, 2)}\n`);
}

export async function loadSnapshot() {
  try {
    return JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { generatedAt: null, channels: [], sourceStatus: [], guideStatus: [] };
  }
}

export async function saveSnapshot(snapshot) {
  await atomicWrite(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function loadGuide() {
  try {
    return await fs.readFile(guidePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="JustOne Catalog"></tv>\n';
  }
}

export async function saveGuide(xml) {
  await atomicWrite(guidePath, xml);
}
