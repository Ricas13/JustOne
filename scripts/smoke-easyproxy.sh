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

for command in docker curl awk grep sed head wc; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "FAIL: required host command '$command' is missing" >&2
    exit 1
  }
done

# Run JSON assertions inside the already-built catalogue container. This keeps
# the acceptance test independent of whether the deployment host has Python.
assert_health_payload() {
  "${COMPOSE[@]}" exec -T dlhd-catalogue python -c '
import json, sys
x = json.load(sys.stdin)
assert x.get("ok") is True, x
assert x.get("metadataOk") is True, x
assert x.get("playback") == "easyproxy-hls", x
engine = x.get("engine") or {}
assert engine.get("ok") is True, x
assert engine.get("dlhdExtractorLoaded") is True, x
print(f"health_ok channels={x.get(chr(99)+chr(104)+chr(97)+chr(110)+chr(110)+chr(101)+chr(108)+chr(115))} raw={x.get(chr(114)+chr(97)+chr(119)+chr(67)+chr(104)+chr(97)+chr(110)+chr(110)+chr(101)+chr(108)+chr(115))}")
'
}

assert_engine_down_payload() {
  "${COMPOSE[@]}" exec -T dlhd-catalogue python -c '
import json, sys
x = json.load(sys.stdin)
assert x.get("metadataOk") is True, x
assert (x.get("engine") or {}).get("ok") is False, x
print("metadata_survives_engine_outage=true")
'
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
      # HLS URI attributes use quoted strings. If this level advertises an
      # AES key, prove that the signed key bridge returns non-empty bytes.
      local key_url
      key_url="$(grep -i -m1 '^#EXT-X-KEY:' "$body" | sed -nE 's/.*URI="([^"]+)".*/\1/p' || true)"
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
  # Transient resets are expected while the Node listener is starting. Keep
  # probing silently until the public health endpoint returns a full HTTP 200.
  health_code="$(curl -s -o "$TMP/health.json" -w '%{http_code}' --max-time 3 "$BASE/jellyfin/health" || true)"
  if [[ "$health_code" == "200" ]] && assert_health_payload < "$TMP/health.json" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
[[ "$health_code" == "200" ]] || fail "Jellyfin-facing health never became ready (last HTTP $health_code)"
assert_health_payload < "$TMP/health.json" || fail "health payload is not fully ready"

curl -fsS --max-time 20 "$BASE/jellyfin/playlist.m3u8" -o "$TMP/playlist.m3u8"
grep -q '^#EXTM3U' "$TMP/playlist.m3u8" || fail "playlist is not M3U"
grep -q '/jellyfin/play/.*\.m3u8' "$TMP/playlist.m3u8" || fail "playlist does not advertise HLS tune URLs"
if grep -Eq '/jellyfin/play/.*\.ts([?[:space:]]|$)' "$TMP/playlist.m3u8"; then
  fail "playlist still advertises removed .ts playback URLs"
fi

awk -v wanted="$CHANNEL_MATCH" -v limit="$CHANNEL_LIMIT" '
BEGIN {
  wanted = tolower(wanted)
  name = ""
  count = 0
}
/^#EXTINF:/ {
  comma = index($0, ",")
  name = comma ? substr($0, comma + 1) : $0
  next
}
/^https?:\/\// && /\/jellyfin\/play\// {
  if (wanted == "" || index(tolower(name), wanted)) {
    gsub(/\t/, " ", name)
    print name "\t" $0
    count++
    if (count >= limit) exit
  }
}
' "$TMP/playlist.m3u8" > "$TMP/candidates.tsv"

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

down_code="$(curl -s -o "$TMP/health-engine-down.json" -w '%{http_code}' --max-time 5 "$BASE/jellyfin/health" || true)"
[[ "$down_code" == "503" ]] || fail "health should be 503 while EasyProxy is stopped, got $down_code"
assert_engine_down_payload < "$TMP/health-engine-down.json" || fail "engine-down health semantics are wrong"

"${COMPOSE[@]}" start easyproxy >/dev/null

echo "PASS: isolated EasyProxy engine smoke test completed"
