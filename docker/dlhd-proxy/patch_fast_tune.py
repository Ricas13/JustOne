from pathlib import Path

path = Path("dlhd_proxy/step_daddy.py")
text = path.read_text()

if "import time\n" not in text:
    text = text.replace("import re\n", "import re\nimport time\n", 1)

start = text.index("    async def stream(self, channel_id: str):\n")
end = text.index("    async def key(self, url: str, host: str):\n", start)
stream = text[start:end]

# Keep the whole player-family walk within Jellyfin's cold-tune budget. Individual
# network waits get at most 1.75s and the complete stream() resolver gets 2.5s.
# Fast HTTP/DNS failures still fall through immediately and the first media-proven
# embed still wins. This prevents six sequential families from adding up to 20s+.
anchor = '        channel_key = str(channel_id)\n        player_folders = ("stream", "watch", "cast", "plus", "player", "casting")\n'
assert anchor in stream, "player-family deadline anchor changed"
stream = stream.replace(
    anchor,
    anchor + "        tune_deadline = time.monotonic() + 2.5\n",
    1,
)

loop_anchor = "        for folder in ordered_folders:\n"
assert loop_anchor in stream, "player-family loop anchor changed"
stream = stream.replace(
    loop_anchor,
    loop_anchor
    + "            if time.monotonic() >= tune_deadline:\n"
    + "                failures.append(\"player budget exhausted\")\n"
    + "                break\n",
    1,
)

old_12 = stream.count("timeout=12,")
old_8 = stream.count("timeout=8,")
assert old_12 > 0, "expected player/source timeout anchors were not found"
assert old_8 > 0, "expected HLS media-probe timeout anchors were not found"

timeout_expr = "max(0.25, min(1.75, tune_deadline - time.monotonic()))"
stream = stream.replace("timeout=12,", f"timeout={timeout_expr},")
stream = stream.replace("timeout=8,", f"timeout={timeout_expr},")
assert "timeout=12," not in stream
assert "timeout=8," not in stream

text = text[:start] + stream + text[end:]
path.write_text(text)
