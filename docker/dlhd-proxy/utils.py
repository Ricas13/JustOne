import base64
import binascii
import json
import os
import re
from pathlib import Path
from typing import Any

KEY_FILE_ENV_VAR = "DLHD_PROXY_KEY_FILE"
DEFAULT_KEY_PATH = Path("data/token.key")
MIN_KEY_LENGTH = 32
GENERATED_KEY_LENGTH = 64
PAYLOAD_PREFIX = b"justone_dlhd::"
PAYLOAD_PREFIX_STR = PAYLOAD_PREFIX.decode()


def _key_file_path() -> Path:
    raw = os.environ.get(KEY_FILE_ENV_VAR)
    return Path(raw).expanduser() if raw else DEFAULT_KEY_PATH


def _load_or_create_key() -> bytes:
    path = _key_file_path()
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        data = None
    if data is not None:
        if len(data) < MIN_KEY_LENGTH:
            raise RuntimeError(f"Token key at {path} must be at least {MIN_KEY_LENGTH} bytes")
        return data

    key = os.urandom(GENERATED_KEY_LENGTH)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _load_or_create_key()
    with os.fdopen(fd, "wb") as handle:
        handle.write(key)
    return key


key_bytes = _load_or_create_key()


def xor(input_bytes: bytes) -> bytes:
    return bytes(input_bytes[i] ^ key_bytes[i % len(key_bytes)] for i in range(len(input_bytes)))


def encrypt(value: str) -> str:
    payload = PAYLOAD_PREFIX + value.encode()
    return base64.urlsafe_b64encode(xor(payload)).decode().rstrip("=")


def decrypt(value: str) -> str:
    padding = "=" * (-len(value) % 4)
    token = value + padding
    if not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", token):
        raise ValueError("Invalid encrypted payload")
    try:
        raw = base64.urlsafe_b64decode(token)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Invalid encrypted payload") from exc
    try:
        decoded = xor(raw).decode()
    except UnicodeDecodeError as exc:
        raise ValueError("Invalid encrypted payload") from exc
    if not decoded.startswith(PAYLOAD_PREFIX_STR):
        raise ValueError("Invalid encrypted payload")
    return decoded[len(PAYLOAD_PREFIX_STR):]


def decode_bundle(response_text: str) -> dict[str, Any]:
    def normalize(data: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, value in data.items():
            if isinstance(value, str):
                try:
                    out[key] = base64.b64decode(value + "=" * (-len(value) % 4)).decode("utf-8")
                except Exception:
                    out[key] = value
            else:
                out[key] = value
        return out

    def parse_candidate(candidate: str) -> dict[str, Any] | None:
        try:
            decoded = base64.b64decode(candidate + "=" * (-len(candidate) % 4)).decode("utf-8")
            data = json.loads(decoded)
        except Exception:
            return None
        if any(key in data for key in ("b_ts", "b_sig", "b_host", "b_rnd")):
            return normalize(data)
        return None

    candidates = {response_text.strip()}
    candidates.update(re.findall(r'JSON\.parse\s*\(\s*atob\s*\(\s*["\']([^"\']{40,})["\']\s*\)\s*\)', response_text))
    candidates.update(re.findall(r'atob\s*\(\s*["\'](eyJ[A-Za-z0-9+/=]{40,})["\']\s*\)', response_text))
    candidates.update(re.findall(r'["\'](eyJ[A-Za-z0-9+/=]{40,})["\']', response_text))
    candidates.update(re.findall(r'["\']([A-Za-z0-9+/=]{80,})["\']', response_text))

    for candidate in candidates:
        parsed = parse_candidate(candidate)
        if parsed:
            return parsed
    return {}
