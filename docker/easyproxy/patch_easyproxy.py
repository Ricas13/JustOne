from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else "/app")
app_path = root / "app.py"
dlhd_path = root / "dlhd_extractor.py"

app = app_path.read_text(encoding="utf-8")
old_restart = '''            if restarting:\n                logger.critical(f"❌ Critical error with {extractor_name}: {e}. Restarting to force update...")\n                await asyncio.sleep(1)  # Wait for log flush\n                os._exit(1)  # Forced exit to trigger restart from process manager (Docker, Gunicorn)\n'''
new_restart = '''            if restarting:\n                # A bad channel/extractor request must never terminate the shared\n                # EasyProxy worker. Keep failures request-local so callers can\n                # fall back without interrupting other viewers.\n                logger.error(f"❌ Extractor error with {extractor_name}: {e}")\n                return web.Response(text=f"Proxy error: {str(e)}", status=502)\n'''
if old_restart not in app:
    raise SystemExit("expected EasyProxy restart block not found; refusing unverified patch")
app = app.replace(old_restart, new_restart, 1)
if "os._exit(1)" in app:
    raise SystemExit("EasyProxy still contains os._exit(1) after patch")
app_path.write_text(app, encoding="utf-8")

dlhd = dlhd_path.read_text(encoding="utf-8")
old_cache = "self.cache_file = os.path.join(os.path.dirname(__file__), '.dlhd_cache')"
new_cache = 'self.cache_file = os.environ.get("EASYPROXY_CACHE_FILE", "/app/data/.dlhd_cache")'
if old_cache not in dlhd:
    raise SystemExit("expected EasyProxy DLHD cache declaration not found; refusing unverified patch")
dlhd = dlhd.replace(old_cache, new_cache, 1)

old_save = '''        try:\n            with open(self.cache_file, 'w', encoding='utf-8') as f:\n'''
new_save = '''        try:\n            os.makedirs(os.path.dirname(self.cache_file) or ".", exist_ok=True)\n            with open(self.cache_file, 'w', encoding='utf-8') as f:\n'''
if old_save not in dlhd:
    raise SystemExit("expected EasyProxy cache save block not found; refusing unverified patch")
dlhd = dlhd.replace(old_save, new_save, 1)
dlhd_path.write_text(dlhd, encoding="utf-8")

print("EasyProxy safety patch applied")
