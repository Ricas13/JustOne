import { HlsMpegTsReader, isHlsResponse } from "./hls.js";

const DEFAULTS = {
  startupTimeoutMs: 8000,
  startupQueueTimeoutMs: 1500,
  stallTimeoutMs: 15000,
  relayGraceMs: 8000,
  failoverWindowMs: 12000,
  failureCooldownMs: 10000,
  notFoundCooldownMs: 300000,
  sourceFailureCooldownMs: 60000,
  maxClientBufferBytes: 8 * 1024 * 1024,
  startupBufferBytes: 256 * 1024,
  replayBufferBytes: 1024 * 1024,
  failoverKeepaliveMs: 500,
  userAgent: "VLC/3.0.20 LibVLC/3.0.20",
};

class UpstreamError extends Error {
  constructor(message, { status = 0, code = "upstream_error" } = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = Number(status || 0);
    this.code = code;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function errorLabel(error) {
  if (error?.name === "AbortError") return "upstream timeout";
  if (error instanceof UpstreamError) return error.message;
  return String(error?.message || error || "upstream failure");
}

const TS_PACKET_SIZE = 188;
const TS_SYNC_CHECK_PACKETS = 3;

function findTsSyncOffset(value) {
  const data = Buffer.from(value || []);
  const required = TS_PACKET_SIZE * TS_SYNC_CHECK_PACKETS;
  if (data.length < required) return -1;
  for (let offset = 0; offset < TS_PACKET_SIZE; offset += 1) {
    let ok = true;
    for (let packet = 0; packet < TS_SYNC_CHECK_PACKETS; packet += 1) {
      if (data[offset + packet * TS_PACKET_SIZE] !== 0x47) {
        ok = false;
        break;
      }
    }
    if (ok) return offset;
  }
  return -1;
}

export class StreamManager {
  constructor({
    fetchImpl = globalThis.fetch,
    loadSnapshot,
    loadState,
    now = () => Date.now(),
    options = {},
    logger = console,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("StreamManager requires fetch");
    if (typeof loadSnapshot !== "function") throw new Error("StreamManager requires loadSnapshot");
    if (typeof loadState !== "function") throw new Error("StreamManager requires loadState");
    this.fetchImpl = fetchImpl;
    this.loadSnapshot = loadSnapshot;
    this.loadState = loadState;
    this.now = now;
    this.options = { ...DEFAULTS, ...options };
    this.logger = logger;
    this.relays = new Map();
    this.sourceUsage = new Map();
    this.variantCooldowns = new Map();
    this.sourceCooldowns = new Map();
    this.recentEvents = [];
    this.shuttingDown = false;
  }

  async handle(channelToken, req, res) {
    if (this.shuttingDown) return this.#respond(res, 503, "stream proxy is shutting down");

    const snapshot = await this.loadSnapshot();
    const channel = (snapshot.channels || []).find((row) =>
      String(row.id) === String(channelToken) || String(row.tvgId) === String(channelToken)
    );
    if (!channel) return this.#respond(res, 404, "channel not found");
    if (!(channel.variants || []).length) return this.#respond(res, 503, "channel has no playable variants");

    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-store" });
      return res.end();
    }
    if (req.method !== "GET") return this.#respond(res, 405, "method not allowed");

    let relay = this.relays.get(String(channel.id));
    if (!relay || relay.ended) {
      relay = this.#newRelay(channel);
      this.relays.set(String(channel.id), relay);
      this.#attachClient(relay, res);
      relay.task = this.#runRelay(relay).catch((error) => {
        if (!relay.stopRequested) this.logger.error?.(`[stream ${relay.channelName}] relay crashed: ${errorLabel(error)}`);
        this.#failClients(relay, relay.everStarted ? null : 502, "upstream unavailable");
      }).finally(() => this.#finalizeRelay(relay));
      return relay.task;
    }

    this.#attachClient(relay, res);
    return relay.task;
  }

  async status() {
    const state = await this.loadState();
    const now = this.now();
    this.#pruneCooldowns(now);

    const relays = [...this.relays.values()]
      .filter((relay) => !relay.ended)
      .map((relay) => ({
        channelId: relay.channelId,
        channelName: relay.channelName,
        tvgId: relay.tvgId,
        status: relay.status,
        viewers: relay.clients.size,
        sourceId: relay.current?.sourceId || null,
        sourceName: relay.current?.sourceName || null,
        provider: relay.current?.provider || null,
        account: relay.current?.account || null,
        quality: relay.current?.quality || null,
        transport: relay.current?.transport || null,
        backup: relay.current?.backup || false,
        variantOrder: Number.isFinite(relay.current?.order) ? relay.current.order : null,
        startedAt: iso(relay.startedAt),
        upstreamStartedAt: iso(relay.upstreamStartedAt),
        lastByteAt: iso(relay.lastByteAt),
        bytes: relay.bytes,
        bitrateMbps: Number(relay.bitrateMbps.toFixed(2)),
        failovers: relay.failovers,
        attempts: relay.attempts,
      }));

    const channelsBySource = new Map();
    for (const relay of relays) {
      if (!relay.sourceId) continue;
      const list = channelsBySource.get(relay.sourceId) || [];
      list.push({ channelId: relay.channelId, channelName: relay.channelName, viewers: relay.viewers });
      channelsBySource.set(relay.sourceId, list);
    }

    const sources = (state.sources || []).map((source) => {
      const sourceId = String(source.id);
      const active = this.sourceUsage.get(sourceId) || 0;
      const maxStreams = Math.max(1, Number(source.maxStreams || 1));
      const cooldownUntil = this.sourceCooldowns.get(sourceId) || 0;
      return {
        id: source.id,
        name: source.name,
        provider: source.provider || source.name,
        account: source.account || source.name,
        enabled: source.enabled !== false,
        maxStreams,
        activeStreams: active,
        availableStreams: Math.max(0, maxStreams - active),
        coolingDown: cooldownUntil > now,
        cooldownUntil: cooldownUntil > now ? iso(cooldownUntil) : null,
        channels: channelsBySource.get(sourceId) || [],
      };
    });

    return {
      activeRelays: relays.length,
      viewers: relays.reduce((sum, row) => sum + row.viewers, 0),
      upstreamConnections: sources.reduce((sum, row) => sum + row.activeStreams, 0),
      relays,
      sources,
      recentEvents: this.recentEvents.slice(-30),
    };
  }

  shutdown() {
    this.shuttingDown = true;
    for (const relay of this.relays.values()) {
      relay.stopRequested = true;
      if (relay.graceTimer) clearTimeout(relay.graceTimer);
      relay.abortController?.abort();
      for (const client of relay.clients) {
        if (!client.res.destroyed) client.res.destroy();
      }
    }
  }

  #newRelay(channel) {
    const now = this.now();
    return {
      channel: structuredClone(channel),
      channelId: String(channel.id),
      channelName: String(channel.name || channel.tvgId || channel.id),
      tvgId: String(channel.tvgId || ""),
      clients: new Set(),
      status: "starting",
      current: null,
      reservedSourceId: null,
      createdAt: now,
      startedAt: 0,
      upstreamStartedAt: 0,
      lastByteAt: 0,
      bytes: 0,
      bitrateMbps: 0,
      rateSampleAt: now,
      rateSampleBytes: 0,
      failovers: 0,
      attempts: 0,
      everStarted: false,
      headers: null,
      stopRequested: false,
      ended: false,
      abortController: null,
      graceTimer: null,
      task: null,
      replay: [],
      replayBytes: 0,
      keepaliveCc: 0,
      lastKeepaliveAt: 0,
    };
  }

  #attachClient(relay, res) {
    if (relay.graceTimer) {
      clearTimeout(relay.graceTimer);
      relay.graceTimer = null;
      if (relay.status === "grace") relay.status = relay.current ? "streaming" : "starting";
    }

    res.socket?.setKeepAlive?.(true, 30000);
    res.socket?.setNoDelay?.(true);
    const client = { res, headersSent: false, connectedAt: this.now() };
    relay.clients.add(client);
    if (relay.headers) {
      this.#sendHeaders(client, relay.headers);
      const replay = relay.replay.length
        ? Buffer.concat(relay.replay, relay.replayBytes)
        : Buffer.alloc(0);
      const syncOffset = findTsSyncOffset(replay);
      const alignedReplay = syncOffset >= 0 ? replay.subarray(syncOffset) : replay;
      if (alignedReplay.length && !res.destroyed && !res.writableEnded) {
        try { res.write(alignedReplay); } catch {}
      }
    }

    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      relay.clients.delete(client);
      this.#scheduleGraceIfIdle(relay);
    };
    res.once("close", detach);
    res.once("error", detach);
  }

  #scheduleGraceIfIdle(relay) {
    if (relay.clients.size || relay.stopRequested || relay.ended || relay.graceTimer) return;
    relay.status = "grace";
    relay.graceTimer = setTimeout(() => {
      relay.graceTimer = null;
      if (relay.clients.size || relay.ended) return;
      relay.stopRequested = true;
      relay.abortController?.abort();
    }, Math.max(0, this.options.relayGraceMs));
    relay.graceTimer.unref?.();
  }

  async #runRelay(relay) {
    const startupAttempted = new Set();
    const startupStartedAt = this.now();
    let failoverStartedAt = 0;

    while (!relay.stopRequested) {
      if (!relay.clients.size && !relay.everStarted && !relay.graceTimer) {
        relay.stopRequested = true;
        break;
      }

      const state = await this.loadState();
      if (relay.everStarted && failoverStartedAt
        && this.now() - failoverStartedAt >= this.options.failoverWindowMs) {
        this.#event("failover-exhausted", relay, null, "failover deadline exceeded");
        this.#failClients(relay, null, "upstream unavailable");
        break;
      }
      const selection = this.#selectAndReserve(relay, state, startupAttempted);
      if (!selection) {
        if (!relay.everStarted) {
          const candidates = this.#eligibleCandidates(relay, state);
          const allTried = candidates.length > 0 && candidates.every(({ candidate }) =>
            startupAttempted.has(this.#variantKey(relay, candidate))
          );
          const queueExpired = this.now() - startupStartedAt >= this.options.startupQueueTimeoutMs;
          if (allTried || !candidates.length || queueExpired) {
            this.#failClients(
              relay,
              503,
              candidates.length ? "all upstream candidates failed or are busy" : "all provider accounts are busy or unavailable"
            );
            break;
          }
          await sleep(50);
          continue;
        }

        if (!relay.clients.size && !relay.graceTimer) break;
        if (!failoverStartedAt) failoverStartedAt = this.now();
        if (this.now() - failoverStartedAt >= this.options.failoverWindowMs) {
          this.#event("failover-exhausted", relay, null, "no upstream became available before failover deadline");
          this.#failClients(relay, null, "upstream unavailable");
          break;
        }
        relay.status = "failover";
        if (this.options.failoverKeepaliveMs > 0
          && this.now() - relay.lastKeepaliveAt >= this.options.failoverKeepaliveMs) {
          this.#broadcastKeepalive(relay);
        }
        await sleep(250);
        continue;
      }

      const { candidate, source } = selection;
      const variantKey = this.#variantKey(relay, candidate);
      startupAttempted.add(variantKey);
      relay.attempts += 1;
      relay.status = relay.everStarted ? "failover" : "starting";
      relay.reservedSourceId = String(source.id);

      let connection = null;
      let keepaliveTimer = null;
      try {
        if (relay.everStarted && this.options.failoverKeepaliveMs > 0) {
          keepaliveTimer = setInterval(
            () => this.#broadcastKeepalive(relay),
            Math.max(100, this.options.failoverKeepaliveMs)
          );
          keepaliveTimer.unref?.();
        }
        let openTimeoutMs = this.options.startupTimeoutMs;
        if (relay.everStarted && failoverStartedAt) {
          const remaining = this.options.failoverWindowMs - (this.now() - failoverStartedAt);
          if (remaining <= 0) {
            throw new UpstreamError("failover deadline exceeded", { code: "failover_timeout" });
          }
          openTimeoutMs = Math.max(1, Math.min(openTimeoutMs, remaining));
        }
        connection = await this.#openCandidate(candidate, relay, openTimeoutMs);
        if (relay.stopRequested) break;

        relay.current = {
          sourceId: String(source.id),
          sourceName: source.name,
          provider: source.provider || source.name,
          account: source.account || source.name,
          maxStreams: Math.max(1, Number(source.maxStreams || 1)),
          quality: candidate.quality || "UNKNOWN",
          transport: connection.transport || "mpegts",
          backup: candidate.backup === true,
          order: Number(candidate.order || 0),
        };
        relay.abortController = connection.controller;
        relay.upstreamStartedAt = this.now();
        relay.lastByteAt = relay.upstreamStartedAt;
        failoverStartedAt = 0;
        this.variantCooldowns.delete(variantKey);
        this.sourceCooldowns.delete(String(source.id));

        if (!relay.everStarted) {
          relay.everStarted = true;
          relay.startedAt = this.now();
          relay.headers = {
            "content-type": connection.contentType,
            "cache-control": "no-store, no-cache, must-revalidate",
            pragma: "no-cache",
            "x-justone-relay": "1",
          };
          for (const client of relay.clients) this.#sendHeaders(client, relay.headers);
          this.#event("started", relay, source, "upstream connected");
        } else {
          relay.failovers += 1;
          this.#event("failover", relay, source, "upstream switched");
        }
        relay.status = relay.clients.size ? "streaming" : "grace";

        this.#broadcast(relay, connection.firstChunk);
        let endedNormally = false;
        while (!relay.stopRequested) {
          if (!relay.clients.size && !relay.graceTimer) break;
          const part = await this.#readWithStallTimeout(connection.reader, connection.controller);
          if (part.done) {
            endedNormally = true;
            break;
          }
          if (!part.value?.byteLength) continue;
          relay.lastByteAt = this.now();
          this.#broadcast(relay, part.value);
        }

        if (relay.stopRequested || (!relay.clients.size && !relay.graceTimer)) break;
        if (endedNormally) throw new UpstreamError("upstream stream ended", { code: "ended" });
      } catch (error) {
        if (relay.stopRequested) break;
        this.#markFailure(relay, candidate, source, error);
        if (!relay.everStarted) continue;
        // Do not let a viewer joining during/after failover replay stale bytes
        // from the failed upstream. Existing viewers keep their open stream and
        // receive TS keepalives while the replacement source is selected.
        relay.replay = [];
        relay.replayBytes = 0;
        if (!relay.clients.size && !relay.graceTimer) break;
        if (!failoverStartedAt) failoverStartedAt = this.now();
      } finally {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        if (connection?.reader) {
          try { await connection.reader.cancel(); } catch {}
        }
        connection?.controller?.abort();
        if (relay.abortController === connection?.controller) relay.abortController = null;
        this.#releaseSource(source.id);
        if (relay.reservedSourceId === String(source.id)) relay.reservedSourceId = null;
        if (relay.current?.sourceId === String(source.id)) relay.current = null;
      }
    }
  }

  #eligibleCandidates(relay, state) {
    const sources = new Map((state.sources || []).map((source) => [String(source.id), source]));
    const now = this.now();
    return [...(relay.channel.variants || [])]
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
      .map((candidate) => ({ candidate, source: sources.get(String(candidate.sourceId)) }))
      .filter(({ candidate, source }) => {
        if (!source || source.enabled === false || !candidate.url) return false;
        if ((this.sourceCooldowns.get(String(source.id)) || 0) > now) return false;
        if ((this.variantCooldowns.get(this.#variantKey(relay, candidate)) || 0) > now) return false;
        return true;
      });
  }

  #selectAndReserve(relay, state, attempted = new Set()) {
    const saturated = [];
    for (const row of this.#eligibleCandidates(relay, state)) {
      const key = this.#variantKey(relay, row.candidate);
      if (!relay.everStarted && attempted.has(key)) continue;
      const sourceId = String(row.source.id);
      const used = this.sourceUsage.get(sourceId) || 0;
      const maxStreams = Math.max(1, Number(row.source.maxStreams || row.candidate.maxStreams || 1));
      if (used >= maxStreams) {
        saturated.push(sourceId);
        continue;
      }
      this.sourceUsage.set(sourceId, used + 1);
      return row;
    }

    // Preserve reconnect grace whenever another account is genuinely free.
    // Only reclaim an idle relay after every eligible candidate was saturated.
    for (const sourceId of saturated) {
      if (this.#preemptIdleRelay(sourceId, relay.channelId)) break;
    }
    return null;
  }

  #preemptIdleRelay(sourceId, requestingChannelId) {
    const key = String(sourceId);
    for (const other of this.relays.values()) {
      if (other.ended || other.stopRequested || other.clients.size || !other.graceTimer) continue;
      const occupiedBy = String(other.current?.sourceId || other.reservedSourceId || "");
      if (occupiedBy !== key) continue;

      other.stopRequested = true;
      clearTimeout(other.graceTimer);
      other.graceTimer = null;
      other.abortController?.abort();
      this.#event(
        "idle-relay-preempted",
        other,
        null,
        `released idle account capacity for channel ${requestingChannelId}`
      );
      return true;
    }
    return false;
  }

  #releaseSource(sourceId) {
    const key = String(sourceId);
    const used = this.sourceUsage.get(key) || 0;
    if (used <= 1) this.sourceUsage.delete(key);
    else this.sourceUsage.set(key, used - 1);
  }

  async #openCandidate(candidate, relay = null, timeoutMs = this.options.startupTimeoutMs) {
    const controller = new AbortController();
    if (relay) relay.abortController = controller;
    let timer;
    try {
      timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
      timer.unref?.();
      const response = await this.fetchImpl(candidate.url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          accept: "video/mp2t,video/*,*/*",
          "accept-encoding": "identity",
          "user-agent": this.options.userAgent,
        },
      });
      if (!response.ok) {
        throw new UpstreamError(`upstream HTTP ${response.status}`, { status: response.status, code: "http" });
      }
      if (!response.body) throw new UpstreamError("upstream returned no response body", { code: "empty" });

      let reader;
      let transport = "mpegts";
      if (isHlsResponse(response, candidate.url)) {
        transport = "hls";
        try {
          reader = await HlsMpegTsReader.create({
            fetchImpl: this.fetchImpl,
            initialResponse: response,
            candidateUrl: candidate.url,
            signal: controller.signal,
            userAgent: this.options.userAgent,
          });
        } catch (error) {
          throw new UpstreamError(
            `HLS startup failed: ${error?.message || error}`,
            { status: Number(error?.status || 0), code: "hls_startup" }
          );
        }
      } else {
        reader = response.body.getReader();
      }
      const chunks = [];
      let buffered = 0;
      const target = Math.max(TS_PACKET_SIZE * TS_SYNC_CHECK_PACKETS, Number(this.options.startupBufferBytes || 1));
      while (buffered < target) {
        const part = await reader.read();
        if (part.done) break;
        if (!part.value?.byteLength) continue;
        chunks.push(Buffer.from(part.value));
        buffered += part.value.byteLength;
      }
      if (!buffered) {
        try { await reader.cancel(); } catch {}
        throw new UpstreamError("upstream closed before first media bytes", { code: "empty" });
      }
      if (buffered < target) {
        try { await reader.cancel(); } catch {}
        throw new UpstreamError(
          `upstream ended during startup buffer (${buffered}/${target} bytes)`,
          { code: "short_startup" }
        );
      }
      const firstChunk = Buffer.concat(chunks, buffered);
      const syncOffset = findTsSyncOffset(firstChunk);
      if (syncOffset < 0) {
        try { await reader.cancel(); } catch {}
        throw new UpstreamError("upstream did not contain valid MPEG-TS sync packets", { code: "invalid_mpegts" });
      }
      return {
        controller,
        reader,
        firstChunk: syncOffset ? firstChunk.subarray(syncOffset) : firstChunk,
        contentType: "video/mp2t",
        transport,
      };
    } catch (error) {
      controller.abort();
      if (error?.name === "AbortError") {
        throw new UpstreamError("upstream startup timed out", { code: "startup_timeout" });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #readWithStallTimeout(reader, controller) {
    let timer;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new UpstreamError("upstream stalled", { code: "stall" }));
          }, Math.max(1, this.options.stallTimeoutMs));
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #broadcast(relay, chunk) {
    const data = Buffer.from(chunk);
    relay.bytes += data.length;
    this.#updateRate(relay);
    this.#rememberReplay(relay, data);

    for (const client of [...relay.clients]) {
      const { res } = client;
      if (res.destroyed || res.writableEnded) {
        relay.clients.delete(client);
        continue;
      }
      if (!client.headersSent && relay.headers) this.#sendHeaders(client, relay.headers);
      if (!client.headersSent) continue;
      try {
        res.write(data);
        if (Number(res.writableLength || 0) > this.options.maxClientBufferBytes) {
          relay.clients.delete(client);
          res.destroy();
          this.#event("slow-client-dropped", relay, null, "downstream buffer exceeded limit");
        }
      } catch {
        relay.clients.delete(client);
        res.destroy();
      }
    }
    this.#scheduleGraceIfIdle(relay);
  }

  #rememberReplay(relay, data) {
    const limit = Math.max(0, Number(this.options.replayBufferBytes || 0));
    if (!limit || !data.length) return;
    // Copy a truncated suffix instead of retaining a subarray view into a much
    // larger upstream chunk. That keeps the replay buffer's real retained memory
    // bounded by replayBufferBytes as well as its logical byte count.
    const kept = data.length > limit
      ? Buffer.from(data.subarray(data.length - limit))
      : data;
    relay.replay.push(kept);
    relay.replayBytes += kept.length;
    while (relay.replay.length > 1 && relay.replayBytes > limit) {
      const removed = relay.replay.shift();
      relay.replayBytes -= removed.length;
    }
  }

  #broadcastKeepalive(relay) {
    if (!relay.clients.size) return;
    const packet = Buffer.alloc(188, 0xff);
    packet[0] = 0x47;
    packet[1] = 0x1f;
    packet[2] = 0xff;
    packet[3] = 0x10 | (relay.keepaliveCc & 0x0f);
    relay.keepaliveCc = (relay.keepaliveCc + 1) & 0x0f;
    relay.lastKeepaliveAt = this.now();
    for (const client of [...relay.clients]) {
      const { res } = client;
      if (res.destroyed || res.writableEnded || !client.headersSent) continue;
      try { res.write(packet); } catch { relay.clients.delete(client); }
    }
  }

  #sendHeaders(client, headers) {
    if (client.headersSent || client.res.destroyed || client.res.writableEnded) return;
    client.res.writeHead(200, headers);
    client.res.flushHeaders?.();
    client.headersSent = true;
  }

  #failClients(relay, status, message) {
    for (const client of [...relay.clients]) {
      const { res } = client;
      if (res.destroyed || res.writableEnded) continue;
      if (status && !client.headersSent && !res.headersSent) {
        this.#respond(res, status, message);
      } else {
        res.destroy();
      }
    }
    relay.clients.clear();
  }

  #respond(res, status, message) {
    if (res.destroyed || res.writableEnded) return;
    const body = Buffer.from(String(message || ""));
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    res.end(body);
  }

  #markFailure(relay, candidate, source, error) {
    const now = this.now();
    const status = Number(error?.status || 0);
    let cooldown = this.options.failureCooldownMs;
    let sourceWide = false;
    if ([401, 403, 429].includes(status)) {
      sourceWide = true;
      cooldown = this.options.sourceFailureCooldownMs;
    } else if (status === 404 || error?.code === "hls_unsupported") {
      cooldown = this.options.notFoundCooldownMs;
    }

    if (sourceWide) this.sourceCooldowns.set(String(source.id), now + cooldown);
    else this.variantCooldowns.set(this.#variantKey(relay, candidate), now + cooldown);

    const detail = errorLabel(error);
    this.#event("upstream-failure", relay, source, detail);
    this.logger.warn?.(
      `[stream ${relay.channelName}] ${source.provider || source.name}/${source.account || source.name} failed: ${detail}`
    );
  }

  #variantKey(relay, candidate) {
    return `${relay.channelId}|${candidate.sourceId}|${Number(candidate.order || 0)}`;
  }

  #updateRate(relay) {
    const now = this.now();
    const elapsed = now - relay.rateSampleAt;
    if (elapsed < 1000) return;
    const bytes = relay.bytes - relay.rateSampleBytes;
    relay.bitrateMbps = (bytes * 8) / elapsed / 1000;
    relay.rateSampleAt = now;
    relay.rateSampleBytes = relay.bytes;
  }

  #event(type, relay, source, message) {
    const row = {
      at: new Date(this.now()).toISOString(),
      type,
      channelId: relay.channelId,
      channelName: relay.channelName,
      sourceId: source?.id || relay.current?.sourceId || null,
      provider: source?.provider || relay.current?.provider || null,
      account: source?.account || relay.current?.account || null,
      message,
    };
    this.recentEvents.push(row);
    if (this.recentEvents.length > 100) this.recentEvents.splice(0, this.recentEvents.length - 100);
  }

  #pruneCooldowns(now = this.now()) {
    for (const [key, until] of this.variantCooldowns) {
      if (until <= now) this.variantCooldowns.delete(key);
    }
    for (const [key, until] of this.sourceCooldowns) {
      if (until <= now) this.sourceCooldowns.delete(key);
    }
  }

  #finalizeRelay(relay) {
    relay.abortController?.abort();
    if (relay.graceTimer) clearTimeout(relay.graceTimer);
    relay.ended = true;
    relay.status = "ended";
    relay.current = null;
    relay.reservedSourceId = null;
    if (this.relays.get(relay.channelId) === relay) this.relays.delete(relay.channelId);
  }
}

export { UpstreamError };
