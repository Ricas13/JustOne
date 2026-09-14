import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

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

export async function loadState() {
  await ensureDir();
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    return { ...structuredClone(EMPTY_STATE), ...parsed };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveState(EMPTY_STATE);
    return structuredClone(EMPTY_STATE);
  }
}

export async function saveState(state) {
  await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
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
