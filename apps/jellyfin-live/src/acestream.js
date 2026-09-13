import fs from "node:fs/promises";
import path from "node:path";

const COUNTRY_ALIASES = new Map([
  ["UK", "GB"], ["GB", "GB"], ["UNITED KINGDOM", "GB"],
  ["USA", "US"], ["US", "US"], ["UNITED STATES", "US"],
  ["PT", "PT"], ["PORTUGAL", "PT"],
]);

const COUNTRY_SUFFIX_WORDS = new Map([
  ["GB", ["uk", "gb", "united kingdom"]],
  ["US", ["usa", "us", "united states"]],
  ["PT", ["pt", "portugal"]],
  ["ES", ["es", "spain"]],
  ["FR", ["fr", "france"]],
  ["DE", ["de", "germany"]],
  ["IT", ["it", "italy"]],
  ["NL", ["nl", "netherlands"]],
  ["IE", ["ie", "ireland"]],
  ["CA", ["ca", "canada"]],
  ["AU", ["au", "australia"]],
  ["BR", ["br", "brazil"]],
  ["RU", ["ru", "russia"]],
]);

const COUNTRY_LANGUAGES = new Map([
  ["GB", new Set(["eng"])],
  ["US", new Set(["eng"])],
  ["IE", new Set(["eng", "gle"])],
  ["PT", new Set(["por"])],
  ["BR", new Set(["por"])],
  ["ES", new Set(["spa"])],
  ["FR", new Set(["fra", "fre"])],
  ["DE", new Set(["deu", "ger"])],
  ["IT", new Set(["ita"])],
  ["NL", new Set(["nld", "dut"])],
  ["RU", new Set(["rus"])],
]);

function txt(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeCountryCode(value) {
  const raw = txt(value).toUpperCase();
  return COUNTRY_ALIASES.get(raw) || raw;
}

export function normalizeAceName(value, country = "") {
  let out = txt(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/[._/|:\-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:uhd|fhd|hd|sd|4k|2160p|1080p|720p|576p|480p)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const cc = normalizeCountryCode(country);
  for (const suffix of COUNTRY_SUFFIX_WORDS.get(cc) || []) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out = out.replace(new RegExp(`\\s+${escaped}$`, "i"), "").replace(/\s+/g, " ").trim();
  }
  return out;
}

function normalizedChannelAliases(channel) {
  const country = normalizeCountryCode(channel?.country);
  const values = [channel?.name, ...(channel?.aliases || [])].filter(Boolean);
  return [...new Set(values.map((value) => normalizeAceName(value, country)).filter(Boolean))];
}

function tokenSet(value) {
  return new Set(String(value || "").split(/\s+/).filter(Boolean));
}

function jaccard(a, b) {
  const aa = tokenSet(a);
  const bb = tokenSet(b);
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const value of aa) if (bb.has(value)) intersection += 1;
  return intersection / (aa.size + bb.size - intersection);
}

function resultCountries(result) {
  return [...new Set((result?.countries || []).map(normalizeCountryCode).filter(Boolean))];
}

function resultLanguages(result) {
  return [...new Set((result?.languages || []).map((value) => txt(value).toLowerCase()).filter(Boolean))];
}

export function scoreAceResult(channel, result, nowMs = Date.now()) {
  const country = normalizeCountryCode(channel?.country);
  const aliases = normalizedChannelAliases(channel);
  const candidateName = normalizeAceName(result?.name, country);
  let score = 0;
  let nameScore = 0;
  const reasons = [];

  for (const alias of aliases) {
    if (!alias || !candidateName) continue;
    if (candidateName === alias) {
      nameScore = Math.max(nameScore, 70);
      continue;
    }
    if (candidateName.startsWith(`${alias} `) || alias.startsWith(`${candidateName} `)) {
      nameScore = Math.max(nameScore, 48);
      continue;
    }
    nameScore = Math.max(nameScore, Math.round(jaccard(candidateName, alias) * 45));
  }
  score += nameScore;
  if (nameScore >= 70) reasons.push("exact-name");
  else if (nameScore >= 48) reasons.push("close-name");

  if (nameScore < 45) {
    return { eligible: false, strongMetadata: false, score, reasons: [...reasons, "name-mismatch"] };
  }

  const countries = resultCountries(result);
  let countryMatch = false;
  if (country && countries.length) {
    countryMatch = countries.includes(country);
    if (!countryMatch) {
      return {
        eligible: false,
        strongMetadata: false,
        score: score - 100,
        reasons: [...reasons, `country-mismatch:${countries.join(",")}`],
      };
    }
    score += 20;
    reasons.push("country-match");
  }

  const languages = resultLanguages(result);
  const expectedLanguages = COUNTRY_LANGUAGES.get(country);
  let languageMatch = false;
  if (expectedLanguages?.size && languages.length) {
    languageMatch = languages.some((language) => expectedLanguages.has(language));
    if (!languageMatch) {
      return {
        eligible: false,
        strongMetadata: false,
        score: score - 60,
        reasons: [...reasons, `language-mismatch:${languages.join(",")}`],
      };
    }
    score += 10;
    reasons.push("language-match");
  }

  const status = Number(result?.status || 0);
  if (status === 2) {
    score += 10;
    reasons.push("green");
  }

  const availability = Number(result?.availability || 0);
  if (availability >= 0.8) {
    score += 10;
    reasons.push("availability-high");
  } else if (availability >= 0.5) {
    score += 5;
  } else if (availability > 0 && availability < 0.2) {
    score -= 15;
  }

  const updatedAt = Number(result?.availability_updated_at || 0) * 1000;
  if (updatedAt > 0) {
    const age = Math.max(0, nowMs - updatedAt);
    if (age <= 6 * 60 * 60 * 1000) {
      score += 5;
      reasons.push("fresh");
    } else if (age >= 7 * 24 * 60 * 60 * 1000) {
      score -= 20;
      reasons.push("stale");
    }
  }

  const strongMetadata = nameScore >= 70
    && (!country || countryMatch)
    && (!expectedLanguages?.size || !languages.length || languageMatch)
    && status === 2
    && availability >= 0.8;

  return { eligible: score >= 60, strongMetadata, score, reasons };
}

export function flattenAceSearchResults(payload) {
  const rows = payload?.result?.results;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (Array.isArray(row?.items)) {
      for (const item of row.items) out.push({ ...row, ...item, items: undefined });
    } else {
      out.push(row);
    }
  }
  return out.filter((row) => /^[a-f0-9]{40}$/i.test(String(row?.infohash || "")));
}

export function buildAcePlaybackUrl(mediaflowUrl, apiPassword, infohash) {
  const base = String(mediaflowUrl || "").replace(/\/$/, "");
  if (!base || !/^[a-f0-9]{40}$/i.test(String(infohash || ""))) return "";
  const url = new URL(`${base}/proxy/acestream/stream`);
  url.searchParams.set("infohash", String(infohash));
  if (apiPassword) url.searchParams.set("api_password", String(apiPassword));
  return url.href;
}

export function combinePlaybackCandidates(dlhdCandidates, aceCandidates, priority = "first") {
  const dlhd = Array.isArray(dlhdCandidates) ? dlhdCandidates : [];
  const ace = Array.isArray(aceCandidates) ? aceCandidates : [];
  return String(priority).toLowerCase() === "fallback" ? [...dlhd, ...ace] : [...ace, ...dlhd];
}

function emptyState() {
  return { version: 1, updatedAt: 0, cursor: 0, channels: {} };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object") return emptyState();
  return {
    version: 1,
    updatedAt: Number(raw.updatedAt || 0),
    cursor: Math.max(0, Number(raw.cursor || 0)),
    channels: raw.channels && typeof raw.channels === "object" ? raw.channels : {},
  };
}

function resultChannelId(result) {
  const value = result?.channel_id;
  if (value === null || value === undefined || value === "") return "";
  return String(value);
}

function candidateSort(a, b) {
  const blockedA = Number(a.blockedUntil || 0) > Date.now() ? 1 : 0;
  const blockedB = Number(b.blockedUntil || 0) > Date.now() ? 1 : 0;
  if (blockedA !== blockedB) return blockedA - blockedB;
  if (Number(b.lastSuccessAt || 0) !== Number(a.lastSuccessAt || 0)) {
    return Number(b.lastSuccessAt || 0) - Number(a.lastSuccessAt || 0);
  }
  if (Number(b.matchScore || 0) !== Number(a.matchScore || 0)) {
    return Number(b.matchScore || 0) - Number(a.matchScore || 0);
  }
  return Number(b.availability || 0) - Number(a.availability || 0);
}

export class AceStreamRegistry {
  constructor(options = {}, deps = {}) {
    this.enabled = Boolean(options.enabled);
    this.searchUrl = String(options.searchUrl || "").trim();
    this.mediaflowUrl = String(options.mediaflowUrl || "").trim();
    this.mediaflowPassword = String(options.mediaflowPassword || "");
    this.stateFile = String(options.stateFile || "/app/data/acestream-state.json");
    this.discoveryBatch = Math.max(1, Number(options.discoveryBatch || 75));
    this.pageSize = Math.max(1, Math.min(200, Number(options.pageSize || 50)));
    this.maxCandidates = Math.max(1, Math.min(20, Number(options.maxCandidates || 5)));
    this.minAvailability = Math.max(0, Math.min(1, Number(options.minAvailability ?? 0.5)));
    this.autoVerifyMetadata = Boolean(options.autoVerifyMetadata);
    this.priority = String(options.priority || "first").toLowerCase() === "fallback" ? "fallback" : "first";
    this.fetch = deps.fetch || globalThis.fetch;
    this.now = deps.now || (() => Date.now());
    this.log = deps.log || (() => {});
    this.state = emptyState();
    this.loaded = false;
    this.loading = null;
    this.saving = Promise.resolve();
  }

  async init() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const body = await fs.readFile(this.stateFile, "utf8");
        this.state = normalizeState(JSON.parse(body));
      } catch (error) {
        if (error?.code !== "ENOENT") this.log("state load failed", String(error.message || error));
        this.state = emptyState();
      }
      this.loaded = true;
      this.loading = null;
    })();
    return this.loading;
  }

  async save() {
    if (!this.enabled) return;
    await this.init();
    const snapshot = JSON.stringify({ ...this.state, updatedAt: this.now() }, null, 2) + "\n";
    this.saving = this.saving.then(async () => {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      await fs.writeFile(tmp, snapshot, "utf8");
      await fs.rename(tmp, this.stateFile);
    }).catch((error) => this.log("state save failed", String(error.message || error)));
    return this.saving;
  }

  trustedOwner(aceChannelId, exceptChannelId = "") {
    const id = String(aceChannelId || "");
    if (!id) return "";
    for (const [channelId, entry] of Object.entries(this.state.channels || {})) {
      if (channelId === exceptChannelId) continue;
      if ((entry.trustedAceChannelIds || []).map(String).includes(id)) return channelId;
    }
    return "";
  }

  async searchChannel(channel) {
    if (!this.searchUrl || typeof this.fetch !== "function") return [];
    const country = normalizeCountryCode(channel?.country);
    const queries = [];
    for (const value of [channel?.name, ...(channel?.aliases || [])]) {
      const q = txt(value);
      if (!q) continue;
      const normalized = normalizeAceName(q, country);
      if (!normalized || queries.some((row) => normalizeAceName(row, country) === normalized)) continue;
      queries.push(q);
      if (queries.length >= 2) break;
    }

    const byHash = new Map();
    for (const query of queries) {
      const url = new URL(this.searchUrl);
      url.searchParams.set("query", query);
      url.searchParams.set("page", "0");
      url.searchParams.set("page_size", String(this.pageSize));
      const response = await this.fetch(url, {
        headers: { accept: "application/json", "user-agent": "JustOne-AceStream" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`${url.origin}${url.pathname} ${response.status}`);
      const payload = await response.json();
      for (const result of flattenAceSearchResults(payload)) {
        const hash = String(result.infohash).toLowerCase();
        const scored = scoreAceResult(channel, result, this.now());
        if (!scored.eligible) continue;
        if (Number(result.availability || 0) < this.minAvailability) continue;
        const row = { ...result, infohash: hash, matchScore: scored.score, matchReasons: scored.reasons, strongMetadata: scored.strongMetadata };
        const old = byHash.get(hash);
        if (!old || row.matchScore > old.matchScore) byHash.set(hash, row);
      }
    }

    return [...byHash.values()]
      .sort((a, b) => Number(b.matchScore || 0) - Number(a.matchScore || 0) || Number(b.availability || 0) - Number(a.availability || 0))
      .slice(0, this.maxCandidates);
  }

  async discoverChannel(channel) {
    const results = await this.searchChannel(channel);
    const now = this.now();
    const entry = this.state.channels[channel.id] || {
      name: channel.name,
      country: normalizeCountryCode(channel.country),
      trustedAceChannelIds: [],
      candidates: {},
    };
    entry.name = channel.name;
    entry.country = normalizeCountryCode(channel.country);
    entry.lastDiscoveryAt = now;
    entry.trustedAceChannelIds = [...new Set((entry.trustedAceChannelIds || []).map(String))];
    entry.candidates ||= {};

    for (const result of results) {
      const hash = result.infohash;
      const previous = entry.candidates[hash] || {};
      const aceChannelId = resultChannelId(result);
      let verification = previous.verification || "unverified";
      let verifiedBy = previous.verifiedBy || "";
      const inherited = aceChannelId
        && entry.trustedAceChannelIds.includes(aceChannelId)
        && !this.trustedOwner(aceChannelId, channel.id);
      if (verification !== "rejected" && verification !== "verified") {
        if (inherited) {
          verification = "verified";
          verifiedBy = "trusted-channel-id";
        } else if (this.autoVerifyMetadata && result.strongMetadata) {
          verification = "verified";
          verifiedBy = "strong-metadata";
        }
      }

      entry.candidates[hash] = {
        ...previous,
        infohash: hash,
        name: txt(result.name),
        aceChannelId,
        countries: resultCountries(result),
        languages: resultLanguages(result),
        status: Number(result.status || 0),
        availability: Number(result.availability || 0),
        availabilityUpdatedAt: Number(result.availability_updated_at || 0) * 1000,
        matchScore: Number(result.matchScore || 0),
        matchReasons: result.matchReasons || [],
        firstSeenAt: Number(previous.firstSeenAt || now),
        lastSeenAt: now,
        verification,
        verifiedBy,
        verifiedAt: verification === "verified" ? Number(previous.verifiedAt || now) : 0,
      };
    }

    this.state.channels[channel.id] = entry;
    return results.length;
  }

  async discover(lineup, { forceAll = false } = {}) {
    if (!this.enabled) return { enabled: false, scanned: 0, found: 0 };
    await this.init();
    const channels = (lineup || []).filter((channel) => channel?.kind === "static" && channel?.id && channel?.name);
    if (!channels.length) return { enabled: true, scanned: 0, found: 0 };

    const start = forceAll ? 0 : this.state.cursor % channels.length;
    const count = forceAll ? channels.length : Math.min(this.discoveryBatch, channels.length);
    const selected = [];
    for (let index = 0; index < count; index += 1) selected.push(channels[(start + index) % channels.length]);

    let next = 0;
    let found = 0;
    const workers = Array.from({ length: Math.min(4, selected.length || 1) }, async () => {
      while (true) {
        const index = next++;
        if (index >= selected.length) return;
        const channel = selected[index];
        try {
          found += await this.discoverChannel(channel);
        } catch (error) {
          this.log("discovery failed", channel.name, String(error.message || error));
        }
      }
    });
    await Promise.all(workers);
    this.state.cursor = forceAll ? this.state.cursor : (start + count) % channels.length;
    await this.save();
    return { enabled: true, scanned: selected.length, found };
  }

  async verify(channelId, infohash) {
    await this.init();
    const entry = this.state.channels[String(channelId)];
    const hash = String(infohash || "").toLowerCase();
    const candidate = entry?.candidates?.[hash];
    if (!candidate) throw new Error("AceStream candidate not found for channel");
    candidate.verification = "verified";
    candidate.verifiedBy = "manual";
    candidate.verifiedAt = this.now();
    const aceChannelId = String(candidate.aceChannelId || "");
    if (aceChannelId && !this.trustedOwner(aceChannelId, String(channelId))) {
      entry.trustedAceChannelIds = [...new Set([...(entry.trustedAceChannelIds || []).map(String), aceChannelId])];
    }
    await this.save();
    return candidate;
  }

  async reject(channelId, infohash) {
    await this.init();
    const entry = this.state.channels[String(channelId)];
    const hash = String(infohash || "").toLowerCase();
    const candidate = entry?.candidates?.[hash];
    if (!candidate) throw new Error("AceStream candidate not found for channel");
    candidate.verification = "rejected";
    candidate.verifiedBy = "manual";
    candidate.verifiedAt = 0;
    candidate.rejectedAt = this.now();
    await this.save();
    return candidate;
  }

  async playbackCandidates(channel) {
    if (!this.enabled) return [];
    await this.init();
    const entry = this.state.channels[channel?.id];
    if (!entry) return [];
    const now = this.now();
    return Object.values(entry.candidates || {})
      .filter((candidate) => candidate.verification === "verified" && Number(candidate.blockedUntil || 0) <= now)
      .sort(candidateSort)
      .map((candidate) => ({
        label: `AceStream • ${candidate.name || channel.name}`,
        url: buildAcePlaybackUrl(this.mediaflowUrl, this.mediaflowPassword, candidate.infohash),
        provider: "acestream",
        sourceMode: "fixed",
        sourceCount: 1,
        channelId: channel.id,
        infohash: candidate.infohash,
        aceChannelId: candidate.aceChannelId || "",
      }))
      .filter((candidate) => candidate.url);
  }

  async recordPlayback(attempt, result) {
    if (!this.enabled || attempt?.provider !== "acestream" || !attempt?.channelId || !attempt?.infohash) return;
    await this.init();
    const candidate = this.state.channels?.[attempt.channelId]?.candidates?.[String(attempt.infohash).toLowerCase()];
    if (!candidate) return;
    const now = this.now();
    const bytes = Number(result?.bytes || 0);
    if (bytes >= 512 * 1024) {
      candidate.lastSuccessAt = now;
      candidate.consecutiveFailures = 0;
      candidate.blockedUntil = 0;
    } else if (["no-media", "stalled", "ffmpeg-exit", "spawn-error"].includes(result?.reason)) {
      candidate.lastFailureAt = now;
      candidate.consecutiveFailures = Number(candidate.consecutiveFailures || 0) + 1;
      const exponent = Math.min(6, candidate.consecutiveFailures - 1);
      candidate.blockedUntil = now + Math.min(60 * 60 * 1000, 30_000 * (2 ** exponent));
    }
    await this.save();
  }

  async diagnostics(lineup = []) {
    await this.init();
    const names = new Map((lineup || []).map((channel) => [channel.id, channel.name]));
    let discovered = 0;
    let verified = 0;
    let rejected = 0;
    const channels = [];
    for (const [channelId, entry] of Object.entries(this.state.channels || {})) {
      const candidates = Object.values(entry.candidates || {}).sort(candidateSort);
      discovered += candidates.length;
      verified += candidates.filter((candidate) => candidate.verification === "verified").length;
      rejected += candidates.filter((candidate) => candidate.verification === "rejected").length;
      if (!candidates.length) continue;
      channels.push({
        id: channelId,
        name: names.get(channelId) || entry.name || channelId,
        country: entry.country || "",
        trustedAceChannelIds: entry.trustedAceChannelIds || [],
        candidates: candidates.map((candidate) => ({
          infohash: candidate.infohash,
          name: candidate.name,
          aceChannelId: candidate.aceChannelId || "",
          verification: candidate.verification || "unverified",
          verifiedBy: candidate.verifiedBy || "",
          matchScore: candidate.matchScore || 0,
          matchReasons: candidate.matchReasons || [],
          status: candidate.status || 0,
          availability: candidate.availability || 0,
          countries: candidate.countries || [],
          languages: candidate.languages || [],
          firstSeenAt: candidate.firstSeenAt || 0,
          lastSeenAt: candidate.lastSeenAt || 0,
          lastSuccessAt: candidate.lastSuccessAt || 0,
          blockedUntil: candidate.blockedUntil || 0,
        })),
      });
    }
    return {
      enabled: this.enabled,
      priority: this.priority,
      discovered,
      verified,
      rejected,
      cursor: this.state.cursor,
      channels,
    };
  }
}
