const FIELDS = ["channels", "logos", "guides"];

function usable(value) {
  return Array.isArray(value) && value.length > 0;
}

export function mergeIptvOrgSnapshot(previous = {}, fetched = {}) {
  const next = {};
  const reused = [];
  const missing = [];

  for (const field of FIELDS) {
    if (usable(fetched[field])) {
      next[field] = fetched[field];
    } else if (usable(previous[field])) {
      next[field] = previous[field];
      reused.push(field);
    } else {
      next[field] = [];
      missing.push(field);
    }
  }

  return { next, reused, missing };
}

export function iptvOrgSnapshotReady(snapshot = {}) {
  return FIELDS.every((field) => usable(snapshot[field]));
}

export function iptvOrgFetchComplete(fetched = {}) {
  return FIELDS.every((field) => usable(fetched[field]));
}
