"""Windows-only DPAPI storage for Reader Manager.

The entire local configuration, including agent token, Telegram API hash and
StringSession values, is encrypted for the current Windows user. No plaintext
Telegram session file is written to disk.
"""
import base64
import ctypes
import json
import os
from ctypes import wintypes
from pathlib import Path


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data):
    buffer = ctypes.create_string_buffer(data)
    return DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def _crypt(data, protect=True):
    if os.name != "nt":
        raise RuntimeError("Reader Manager DPAPI storage requires Windows")
    source, source_buffer = _blob(data)
    output = DATA_BLOB()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    function = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    if protect:
        ok = function(ctypes.byref(source), "YeuNauAn Reader", None, None, None, 0, ctypes.byref(output))
    else:
        ok = function(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output))
    del source_buffer
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(output.pbData)


def config_path():
    root = Path(os.getenv("LOCALAPPDATA") or Path.home()) / "YeuNauAnReader"
    root.mkdir(parents=True, exist_ok=True)
    return root / "reader-manager.dat"


def load_config():
    path = config_path()
    if not path.exists():
        return {"version": 1, "profiles": []}
    encrypted = base64.b64decode(path.read_bytes())
    value = json.loads(_crypt(encrypted, protect=False).decode("utf-8"))
    if not isinstance(value, dict) or value.get("version") != 1:
        raise RuntimeError("Cấu hình Reader không hợp lệ")
    value.setdefault("profiles", [])
    return value


def save_config(value):
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded = base64.b64encode(_crypt(payload, protect=True))
    path = config_path()
    temporary = path.with_suffix(".tmp")
    temporary.write_bytes(encoded)
    os.replace(temporary, path)
    return path
