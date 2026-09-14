import path from "node:path";

function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function cleanUrl(value, fallback = "") {
  return String(value || fallback).replace(/\/+$/, "");
}

export const config = {
  port: intEnv("PORT", 8090),
  publicUrl: cleanUrl(process.env.PUBLIC_URL, "http://localhost:8090"),
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  adminKey: String(process.env.ADMIN_KEY || ""),
  publicKey: String(process.env.PUBLIC_KEY || ""),
  refreshMinutes: intEnv("REFRESH_MINUTES", 30),
  fetchTimeoutMs: intEnv("FETCH_TIMEOUT_MS", 30000),
  qualityOrder: String(process.env.DEFAULT_QUALITY_ORDER || "HD,FHD,UHD,SD,UNKNOWN")
    .split(",").map((x) => x.trim().toUpperCase()).filter(Boolean),
  dispatcharr: {
    url: cleanUrl(process.env.DISPATCHARR_URL),
    apiKey: String(process.env.DISPATCHARR_API_KEY || ""),
    username: String(process.env.DISPATCHARR_USERNAME || ""),
    password: String(process.env.DISPATCHARR_PASSWORD || ""),
    applyEnabled: boolEnv("DISPATCHARR_APPLY_ENABLED", false),
    syncLogos: boolEnv("DISPATCHARR_SYNC_LOGOS", true),
  },
};

export function withPublicKey(url) {
  if (!config.publicKey) return url;
  const u = new URL(url);
  u.searchParams.set("key", config.publicKey);
  return u.toString();
}
