#!/usr/bin/env python3
"""Fail-closed, read-only Telegram download measurement for Reader 1.4.10.

This executable never imports Reader queue or object-storage code. It decrypts the
existing Windows Reader configuration in memory, opens the selected StringSession
without persisting it, and downloads only the three fixed Telegram messages into a
new temporary directory supplied by the launcher.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextvars
import ctypes
import datetime as dt
import hashlib
import json
import logging
import math
import os
import platform
import re
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path
from typing import Any

import psutil
import telethon
from telethon import TelegramClient
from telethon.crypto import aes as telethon_aes
from telethon.network.mtprotosender import MTProtoSender
from telethon.sessions import StringSession
from telethon.tl import functions


BUNDLE_VERSION = "1.0.0"
BASELINE_MAIN_SHA = "931c064798e1c5e278c88637129397643963fa26"
EXPECTED_PYTHON = (3, 12, 10)
EXPECTED_TELETHON = "1.45.0"
REQUEST_SIZE = 512 * 1024

_ACTIVE_FILE: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "anti_active_file", default=None
)
_ACTIVE_REQUEST: contextvars.ContextVar[int | None] = contextvars.ContextVar(
    "anti_active_request", default=None
)


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def append_jsonl(path: Path, value: Any) -> None:
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def percentile(values: list[float], percentile_value: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    position = (len(ordered) - 1) * percentile_value
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 3)
    result = ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)
    return round(result, 3)


_SECRET_PATTERNS = (
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"),
    re.compile(r"(?i)(api[_ -]?hash|session|string_session)(\s*[:=]\s*)\S+"),
    re.compile(r"\+[0-9]{7,15}"),
    re.compile(r"(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])"),
    re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{80,}={0,2}(?![A-Za-z0-9+/])"),
)


def sanitize_text(value: Any, limit: int = 500) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ")
    for pattern in _SECRET_PATTERNS:
        if pattern.groups >= 2:
            text = pattern.sub(r"\1\2[REDACTED]", text)
        elif pattern.groups == 1:
            text = pattern.sub(r"\1[REDACTED]", text)
        else:
            text = pattern.sub("[REDACTED]", text)
    return text[:limit]


def safe_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {sanitize_text(exc)}"


class DATA_BLOB(ctypes.Structure):
    _fields_ = (("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte)))


def _blob(data: bytes) -> tuple[DATA_BLOB, Any]:
    buffer = ctypes.create_string_buffer(data)
    return DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def dpapi_unprotect(data: bytes) -> bytes:
    if os.name != "nt":
        raise RuntimeError("windows_required")
    source, source_buffer = _blob(data)
    output = DATA_BLOB()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output)
    )
    del source_buffer
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(output.pbData)


def load_measurement_config(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise RuntimeError("measurement_config_invalid")
    profile_id = str(value.get("profile_id") or "").strip()
    channel = str(value.get("channel") or "").strip()
    if not re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        profile_id,
    ):
        raise RuntimeError("measurement_profile_id_invalid")
    if not re.fullmatch(r"-100\d+", channel):
        raise RuntimeError("measurement_channel_invalid")
    raw_targets = value.get("targets")
    if not isinstance(raw_targets, list) or len(raw_targets) != 3:
        raise RuntimeError("measurement_targets_must_contain_exactly_three_items")
    targets = []
    seen_ids = set()
    for item in raw_targets:
        if not isinstance(item, dict):
            raise RuntimeError("measurement_target_invalid")
        message_id = item.get("message_id")
        byte_count = item.get("bytes")
        filename = str(item.get("filename") or "").strip()
        if isinstance(message_id, bool) or not isinstance(message_id, int) or message_id < 1:
            raise RuntimeError("measurement_message_id_invalid")
        if message_id in seen_ids:
            raise RuntimeError("measurement_message_id_duplicate")
        if isinstance(byte_count, bool) or not isinstance(byte_count, int) or not (1 <= byte_count <= 2_147_483_647):
            raise RuntimeError("measurement_byte_count_invalid")
        if not filename or len(filename) > 180 or any(char in filename for char in "\r\n"):
            raise RuntimeError("measurement_filename_invalid")
        seen_ids.add(message_id)
        targets.append({"message_id": message_id, "bytes": byte_count, "filename": filename})
    return {"profile_id": profile_id, "channel": channel, "targets": tuple(targets)}


def load_reader_profile(config_path: Path, profile_id: str) -> dict[str, Any]:
    encrypted = base64.b64decode(config_path.read_bytes(), validate=True)
    config = json.loads(dpapi_unprotect(encrypted).decode("utf-8"))
    if not isinstance(config, dict) or config.get("version") != 1:
        raise RuntimeError("reader_config_invalid")
    profiles = config.get("profiles")
    if not isinstance(profiles, list):
        raise RuntimeError("reader_profiles_invalid")
    matches = [item for item in profiles if isinstance(item, dict) and item.get("id") == profile_id]
    if len(matches) != 1:
        raise RuntimeError("reader_profile_not_found_or_ambiguous")
    profile = matches[0]
    required = ("api_id", "api_hash", "session")
    if any(not str(profile.get(key) or "").strip() for key in required):
        raise RuntimeError("reader_profile_credentials_missing")
    try:
        api_id = int(str(profile["api_id"]).strip())
    except (TypeError, ValueError) as exc:
        raise RuntimeError("reader_profile_api_id_invalid") from exc
    return {
        "api_id": api_id,
        "api_hash": str(profile["api_hash"]),
        "session": str(profile["session"]),
    }


def selected_crypto_backend() -> str:
    if getattr(telethon_aes, "cryptg", None) is not None:
        return "cryptg"
    libssl = getattr(telethon_aes, "libssl", None)
    if libssl is not None and getattr(libssl, "decrypt_ige", None):
        return "libssl"
    return "pyaes"


class Telemetry:
    def __init__(self, output_dir: Path):
        self.output_dir = output_dir
        self.lock = threading.RLock()
        self.active_file: str | None = None
        self.aes_calls = 0
        self.aes_bytes = 0
        self.aes_seconds = 0.0
        self.request_sequence = 0
        self.inflight = 0
        self.max_inflight_by_file: dict[str, int] = {}
        self.request_records: dict[str, list[dict[str, Any]]] = {}
        self.request_attempts: dict[int, int] = {}
        self.events: dict[str, dict[str, int]] = {}
        self.log_path = output_dir / "telethon-sanitized.log"

    def set_active_file(self, file_id: str | None) -> None:
        with self.lock:
            self.active_file = file_id

    def current_file(self) -> str:
        return _ACTIVE_FILE.get() or self.active_file or "global"

    def note_aes(self, byte_count: int, elapsed: float) -> None:
        with self.lock:
            self.aes_calls += 1
            self.aes_bytes += int(byte_count)
            self.aes_seconds += float(elapsed)

    def aes_snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "calls": self.aes_calls,
                "bytes": self.aes_bytes,
                "seconds": self.aes_seconds,
            }

    def begin_request(self, file_id: str, request: Any) -> tuple[int, dict[str, Any]]:
        with self.lock:
            self.request_sequence += 1
            request_id = self.request_sequence
            self.request_attempts[request_id] = 0
            self.inflight += 1
            self.max_inflight_by_file[file_id] = max(
                self.max_inflight_by_file.get(file_id, 0), self.inflight
            )
        return request_id, {
            "request_id": request_id,
            "file_id": file_id,
            "message_id": int(file_id),
            "request_type": type(request).__name__,
            "offset": int(getattr(request, "offset", 0) or 0),
            "limit": int(getattr(request, "limit", 0) or 0),
            "started_at": utc_now(),
        }

    def note_send_attempt(self, request_id: int) -> None:
        with self.lock:
            self.request_attempts[request_id] = self.request_attempts.get(request_id, 0) + 1

    def finish_request(self, file_id: str, record: dict[str, Any]) -> None:
        request_id = int(record["request_id"])
        with self.lock:
            record["transport_attempts"] = self.request_attempts.pop(request_id, 0)
            self.inflight = max(0, self.inflight - 1)
            self.request_records.setdefault(file_id, []).append(record)

    def records_for(self, file_id: str) -> list[dict[str, Any]]:
        with self.lock:
            return [dict(item) for item in self.request_records.get(file_id, [])]

    def max_inflight_for(self, file_id: str) -> int:
        with self.lock:
            return self.max_inflight_by_file.get(file_id, 0)

    def note_event(self, category: str, file_id: str | None = None) -> None:
        key = file_id or self.current_file()
        with self.lock:
            bucket = self.events.setdefault(key, {})
            bucket[category] = bucket.get(category, 0) + 1

    def events_for(self, file_id: str) -> dict[str, int]:
        with self.lock:
            own = dict(self.events.get(file_id, {}))
            global_events = dict(self.events.get("global", {}))
        for key, value in global_events.items():
            own[f"global_{key}"] = value
        return own


class SanitizedTelethonHandler(logging.Handler):
    def __init__(self, telemetry: Telemetry):
        super().__init__(level=logging.INFO)
        self.telemetry = telemetry

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = sanitize_text(record.getMessage(), limit=320)
            lower = message.lower()
            if "flood" in lower and "wait" in lower:
                category = "flood_wait"
            elif "timeout" in lower or "timed out" in lower:
                category = "timeout"
            elif "migrat" in lower or "another dc" in lower:
                category = "migration"
            elif "reset" in lower or "server closed" in lower or "connection closed" in lower:
                category = "reset"
            elif "retry" in lower or "reconnect" in lower:
                category = "retry"
            elif record.levelno >= logging.ERROR:
                category = "error"
            elif record.levelno >= logging.WARNING:
                category = "warning"
            else:
                category = "info"
            file_id = self.telemetry.current_file()
            if category not in ("info",):
                self.telemetry.note_event(category, file_id)
            append_jsonl(
                self.telemetry.log_path,
                {
                    "timestamp": utc_now(),
                    "file_id": file_id,
                    "level": record.levelname,
                    "logger": record.name,
                    "category": category,
                    "message": message,
                },
            )
        except Exception:
            return


class InstrumentedTelegramClient(TelegramClient):
    def __init__(self, *args: Any, telemetry: Telemetry, **kwargs: Any):
        self._anti_telemetry = telemetry
        super().__init__(*args, **kwargs)

    async def _call(
        self,
        sender: Any,
        request: Any,
        ordered: bool = False,
        flood_sleep_threshold: int | None = None,
    ) -> Any:
        file_types = (functions.upload.GetFileRequest, functions.upload.GetCdnFileRequest)
        if not isinstance(request, file_types):
            token = _ACTIVE_REQUEST.set(None)
            try:
                return await super()._call(
                    sender,
                    request,
                    ordered=ordered,
                    flood_sleep_threshold=flood_sleep_threshold,
                )
            finally:
                _ACTIVE_REQUEST.reset(token)

        file_id = self._anti_telemetry.current_file()
        request_id, record = self._anti_telemetry.begin_request(file_id, request)
        request_token = _ACTIVE_REQUEST.set(request_id)
        aes_before = self._anti_telemetry.aes_snapshot()
        cpu_before = time.process_time()
        wall_before = time.perf_counter()
        result = None
        error: BaseException | None = None
        try:
            result = await super()._call(
                sender,
                request,
                ordered=ordered,
                flood_sleep_threshold=flood_sleep_threshold,
            )
            return result
        except BaseException as exc:
            error = exc
            raise
        finally:
            aes_after = self._anti_telemetry.aes_snapshot()
            record.update(
                {
                    "finished_at": utc_now(),
                    "elapsed_ms": round((time.perf_counter() - wall_before) * 1000.0, 3),
                    "process_cpu_ms": round((time.process_time() - cpu_before) * 1000.0, 3),
                    "ok": error is None,
                    "error_type": type(error).__name__ if error is not None else None,
                    "response_bytes": len(getattr(result, "bytes", b"") or b"") if result is not None else 0,
                    "aes_decrypt_calls": int(aes_after["calls"] - aes_before["calls"]),
                    "aes_decrypt_bytes": int(aes_after["bytes"] - aes_before["bytes"]),
                    "aes_decrypt_ms": round(
                        (aes_after["seconds"] - aes_before["seconds"]) * 1000.0, 3
                    ),
                }
            )
            self._anti_telemetry.finish_request(file_id, record)
            _ACTIVE_REQUEST.reset(request_token)


class SystemSampler:
    def __init__(self, output_path: Path, file_id: str):
        self.output_path = output_path
        self.file_id = file_id
        self.process = psutil.Process()
        self.stop_event = asyncio.Event()
        self.task: asyncio.Task[Any] | None = None
        self.peak_rss = 0

    async def start(self) -> None:
        psutil.cpu_percent(interval=None)
        self.task = asyncio.create_task(self._run())
        await asyncio.sleep(0)

    async def stop(self) -> None:
        self.stop_event.set()
        if self.task is not None:
            await self.task

    async def _run(self) -> None:
        last_wall = time.perf_counter()
        initial_times = self.process.cpu_times()
        last_cpu = initial_times.user + initial_times.system
        while True:
            now_wall = time.perf_counter()
            times = self.process.cpu_times()
            now_cpu = times.user + times.system
            wall_delta = max(0.000001, now_wall - last_wall)
            cpu_delta = max(0.0, now_cpu - last_cpu)
            logical_cpus = psutil.cpu_count(logical=True) or os.cpu_count() or 1
            memory = self.process.memory_info()
            self.peak_rss = max(self.peak_rss, int(memory.rss))
            network = psutil.net_io_counters()
            append_jsonl(
                self.output_path,
                {
                    "timestamp": utc_now(),
                    "file_id": self.file_id,
                    "process_cpu_seconds": round(now_cpu, 6),
                    "process_one_core_pct_interval": round(cpu_delta / wall_delta * 100.0, 3),
                    "process_total_capacity_pct_interval": round(
                        cpu_delta / wall_delta * 100.0 / logical_cpus, 3
                    ),
                    "rss_bytes": int(memory.rss),
                    "system_cpu_pct": psutil.cpu_percent(interval=None),
                    "net_bytes_recv": int(network.bytes_recv) if network else None,
                    "net_bytes_sent": int(network.bytes_sent) if network else None,
                },
            )
            if self.stop_event.is_set():
                return
            last_wall = now_wall
            last_cpu = now_cpu
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=0.5)
            except asyncio.TimeoutError:
                pass


def install_instrumentation(telemetry: Telemetry) -> tuple[Any, Any]:
    original_decrypt = telethon_aes.AES.decrypt_ige
    original_send = MTProtoSender.send

    def measured_decrypt(cipher_text: bytes, key: bytes, iv: bytes) -> bytes:
        started = time.perf_counter()
        result = original_decrypt(cipher_text, key, iv)
        telemetry.note_aes(len(cipher_text), time.perf_counter() - started)
        return result

    def measured_send(sender: MTProtoSender, request: Any, ordered: bool = False) -> Any:
        request_id = _ACTIVE_REQUEST.get()
        if request_id is not None:
            telemetry.note_send_attempt(request_id)
        return original_send(sender, request, ordered=ordered)

    telethon_aes.AES.decrypt_ige = staticmethod(measured_decrypt)
    MTProtoSender.send = measured_send
    return original_decrypt, original_send


def restore_instrumentation(original_decrypt: Any, original_send: Any) -> None:
    telethon_aes.AES.decrypt_ige = staticmethod(original_decrypt)
    MTProtoSender.send = original_send


def private_channel_id(value: str) -> int | None:
    raw = str(value).strip()
    if re.fullmatch(r"-100\d+", raw):
        return -1_000_000_000_000 - int(raw)
    return None


async def resolve_channel(client: TelegramClient, channel: str) -> Any:
    try:
        return await client.get_entity(channel)
    except Exception as direct_error:
        wanted_id = private_channel_id(channel)
        if wanted_id is None:
            raise
        async for dialog in client.iter_dialogs():
            entity = getattr(dialog, "entity", None)
            if int(getattr(entity, "id", 0) or 0) == wanted_id:
                return entity
        raise RuntimeError("telegram_channel_not_resolvable") from direct_error


def message_document(message: Any) -> Any:
    document = getattr(message, "document", None)
    if document is not None:
        return document
    media = getattr(message, "media", None)
    return getattr(media, "document", None)


def message_size(message: Any) -> int:
    document = message_document(message)
    return int(getattr(document, "size", 0) or 0)


def message_filename(message: Any) -> str | None:
    file_object = getattr(message, "file", None)
    value = getattr(file_object, "name", None)
    return sanitize_text(value, 180) if value else None


def runtime_payload(bundle_root: Path) -> dict[str, Any]:
    manifest: dict[str, Any] = {}
    manifest_path = bundle_root / "manifest.json"
    if manifest_path.exists():
        try:
            loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                manifest = loaded
        except (OSError, ValueError):
            manifest = {}
    return {
        "timestamp": utc_now(),
        "bundle_version": BUNDLE_VERSION,
        "baseline_main_sha": BASELINE_MAIN_SHA,
        "tooling_commit_sha": manifest.get("tooling_commit_sha"),
        "python_version": platform.python_version(),
        "python_implementation": platform.python_implementation(),
        "telethon_version": telethon.__version__,
        "psutil_version": psutil.__version__,
        "frozen": bool(getattr(sys, "frozen", False)),
        "executable": Path(sys.executable).name,
        "platform": platform.platform(),
        "logical_cpu_count": psutil.cpu_count(logical=True) or os.cpu_count(),
        "physical_cpu_count": psutil.cpu_count(logical=False),
        "crypto_backend_selected_at_runtime": selected_crypto_backend(),
        "cryptg_loaded": getattr(telethon_aes, "cryptg", None) is not None,
        "libssl_decrypt_available": bool(
            getattr(getattr(telethon_aes, "libssl", None), "decrypt_ige", None)
        ),
    }


def validate_runtime(bundle_root: Path) -> dict[str, Any]:
    runtime = runtime_payload(bundle_root)
    if tuple(sys.version_info[:3]) != EXPECTED_PYTHON:
        raise RuntimeError(
            f"python_version_mismatch:{platform.python_version()}/3.12.10"
        )
    if telethon.__version__ != EXPECTED_TELETHON:
        raise RuntimeError(f"telethon_version_mismatch:{telethon.__version__}/1.45.0")
    if not getattr(sys, "frozen", False):
        raise RuntimeError("frozen_runtime_required")
    if runtime["crypto_backend_selected_at_runtime"] not in ("cryptg", "libssl", "pyaes"):
        raise RuntimeError("crypto_backend_unknown")
    return runtime


async def measure_target(
    client: InstrumentedTelegramClient,
    entity: Any,
    target: dict[str, Any],
    media_dir: Path,
    output_dir: Path,
    telemetry: Telemetry,
) -> dict[str, Any]:
    message_id = int(target["message_id"])
    file_id = str(message_id)
    message = await client.get_messages(entity, ids=message_id)
    if not message or not getattr(message, "media", None):
        raise RuntimeError(f"telegram_media_missing:{message_id}")
    source_bytes = message_size(message)
    if source_bytes != int(target["bytes"]):
        raise RuntimeError(
            f"telegram_raw_size_mismatch:{message_id}:{source_bytes}/{target['bytes']}"
        )

    target_path = media_dir / f"message-{message_id}.bin"
    request_path = output_dir / f"requests-{message_id}.jsonl"
    system_path = output_dir / f"system-{message_id}.jsonl"
    target_path.unlink(missing_ok=True)
    request_path.unlink(missing_ok=True)
    system_path.unlink(missing_ok=True)

    digest = hashlib.sha256()
    downloaded = 0
    chunk_count = 0
    process = psutil.Process()
    cpu_start_values = process.cpu_times()
    cpu_start = cpu_start_values.user + cpu_start_values.system
    wall_start = time.perf_counter()
    aes_before = telemetry.aes_snapshot()
    sampler = SystemSampler(system_path, file_id)
    file_token = _ACTIVE_FILE.set(file_id)
    telemetry.set_active_file(file_id)
    await sampler.start()
    download_error: BaseException | None = None
    print(
        f"MEASURING message_id={message_id} bytes={target['bytes']} request_size={REQUEST_SIZE}",
        flush=True,
    )
    try:
        with target_path.open("xb") as handle:
            async for chunk in client.iter_download(
                message.media,
                request_size=REQUEST_SIZE,
                chunk_size=REQUEST_SIZE,
            ):
                if not chunk:
                    continue
                handle.write(chunk)
                digest.update(chunk)
                downloaded += len(chunk)
                chunk_count += 1
    except BaseException as exc:
        download_error = exc
    finally:
        await sampler.stop()
        telemetry.set_active_file(None)
        _ACTIVE_FILE.reset(file_token)

    wall_seconds = time.perf_counter() - wall_start
    cpu_end_values = process.cpu_times()
    cpu_end = cpu_end_values.user + cpu_end_values.system
    cpu_seconds = max(0.0, cpu_end - cpu_start)
    aes_after = telemetry.aes_snapshot()
    actual_file_bytes = target_path.stat().st_size if target_path.exists() else 0
    raw_sha256 = digest.hexdigest()
    records = telemetry.records_for(file_id)
    for record in records:
        append_jsonl(request_path, record)

    expected_chunks = math.ceil(int(target["bytes"]) / REQUEST_SIZE)
    successful = [record for record in records if record.get("ok")]
    latencies = [float(record["elapsed_ms"]) for record in successful]
    transport_retries = sum(max(0, int(record.get("transport_attempts") or 0) - 1) for record in records)
    iterator_retries = max(0, len(records) - len(successful))
    error_types = [str(record.get("error_type")) for record in records if record.get("error_type")]
    event_counts = telemetry.events_for(file_id)
    flood_wait_count = event_counts.get("flood_wait", 0) + event_counts.get("global_flood_wait", 0) + sum(
        1 for value in error_types if "Flood" in value
    )
    timeout_count = event_counts.get("timeout", 0) + event_counts.get("global_timeout", 0) + sum(
        1 for value in error_types if "TimedOut" in value or "Timeout" in value
    )
    migration_count = event_counts.get("migration", 0) + event_counts.get("global_migration", 0) + sum(
        1 for value in error_types if "Migrate" in value
    )
    reset_count = event_counts.get("reset", 0) + event_counts.get("global_reset", 0) + sum(
        1 for value in error_types if "Connection" in value
    )
    logical_cpus = psutil.cpu_count(logical=True) or os.cpu_count() or 1
    one_core_pct = cpu_seconds / max(wall_seconds, 0.000001) * 100.0
    document = message_document(message)
    limits = sorted({int(record.get("limit") or 0) for record in records})
    summary = {
        "message_id": message_id,
        "expected_filename": target["filename"],
        "telegram_filename": message_filename(message),
        "expected_raw_bytes": int(target["bytes"]),
        "raw_bytes": downloaded,
        "file_bytes": actual_file_bytes,
        "sha256": raw_sha256,
        "request_size_bytes": REQUEST_SIZE,
        "request_limits_seen": limits,
        "expected_chunk_count": expected_chunks,
        "chunk_count": chunk_count,
        "getfile_request_count": len(records),
        "successful_request_count": len(successful),
        "request_p50_ms": percentile(latencies, 0.50),
        "request_p95_ms": percentile(latencies, 0.95),
        "total_seconds": round(wall_seconds, 6),
        "mib_per_second": round(downloaded / 1_048_576 / max(wall_seconds, 0.000001), 6),
        "process_cpu_seconds": round(cpu_seconds, 6),
        "one_core_utilization_pct": round(one_core_pct, 3),
        "normalized_process_cpu_pct_total_capacity": round(one_core_pct / logical_cpus, 3),
        "rss_peak_bytes": sampler.peak_rss,
        "telegram_dc_id": int(getattr(document, "dc_id", 0) or 0) or None,
        "max_requests_inflight": telemetry.max_inflight_for(file_id),
        "retry_count": transport_retries + iterator_retries,
        "transport_retry_count": transport_retries,
        "iterator_retry_count": iterator_retries,
        "flood_wait_count": flood_wait_count,
        "timeout_count": timeout_count,
        "reset_count": reset_count,
        "migration_count": migration_count,
        "request_error_types": error_types,
        "telethon_event_counts": event_counts,
        "download_error": safe_error(download_error) if download_error is not None else None,
        "crypto_backend": selected_crypto_backend(),
        "aes_decrypt_call_count": int(aes_after["calls"] - aes_before["calls"]),
        "aes_decrypt_bytes": int(aes_after["bytes"] - aes_before["bytes"]),
        "aes_decrypt_seconds": round(
            float(aes_after["seconds"] - aes_before["seconds"]), 6
        ),
        "media_deleted_after_validation": False,
    }

    failures = []
    if downloaded != int(target["bytes"]) or actual_file_bytes != int(target["bytes"]):
        failures.append("raw_byte_count_mismatch")
    if chunk_count != expected_chunks:
        failures.append("chunk_count_mismatch")
    if telemetry.max_inflight_for(file_id) != 1:
        failures.append("max_inflight_not_one")
    if limits != [REQUEST_SIZE]:
        failures.append("request_limit_mismatch")
    if len(successful) != expected_chunks:
        failures.append("successful_request_count_mismatch")
    if summary["aes_decrypt_call_count"] <= 0:
        failures.append("aes_decrypt_path_not_observed")
    if any((flood_wait_count, timeout_count, reset_count, migration_count)):
        failures.append("network_event_contamination")
    if summary["retry_count"]:
        failures.append("request_retry_contamination")
    if download_error is not None:
        failures.append(f"download_error_{type(download_error).__name__}")

    target_path.unlink(missing_ok=True)
    summary["media_deleted_after_validation"] = not target_path.exists()
    if not summary["media_deleted_after_validation"]:
        failures.append("temp_media_delete_failed")
    summary["validation_failures"] = failures
    summary["validation_pass"] = not failures
    write_json(output_dir / f"summary-{message_id}.json", summary)
    if failures:
        raise RuntimeError(f"measurement_validation_failed:{message_id}:{','.join(failures)}")
    return summary


async def run_measurement(
    config_path: Path,
    targets_path: Path,
    output_dir: Path,
    bundle_root: Path,
) -> int:
    runtime = validate_runtime(bundle_root)
    measurement_config = load_measurement_config(targets_path)
    runtime["measurement_config_sha256"] = sha256_file(targets_path)
    write_json(output_dir / "runtime.json", runtime)
    config_pre = sha256_file(config_path)
    profile = load_reader_profile(config_path, measurement_config["profile_id"])
    telemetry = Telemetry(output_dir)
    telethon_logger = logging.getLogger("telethon")
    telethon_logger.handlers.clear()
    telethon_logger.setLevel(logging.INFO)
    telethon_logger.propagate = False
    telethon_logger.addHandler(SanitizedTelethonHandler(telemetry))
    original_decrypt, original_send = install_instrumentation(telemetry)
    summaries: list[dict[str, Any]] = []
    failure: str | None = None
    client: InstrumentedTelegramClient | None = None
    try:
        client = InstrumentedTelegramClient(
            StringSession(profile["session"]),
            profile["api_id"],
            profile["api_hash"],
            telemetry=telemetry,
            receive_updates=False,
            flood_sleep_threshold=0,
            request_retries=5,
            connection_retries=5,
            auto_reconnect=True,
        )
        await client.connect()
        if not await client.is_user_authorized():
            raise RuntimeError("telegram_session_not_authorized")
        entity = await resolve_channel(client, measurement_config["channel"])
        resolved_chat_id = -1_000_000_000_000 - int(getattr(entity, "id", 0) or 0)
        if str(resolved_chat_id) != measurement_config["channel"]:
            raise RuntimeError("telegram_channel_identity_mismatch")
        media_dir = output_dir.parent / "media"
        media_dir.mkdir(parents=False, exist_ok=False)
        for target in measurement_config["targets"]:
            summaries.append(
                await measure_target(client, entity, target, media_dir, output_dir, telemetry)
            )
    except BaseException as exc:
        failure = safe_error(exc)
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception as exc:
                if failure is None:
                    failure = safe_error(exc)
        restore_instrumentation(original_decrypt, original_send)
        for path in (output_dir.parent / "media").glob("*") if (output_dir.parent / "media").exists() else ():
            if path.is_file():
                path.unlink(missing_ok=True)
        try:
            (output_dir.parent / "media").rmdir()
        except OSError:
            pass

    config_post = sha256_file(config_path)
    config_unchanged = config_pre == config_post
    write_json(
        output_dir / "pre-post-hashes.json",
        {
            "config_path": "%LOCALAPPDATA%\\YeuNauAnReader\\reader-manager.dat",
            "config_sha256_before": config_pre,
            "config_sha256_after": config_post,
            "config_unchanged": config_unchanged,
            "session_storage": "encrypted_inside_reader_config",
            "session_persistence_used": "in_memory_StringSession_only",
        },
    )
    aes_final = telemetry.aes_snapshot()
    integrity = {
        "timestamp": utc_now(),
        "config_unchanged": config_unchanged,
        "production_queue_accessed": False,
        "production_queue_mutated": False,
        "object_storage_accessed": False,
        "reader_control_api_accessed": False,
        "telegram_messages_requested": [
            item["message_id"] for item in measurement_config["targets"]
        ],
        "temp_media_remaining": any((output_dir.parent / "media").glob("*"))
        if (output_dir.parent / "media").exists()
        else False,
        "actual_crypto_backend": selected_crypto_backend(),
        "aes_decrypt_call_count": int(aes_final["calls"]),
        "aes_decrypt_bytes": int(aes_final["bytes"]),
    }
    write_json(output_dir / "integrity.json", integrity)
    if not config_unchanged:
        failure = "RuntimeError: reader_config_hash_changed"
    measurement_summary = {
        "timestamp": utc_now(),
        "status": "pass" if failure is None else "fail",
        "reason": failure,
        "targets_completed": len(summaries),
        "targets_expected": len(measurement_config["targets"]),
        "summaries": summaries,
        "actual_crypto_backend": selected_crypto_backend(),
        "aes_decrypt_call_count": int(aes_final["calls"]),
        "max_requests_inflight": max(
            (item.get("max_requests_inflight", 0) for item in summaries), default=0
        ),
        "config_unchanged": config_unchanged,
    }
    write_json(output_dir / "measurement-summary.json", measurement_summary)
    if failure is not None:
        print(f"PROBE_FAIL reason={sanitize_text(failure)}", flush=True)
        return 1
    print("PROBE_PASS", flush=True)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-test", action="store_true")
    mode.add_argument("--run", action="store_true")
    parser.add_argument("--bundle-root", type=Path, default=Path(sys.executable).resolve().parent)
    parser.add_argument("--config-path", type=Path)
    parser.add_argument("--targets-path", type=Path)
    parser.add_argument("--output-dir", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        bundle_root = args.bundle_root.resolve()
        if args.self_test:
            runtime = validate_runtime(bundle_root)
            print(
                "SELF_TEST_PASS "
                + json.dumps(
                    {
                        "python": runtime["python_version"],
                        "telethon": runtime["telethon_version"],
                        "frozen": runtime["frozen"],
                        "crypto_backend": runtime["crypto_backend_selected_at_runtime"],
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
            return 0
        if os.name != "nt":
            raise RuntimeError("windows_required")
        if args.config_path is None or args.targets_path is None or args.output_dir is None:
            raise RuntimeError("config_targets_and_output_paths_required")
        config_path = args.config_path.resolve()
        targets_path = args.targets_path.resolve()
        output_dir = args.output_dir.resolve()
        local_app_data = os.getenv("LOCALAPPDATA")
        if not local_app_data:
            raise RuntimeError("localappdata_missing")
        expected_config = (Path(local_app_data) / "YeuNauAnReader" / "reader-manager.dat").resolve()
        if config_path != expected_config:
            raise RuntimeError("unexpected_reader_config_path")
        expected_targets = (bundle_root / "measurement-targets.json").resolve()
        if targets_path != expected_targets:
            raise RuntimeError("unexpected_measurement_targets_path")
        if not config_path.is_file():
            raise RuntimeError("reader_config_missing")
        if not targets_path.is_file():
            raise RuntimeError("measurement_targets_missing")
        if not output_dir.is_dir() or any(output_dir.iterdir()):
            raise RuntimeError("output_directory_must_be_new_and_empty")
        return asyncio.run(
            run_measurement(config_path, targets_path, output_dir, bundle_root)
        )
    except BaseException as exc:
        print(f"PROBE_FAIL reason={safe_error(exc)}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
