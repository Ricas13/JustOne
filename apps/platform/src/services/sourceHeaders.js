const headersByUrl = new Map();

export function rememberSourceHeaders(url, headers, ttlMs) {
  if (!url || !headers || typeof headers !== "object" || !Object.keys(headers).length) return;
  headersByUrl.set(String(url), {
    headers: { ...headers },
    exp: Date.now() + Math.max(1000, Number(ttlMs || 0)),
  });
}

export function sourceHeadersFor(url) {
  const key = String(url || "");
  const hit = headersByUrl.get(key);
  if (!hit) return {};
  if (Date.now() > hit.exp) {
    headersByUrl.delete(key);
    return {};
  }
  return { ...hit.headers };
}
