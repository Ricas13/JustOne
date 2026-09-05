from pathlib import Path

path = Path("dlhd_proxy/step_daddy.py")
text = path.read_text()

start = text.index("    async def stream(self, channel_id: str):\n")
end = text.index("    async def key(self, url: str, host: str):\n", start)
stream = text[start:end]

# The player-fallback patches deliberately walk several DLStreams families, but
# their 8s/12s per-request timeouts make a single dead family dominate Jellyfin
# startup. Bound each network wait to two seconds. Fast HTTP 404/500/DNS failures
# still fall through immediately; the first media-proven embed still wins.
old_12 = stream.count("timeout=12,")
old_8 = stream.count("timeout=8,")
assert old_12 > 0, "expected player/source timeout anchors were not found"
assert old_8 > 0, "expected HLS media-probe timeout anchors were not found"

stream = stream.replace("timeout=12,", "timeout=2.0,")
stream = stream.replace("timeout=8,", "timeout=2.0,")
assert "timeout=12," not in stream
assert "timeout=8," not in stream

text = text[:start] + stream + text[end:]
path.write_text(text)
