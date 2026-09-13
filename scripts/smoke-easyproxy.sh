#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="${SMOKE_PROJECT:-justone-easyproxy-smoke}"
PORT="${SMOKE_PORT:-18090}"
BASE="${SMOKE_PUBLIC_URL:-http://127.0.0.1:${PORT}}"
CHANNEL_LIMIT="${SMOKE_CHANNEL_LIMIT:-8}"
CHANNEL_MATCH="${SMOKE_CHANNEL_MATCH:-}"
TUNE_TIMEOUT="${SMOKE_TUNE_TIMEOUT:-75}"
KEEP="${KEEP_SMOKE:-0}"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.smoke.yml)
TMP="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP"
  if [[ "$KEEP" != "1" ]]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  else
    echo "KEEP_SMOKE=1: leaving project $PROJECT running"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- smoke stack status ---" >&2
  "${COMPOSE[@]}" ps >&2 || true
  echo "--- recent logs ---" >&2
  "${COMPOSE[@]}" logs --tail=120 >&2 || true
  exit 1
}

json_assert() {
  python - "$@"
}

fetch_manifest_chain() {
  local url="$1"
  local depth=0
  local body="$TMP/chain.body"
  local next="$url"

  while (( depth < 5 )); do
    depth=$((depth + 1))
    if ! curl -fsS --max-time 25 "$next" -o "$body"; then
      return 1
    fi

    if head -c 32 "$body" | grep -q '^#EXTM3U'; then
      # If this level advertises an AES key, prove the signed key route works.
      local key_url
      key_url="$(python - "$body" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'#EXT-X-KEY:[^\n]*?URI=["\']([^"\']+)', text, re.I)
print(m.group(1) if m else '')
PY
)"
      if [[ -n "$key_url" ]]; then
        if ! curl -fsS --max-time 20 "$key_url" -o "$TMP/key.bin"; then
          return 1
        fi
        [[ -s "$TMP/key.bin" ]] || return 1
      fi

      next="$(awk 'NF && $0 !~ /^#/ {gsub(/\r$/, ""); print; exit}' "$body")"
      [[ -n "$next" ]] || return 1
      continue
    fi

    # Reaching non-empty binary/media bytes proves the signed bridge can carry
    # actual media rather than only manifests.
    [[ -s "$body" ]] || return 1
    local size
    size="$(wc -c < "$body")"
    echo "media_bytes=$size chain_depth=$depth"
    return 0
  done

  return 1
}

echo "Starting isolated smoke project: $PROJECT"
"${COMPOSE[@]}" up -d --build --remove-orphans

health_code=""
for _ in $(seq 1 90); do
  health_code="$(curl -sS -o "$TMP/health.json" -w '%{http_code}' --max-time 3 "$BASE/jellyfin/health" || true)"
  if [[ "$health_code" == "200" ]]; then
    break
  fi
  sleep 1
done
[[ "$health_code" == "200" ]] || fail "Jellyfin-facing health never became ready (last HTTP $health_code)"

python - "$TMP/health.json" <<'PY' || fail "health payload is not fully ready"
import json, sys
x = json.load(open(sys.argv[1]))
assert x.get('ok') is True, x
assert x.get('metadataOk') is True, x
assert x.get('playback') == 'easyproxy-hls', x
engine = x.get('engine') or {}
assert engine.get('ok') is True, x
assert engine.get('dlhdExtractorLoaded') is True, x
print(f"health_ok channels={x.get('channels')} raw={x.get('rawChannels')}")
PY

curl -fsS --max-time 20 "$BASE/jellyfin/playlist.m3u8" -o "$TMP/playlist.m3u8" 
grep -q '^#EXTM3U' "$TMP/playlist.m3u8" || fail "playlist is not M3U"
grep -q '/jellyfin/play/.*\.m3u8' "$TMP/playlist.m3u8" || fail "playlist does not advertise HLS tune URLs"
if grep -Eq '/jellyfin/play/.*\.ts([?[:space:]]|$)' "$TMP/playlist.m3u8"; then
  fail "playlist still advertises removed .ts playback URLs"
fi

python - "$TMP/playlist.m3u8" "$CHANNEL_MATCH" "$CHANNEL_LIMIT" > "$TMP/candidates.tsv" <<'PY'
import re, sys
path, wanted, limit = sys.argv[1], sys.argv[2].lower().strip(), int(sys.argv[3])
name = ''
out = []
for raw in open(path, encoding='utf-8', errors='replace'):
    line = raw.strip()
    if line.startswith('#EXTINF:'):
        name = line.split(',', 1)[1] if ',' in line else line
    elif line.startswith(('http://', 'https://')) and '/jellyfin/play/' in line:
        if not wanted or wanted in name.lower():
            out.append((name, line))
for name, url in out[:limit]:
    print(name.replace('\t', ' '), url, sep='\t')
PY

[[ -s "$TMP/candidates.tsv" ]] || fail "no tune candidates matched SMOKE_CHANNEL_MATCH='$CHANNEL_MATCH'"

success=0
while IFS=$'\t' read -r name url; do
  echo "Testing tune: $name"
  if curl -fsS --max-time "$TUNE_TIMEOUT" "$url" -o "$TMP/tune.m3u8" \
      && head -c 32 "$TMP/tune.m3u8" | grep -q '^#EXTM3U' \
      && grep -q '/jellyfin/proxy/' "$TMP/tune.m3u8" \
      && fetch_manifest_chain "$url"; then
    echo "playback_ok=$name"
    success=1
    break
  fi
  echo "tune_failed=$name"
done < "$TMP/candidates.tsv"

[[ "$success" == "1" ]] || fail "none of the tested channels produced media through EasyProxy"

# Metadata must remain usable during a playback-engine outage.
"${COMPOSE[@]}" stop easyproxy >/dev/null
curl -fsS --max-time 10 "$BASE/jellyfin/playlist.m3u8" -o "$TMP/playlist-engine-down.m3u8" 
grep -q '^#EXTM3U' "$TMP/playlist-engine-down.m3u8" || fail "playlist disappeared when EasyProxy stopped"

down_code="$(curl -sS -o "$TMP/health-engine-down.json" -w '%{http_code}' --max-time 5 "$BASE/jellyfin/health" || true)"
[[ "$down_code" == "503" ]] || fail "health should be 503 while EasyProxy is stopped, got $down_code"
python - "$TMP/health-engine-down.json" <<'PY' || fail "engine-down health semantics are wrong"
import json, sys
x = json.load(open(sys.argv[1]))
assert x.get('metadataOk') is True, x
assert (x.get('engine') or {}).get('ok') is False, x
print('metadata_survives_engine_outage=true')
PY

"${COMPOSE[@]}" start easyproxy >/dev/null

echo "PASS: isolated EasyProxy engine smoke test completed"
