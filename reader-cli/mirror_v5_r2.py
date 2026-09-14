#!/usr/bin/env python3
"""Mirror one Telegram media message into a private Cloudflare R2 bucket.

This worker runs only on the local Reader machine. Telegram user-session secrets and
R2 credentials never leave the Reader environment. Telegram download and R2 multipart
upload both keep local checkpoints so a retry can continue instead of restarting from 0.
"""
import argparse
import asyncio
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError
except ImportError:
    boto3 = None
    Config = None
    ClientError = Exception

try:
    from telethon import TelegramClient
    from export_history import local_session, resolve_channel
except ImportError:
    TelegramClient = None
    local_session = None
    resolve_channel = None

PART_SIZE = 16 * 1024 * 1024
DOWNLOAD_REQUEST_SIZE = 512 * 1024
SMALL_OBJECT_THRESHOLD_BYTES = 8 * 1024 * 1024
CACHE_TTL_SECONDS = 24 * 60 * 60
MAX_CACHE_BYTES = 10 * 1024 * 1024 * 1024


def clean(value):
    return str(value or "").strip()


def safe_name(value):
    name = clean(value) or "telegram-media"
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name)
    name = re.sub(r"-+", "-", name).strip("-.")
    return (name or "telegram-media")[:160]


def require_env(name):
    value = clean(os.getenv(name))
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def bucket_name():
    value = clean(os.getenv("R2_BUCKET") or os.getenv("V5_R2_BUCKET"))
    if not value:
        raise RuntimeError("R2_BUCKET or V5_R2_BUCKET is required")
    return value


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


class StageTimer:
    """Track per-stage elapsed timings in milliseconds without exposing sensitive data."""

    def __init__(self, start_time=None):
        self.base_time = float(start_time) if start_time else time.time()
        self.timings = {}
        self._active_stage = None
        self._stage_start = None

    def start_stage(self, stage):
        now = time.time()
        if self._active_stage:
            self.end_stage(self._active_stage)
        self._active_stage = stage
        self._stage_start = now

    def end_stage(self, stage=None):
        now = time.time()
        st = stage or self._active_stage
        if st and self._stage_start is not None:
            elapsed = max(0, int((now - self._stage_start) * 1000))
            self.timings[st] = self.timings.get(st, 0) + elapsed
        self._active_stage = None
        self._stage_start = None

    def record_elapsed(self, stage, elapsed_ms):
        self.timings[stage] = int(elapsed_ms)

    def total_elapsed_ms(self):
        return max(0, int((time.time() - self.base_time) * 1000))


_last_progress_time = 0
_STAGE_PROGRESS = {}


def report_progress(progress_file, stage, current, total):
    global _last_progress_time, _STAGE_PROGRESS
    if not progress_file:
        return
    now = time.time()
    curr_int = int(current or 0)
    total_int = int(total) if total is not None and int(total) > 0 else None
    is_done = total_int is not None and curr_int >= total_int
    if not is_done and (now - _last_progress_time) < 0.8:
        return
    _last_progress_time = now

    # Calculate rolling / instantaneous rate and ETA
    if _STAGE_PROGRESS.get("stage") != stage:
        _STAGE_PROGRESS = {
            "stage": stage,
            "start_time": now,
            "last_time": now,
            "last_bytes": curr_int,
            "rate": 0,
        }
    else:
        interval = now - _STAGE_PROGRESS["last_time"]
        if interval >= 0.5:
            instant_rate = (curr_int - _STAGE_PROGRESS["last_bytes"]) / max(0.001, interval)
            _STAGE_PROGRESS["last_time"] = now
            _STAGE_PROGRESS["last_bytes"] = curr_int
            _STAGE_PROGRESS["rate"] = max(0, int(instant_rate))
        elif (now - _STAGE_PROGRESS["start_time"]) > 0:
            _STAGE_PROGRESS["rate"] = max(0, int(curr_int / max(0.001, now - _STAGE_PROGRESS["start_time"])))

    bytes_per_sec = _STAGE_PROGRESS.get("rate", 0)
    eta_sec = None
    if total_int and total_int > curr_int and bytes_per_sec > 0:
        eta_sec = round((total_int - curr_int) / bytes_per_sec, 1)

    percent = None
    if total_int and total_int > 0:
        percent = round(min(100.0, (curr_int / total_int) * 100), 1)

    elapsed_ms = max(0, int((now - _STAGE_PROGRESS.get("start_time", now)) * 1000))

    payload = {
        "stage": stage,
        "current": curr_int,
        "total": total_int,
        "bytes_per_second": bytes_per_sec,
        "mb_per_second": round(bytes_per_sec / (1024 * 1024), 2),
        "eta_seconds": eta_sec,
        "percent": percent,
        "elapsed_ms": elapsed_ms,
    }
    try:
        atomic_json(Path(progress_file), payload)
    except Exception:
        pass


def parse_mp4_atoms(file_path):
    """Parse top-level atoms of an MP4/ISOBMFF file.
    Returns list of dicts: [{'name': 'ftyp', 'offset': 0, 'size': 32}, ...]
    Raises ValueError on malformed atom size or truncation.
    """
    path = Path(file_path)
    file_size = path.stat().st_size
    atoms = []
    with path.open("rb") as f:
        offset = 0
        while offset < file_size:
            header = f.read(8)
            if len(header) < 8:
                if len(header) == 0:
                    break
                raise ValueError(f"truncated_atom_header:offset_{offset}")
            size, name_bytes = struct.unpack(">I4s", header)
            name = name_bytes.decode("latin1", errors="replace")
            header_size = 8
            if size == 1:
                ext = f.read(8)
                if len(ext) < 8:
                    raise ValueError(f"truncated_extended_atom_size:offset_{offset}")
                size = struct.unpack(">Q", ext)[0]
                header_size = 16
            elif size == 0:
                size = file_size - offset

            if size < header_size:
                raise ValueError(f"malformed_atom_size:{name}_size_{size}_less_than_{header_size}")
            if offset + size > file_size:
                raise ValueError(f"atom_exceeds_file_size:{name}_offset_{offset}_size_{size}_file_{file_size}")

            atoms.append({"name": name, "offset": offset, "size": size})
            offset += size
            f.seek(offset)
    return atoms


def check_moov_before_mdat(file_path):
    atoms = parse_mp4_atoms(file_path)
    moov_offset = None
    mdat_offset = None
    for atom in atoms:
        if atom["name"] == "moov" and moov_offset is None:
            moov_offset = atom["offset"]
        elif atom["name"] == "mdat" and mdat_offset is None:
            mdat_offset = atom["offset"]
    if moov_offset is None:
        return False, "moov_atom_missing"
    if mdat_offset is None:
        return False, "mdat_atom_missing"
    if moov_offset < mdat_offset:
        return True, None
    return False, f"moov_after_mdat:{moov_offset}>{mdat_offset}"


def is_mp4_container(file_path):
    try:
        atoms = parse_mp4_atoms(file_path)
        if not atoms:
            return False
        return atoms[0]["name"] == "ftyp" or any(a["name"] in ("ftyp", "moov") for a in atoms)
    except Exception:
        return False


def resolve_binary(name):
    """Resolve an executable binary, prioritizing bundled {app}/bin over system PATH.
    Fail closed with faststart_dependency_missing if not found.
    """
    exe_name = f"{name}.exe" if os.name == "nt" and not name.endswith(".exe") else name
    candidates = []

    # 1. Check relative to sys.executable (Production {app}\bin\)
    try:
        exe_dir = Path(sys.executable).resolve().parent
        candidates.append(exe_dir / "bin" / exe_name)
        candidates.append(exe_dir / exe_name)
    except Exception:
        pass

    # 2. Check relative to _MEIPASS if PyInstaller unpacked
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        try:
            mei_dir = Path(meipass).resolve()
            candidates.append(mei_dir / "bin" / exe_name)
            candidates.append(mei_dir / exe_name)
        except Exception:
            pass

    # 3. Check relative to this file / repository structure (dev / tests)
    try:
        cur_file = Path(__file__).resolve()
        candidates.append(cur_file.parent / "bin" / exe_name)
        candidates.append(cur_file.parents[1] / "reader-manager" / "bin" / exe_name)
        candidates.append(cur_file.parents[1] / "bin" / exe_name)
    except Exception:
        pass

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    # 4. Fallback to system PATH for dev environments
    found_in_path = shutil.which(name) or shutil.which(exe_name)
    if found_in_path:
        return found_in_path

    raise RuntimeError(f"faststart_dependency_missing:{name}_not_found")


def get_ffmpeg_bin():
    return resolve_binary("ffmpeg")


def get_ffprobe_bin():
    return resolve_binary("ffprobe")


def probe_media(file_path, ffprobe_bin=None):
    if not ffprobe_bin:
        ffprobe_bin = get_ffprobe_bin()
    cmd = [
        ffprobe_bin,
        "-v", "error",
        "-show_entries", "stream=index,codec_type,codec_name,duration:format=duration,size",
        "-of", "json",
        str(file_path),
    ]
    popen_kwargs = {}
    if os.name == "nt":
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    res = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=30,
        **popen_kwargs,
    )
    if res.returncode != 0:
        raise RuntimeError(f"ffprobe_failed:{clean(res.stderr)[:200]}")
    try:
        return json.loads(res.stdout)
    except Exception as exc:
        raise RuntimeError(f"ffprobe_json_parse_error:{exc}")


_ACTIVE_TIMER = None


def remux_video_faststart(input_path, output_path):
    ffmpeg_bin = get_ffmpeg_bin()
    ffprobe_bin = get_ffprobe_bin()
    timer = _ACTIVE_TIMER
    if timer:
        timer.start_stage("faststart_source_probe")
    try:
        source_probe = probe_media(input_path, ffprobe_bin=ffprobe_bin)
    except Exception as exc:
        if "faststart_dependency_missing" in str(exc):
            raise
        raise RuntimeError(f"faststart_remux_failed:source_probe_failed:{exc}") from exc
    finally:
        if timer:
            timer.end_stage("faststart_source_probe")

    source_streams = source_probe.get("streams", [])
    source_video = [s for s in source_streams if s.get("codec_type") == "video"]
    source_audio = [s for s in source_streams if s.get("codec_type") == "audio"]
    if not source_video:
        raise RuntimeError("faststart_remux_failed:no_video_stream_in_source")

    output_path.unlink(missing_ok=True)
    cmd = [
        ffmpeg_bin,
        "-v", "error",
        "-y",
        "-i", str(input_path),
        "-c", "copy",
        "-movflags", "+faststart",
        "-f", "mp4",
        str(output_path),
    ]
    popen_kwargs = {}
    if os.name == "nt":
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

    if timer:
        timer.start_stage("faststart_remux")
    res = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=180,
        **popen_kwargs,
    )
    if timer:
        timer.end_stage("faststart_remux")

    if res.returncode != 0:
        raise RuntimeError(f"faststart_remux_failed:ffmpeg_exit_{res.returncode}:{clean(res.stderr)[:200]}")

    if not output_path.exists():
        raise RuntimeError("faststart_remux_failed:output_missing")

    out_size = output_path.stat().st_size
    if out_size <= 0:
        raise RuntimeError("faststart_remux_failed:output_empty")

    if timer:
        timer.start_stage("faststart_output_probe_verify")
    try:
        moov_ok, moov_err = check_moov_before_mdat(output_path)
        if not moov_ok:
            raise RuntimeError(f"faststart_remux_failed:{moov_err}")

        try:
            output_probe = probe_media(output_path, ffprobe_bin=ffprobe_bin)
        except Exception as exc:
            if "faststart_dependency_missing" in str(exc):
                raise
            raise RuntimeError(f"faststart_remux_failed:output_probe_failed:{exc}") from exc
        output_streams = output_probe.get("streams", [])
        output_video = [s for s in output_streams if s.get("codec_type") == "video"]
        output_audio = [s for s in output_streams if s.get("codec_type") == "audio"]

        if not output_video:
            raise RuntimeError("faststart_remux_failed:output_video_stream_missing")
        if clean(output_video[0].get("codec_name")) != clean(source_video[0].get("codec_name")):
            raise RuntimeError(f"faststart_remux_failed:video_codec_mismatch:{output_video[0].get('codec_name')}_vs_{source_video[0].get('codec_name')}")

        if source_audio:
            if not output_audio:
                raise RuntimeError("faststart_remux_failed:output_audio_stream_missing")
            if clean(output_audio[0].get("codec_name")) != clean(source_audio[0].get("codec_name")):
                raise RuntimeError(f"faststart_remux_failed:audio_codec_mismatch:{output_audio[0].get('codec_name')}_vs_{source_audio[0].get('codec_name')}")

        try:
            src_dur = float(source_probe.get("format", {}).get("duration") or 0)
            out_dur = float(output_probe.get("format", {}).get("duration") or 0)
            if src_dur > 0 and out_dur > 0 and abs(src_dur - out_dur) > 0.5:
                raise RuntimeError(f"faststart_remux_failed:duration_drift:{abs(src_dur - out_dur):.2f}s")
        except (ValueError, TypeError):
            pass
    finally:
        if timer:
            timer.end_stage("faststart_output_probe_verify")

    return out_size


def r2_client():
    account_id = require_env("R2_ACCOUNT_ID")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=require_env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=require_env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "adaptive"}),
    )


def cache_root():
    configured = clean(os.getenv("V5_R2_CACHE_DIR"))
    root = Path(configured) if configured else Path(__file__).resolve().parent / ".v5-r2-cache"
    root.mkdir(parents=True, exist_ok=True)
    return root


def cache_manifest_path(asset_id):
    return cache_root() / f"{asset_id}.cache.json"


def save_cache_manifest(asset_id, data):
    manifest_path = cache_manifest_path(asset_id)
    existing = read_json(manifest_path)
    existing.update(data)
    existing["asset_id"] = str(asset_id)
    existing["updated_at"] = time.time()
    atomic_json(manifest_path, existing)


def load_cache_manifest(asset_id):
    return read_json(cache_manifest_path(asset_id))


def can_reuse_download_cache(local_path, manifest, channel, message_id, expected_bytes, is_photo):
    if not local_path.exists():
        return False
    size = local_path.stat().st_size
    if size <= 0:
        return False
    if manifest.get("channel") != str(channel):
        return False
    if int(manifest.get("message_id") or 0) != int(message_id):
        return False
    if int(manifest.get("download_size") or 0) != size:
        return False
    if expected_bytes and not is_photo and size != int(expected_bytes):
        return False
    return True


def can_reuse_faststart_cache(remux_path, manifest, channel, message_id):
    if not remux_path.exists():
        return False
    size = remux_path.stat().st_size
    if size <= 0:
        return False
    if manifest.get("channel") != str(channel):
        return False
    if int(manifest.get("message_id") or 0) != int(message_id):
        return False
    if int(manifest.get("faststart_size") or 0) != size:
        return False
    if not manifest.get("faststart_verified"):
        return False
    try:
        moov_ok, _ = check_moov_before_mdat(remux_path)
        return moov_ok
    except Exception:
        return False


def clean_asset_cache(asset_id, local_name):
    cache = cache_root()
    (cache / f"{asset_id}-{local_name}.part").unlink(missing_ok=True)
    (cache / f"{asset_id}-{local_name}.faststart.part").unlink(missing_ok=True)
    (cache / f"{asset_id}.r2.json").unlink(missing_ok=True)
    (cache / f"{asset_id}.cache.json").unlink(missing_ok=True)


def run_cache_gc(cache_dir=None, active_asset_ids=None, max_age_seconds=CACHE_TTL_SECONDS, max_bytes=MAX_CACHE_BYTES):
    cache = Path(cache_dir) if cache_dir else cache_root()
    if not cache.exists():
        return {"evicted_count": 0, "evicted_bytes": 0}
    active_set = {str(a) for a in (active_asset_ids or []) if a}
    now = time.time()
    files = []
    total_size = 0
    for p in cache.iterdir():
        if not p.is_file():
            continue
        is_active = any(p.name.startswith(f"{active_id}-") or p.name.startswith(f"{active_id}.") for active_id in active_set)
        if is_active:
            continue
        try:
            stat = p.stat()
            files.append({"path": p, "size": stat.st_size, "mtime": stat.st_mtime})
            total_size += stat.st_size
        except OSError:
            pass

    evicted_count = 0
    evicted_bytes = 0

    # 1. Evict files older than max_age_seconds
    remaining_files = []
    for f in files:
        if (now - f["mtime"]) > max_age_seconds:
            try:
                f["path"].unlink(missing_ok=True)
                evicted_count += 1
                evicted_bytes += f["size"]
                total_size -= f["size"]
            except OSError:
                pass
        else:
            remaining_files.append(f)

    # 2. If remaining size exceeds max_bytes, evict oldest first
    if total_size > max_bytes:
        remaining_files.sort(key=lambda x: x["mtime"])
        for f in remaining_files:
            if total_size <= max_bytes:
                break
            try:
                f["path"].unlink(missing_ok=True)
                evicted_count += 1
                evicted_bytes += f["size"]
                total_size -= f["size"]
            except OSError:
                pass

    return {"evicted_count": evicted_count, "evicted_bytes": evicted_bytes, "remaining_bytes": total_size}


def message_size(message):
    file_obj = getattr(message, "file", None)
    size = int(getattr(file_obj, "size", 0) or 0)
    if size > 0:
        return size
    document = getattr(message, "document", None)
    return int(getattr(document, "size", 0) or 0)


def head_matching_object(client, bucket, key, expected_bytes):
    try:
        head = client.head_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        code = clean((exc.response or {}).get("Error", {}).get("Code"))
        status = int((exc.response or {}).get("ResponseMetadata", {}).get("HTTPStatusCode") or 0)
        if code in {"404", "NoSuchKey", "NotFound"} or status == 404:
            return None
        raise
    remote_bytes = int(head.get("ContentLength") or 0)
    if expected_bytes is not None and remote_bytes != int(expected_bytes):
        return None
    return {"bytes": remote_bytes, "etag": clean(head.get("ETag"))}


async def download_resumable(client, entity, message_id, target, expected_bytes=0, is_photo=False, progress_file=None):
    if hasattr(message_id, "media"):
        message = message_id
    else:
        message = await client.get_messages(entity, ids=int(message_id))
    if not message or not getattr(message, "media", None):
        raise RuntimeError("telegram_media_message_missing")

    total = message_size(message) or int(expected_bytes or 0)
    existing = target.stat().st_size if target.exists() else 0
    if total > 0 and existing > total:
        target.unlink(missing_ok=True)
        existing = 0
    if total > 0 and existing == total and not is_photo:
        report_progress(progress_file, "telegram_download", existing, total)
        return message, total

    target.parent.mkdir(parents=True, exist_ok=True)
    mode = "ab" if existing else "wb"
    with target.open(mode) as handle:
        async for chunk in client.iter_download(
            message.media,
            offset=existing,
            request_size=DOWNLOAD_REQUEST_SIZE,
        ):
            if not chunk:
                continue
            handle.write(chunk)
            existing += len(chunk)
            report_progress(progress_file, "telegram_download", existing, total)
            if total > 0:
                print(f"Telegram download {existing}/{total} bytes", flush=True)

    actual = target.stat().st_size
    if actual <= 0:
        raise RuntimeError("telegram_download_empty")
    if total > 0 and actual != total:
        if not is_photo:
            raise RuntimeError(f"telegram_download_size_mismatch:{actual}/{total}")
        # Photo representation mismatch: perform fresh-download validation
        print(f"Telegram photo size mismatch ({actual}/{total}), performing fresh download validation...", flush=True)
        target.unlink(missing_ok=True)
        downloaded = await client.download_media(message.media, file=str(target))
        if not downloaded or not target.exists():
            raise RuntimeError("telegram_photo_fresh_download_missing")
        actual = target.stat().st_size
        if actual <= 0:
            raise RuntimeError("telegram_photo_fresh_download_empty")
        print(f"Telegram photo fresh download validated: {actual} bytes (was expected {total})", flush=True)
        report_progress(progress_file, "telegram_download", actual, actual)
    else:
        report_progress(progress_file, "telegram_download", actual, total or actual)
    return message, actual


async def download_thumbnail(client, entity, message_id, target, expected_bytes=0, progress_file=None):
    if hasattr(message_id, "media"):
        message = message_id
    else:
        message = await client.get_messages(entity, ids=int(message_id))
    if not message or not getattr(message, "media", None):
        raise RuntimeError("telegram_media_message_missing")
    expected = int(expected_bytes or 0)
    existing = target.stat().st_size if target.exists() else 0
    if expected > 0 and existing == expected:
        report_progress(progress_file, "telegram_download", existing, expected)
        return message, existing
    target.parent.mkdir(parents=True, exist_ok=True)
    target.unlink(missing_ok=True)
    downloaded = await client.download_media(message, file=str(target), thumb=-1)
    if not downloaded or not target.exists():
        raise RuntimeError("telegram_thumbnail_missing")
    actual = target.stat().st_size
    if actual <= 0:
        raise RuntimeError("telegram_thumbnail_empty")
    if expected > 0 and actual != expected:
        print(f"Telegram thumbnail size mismatch ({actual}/{expected}), fresh download accepted", flush=True)
    report_progress(progress_file, "telegram_download", actual, actual)
    return message, actual


def list_uploaded_parts(client, bucket, key, upload_id):
    parts = {}
    marker = None
    while True:
        kwargs = {"Bucket": bucket, "Key": key, "UploadId": upload_id}
        if marker is not None:
            kwargs["PartNumberMarker"] = marker
        response = client.list_parts(**kwargs)
        for part in response.get("Parts", []):
            parts[int(part["PartNumber"])] = clean(part.get("ETag"))
        if not response.get("IsTruncated"):
            break
        marker = response.get("NextPartNumberMarker")
    return parts


def create_checkpoint(client, bucket, key, content_type, checkpoint_path):
    response = client.create_multipart_upload(Bucket=bucket, Key=key, ContentType=content_type or "application/octet-stream")
    checkpoint = {"upload_id": response["UploadId"], "object_key": key, "part_size": PART_SIZE, "parts": {}}
    atomic_json(checkpoint_path, checkpoint)
    return checkpoint


def load_or_create_checkpoint(client, bucket, key, content_type, checkpoint_path):
    checkpoint = read_json(checkpoint_path)
    upload_id = clean(checkpoint.get("upload_id"))
    if upload_id and checkpoint.get("object_key") == key and int(checkpoint.get("part_size") or 0) == PART_SIZE:
        try:
            remote_parts = list_uploaded_parts(client, bucket, key, upload_id)
            checkpoint["parts"] = {str(number): etag for number, etag in remote_parts.items()}
            atomic_json(checkpoint_path, checkpoint)
            return checkpoint
        except ClientError:
            checkpoint_path.unlink(missing_ok=True)
    return create_checkpoint(client, bucket, key, content_type, checkpoint_path)


def upload_small_object(client, bucket, key, local_path, content_type, progress_file=None, timer=None):
    """Fast single PUT path for small objects (< 8 MiB)."""
    total_bytes = local_path.stat().st_size
    with local_path.open("rb") as handle:
        data = handle.read()
    if timer:
        timer.start_stage("r2_upload")
    response = client.put_object(
        Bucket=bucket,
        Key=key,
        Body=data,
        ContentType=content_type or "application/octet-stream",
    )
    etag = clean(response.get("ETag"))
    if timer:
        timer.end_stage("r2_upload")

    if timer:
        timer.start_stage("r2_final_head_verify")
    head = head_matching_object(client, bucket, key, total_bytes)
    if timer:
        timer.end_stage("r2_final_head_verify")
    if not head:
        raise RuntimeError("r2_size_mismatch_after_complete")
    report_progress(progress_file, "r2_upload", total_bytes, total_bytes)
    return {"bytes": total_bytes, "etag": etag or head.get("etag"), "upload_method": "put_object"}


def upload_resumable(local_path, object_key, asset_id, content_type, progress_file=None, timer=None):
    bucket = bucket_name()
    client = r2_client()
    checkpoint_path = cache_root() / f"{asset_id}.r2.json"
    total_bytes = local_path.stat().st_size
    if total_bytes <= 0:
        raise RuntimeError("mirror_local_file_empty")

    if timer:
        timer.start_stage("r2_preflight_head")
    existing = head_matching_object(client, bucket, object_key, total_bytes)
    if timer:
        timer.end_stage("r2_preflight_head")
    if existing:
        checkpoint_path.unlink(missing_ok=True)
        report_progress(progress_file, "r2_upload", total_bytes, total_bytes)
        print(f"R2 object already complete: {total_bytes} bytes", flush=True)
        return existing

    # Small object fast path (< 8 MiB) avoids 3-step multipart overhead
    if total_bytes < SMALL_OBJECT_THRESHOLD_BYTES:
        checkpoint_path.unlink(missing_ok=True)
        return upload_small_object(client, bucket, object_key, local_path, content_type, progress_file=progress_file, timer=timer)

    checkpoint = load_or_create_checkpoint(client, bucket, object_key, content_type, checkpoint_path)
    upload_id = checkpoint["upload_id"]
    completed = {int(number): etag for number, etag in (checkpoint.get("parts") or {}).items() if clean(etag)}
    total_parts = max(1, math.ceil(total_bytes / PART_SIZE))

    if timer:
        timer.start_stage("r2_upload")
    with local_path.open("rb") as handle:
        for part_number in range(1, total_parts + 1):
            if part_number in completed:
                report_progress(progress_file, "r2_upload", min(part_number * PART_SIZE, total_bytes), total_bytes)
                continue
            offset = (part_number - 1) * PART_SIZE
            handle.seek(offset)
            chunk = handle.read(min(PART_SIZE, total_bytes - offset))
            if not chunk:
                raise RuntimeError(f"empty_r2_part:{part_number}")
            response = client.upload_part(
                Bucket=bucket,
                Key=object_key,
                UploadId=upload_id,
                PartNumber=part_number,
                Body=chunk,
            )
            etag = clean(response.get("ETag"))
            if not etag:
                raise RuntimeError(f"missing_r2_etag:{part_number}")
            completed[part_number] = etag
            checkpoint["parts"] = {str(number): value for number, value in sorted(completed.items())}
            atomic_json(checkpoint_path, checkpoint)
            uploaded_bytes = min(part_number * PART_SIZE, total_bytes)
            report_progress(progress_file, "r2_upload", uploaded_bytes, total_bytes)
            print(f"R2 upload part {part_number}/{total_parts}", flush=True)
    if timer:
        timer.end_stage("r2_upload")

    parts = [{"PartNumber": number, "ETag": completed[number]} for number in range(1, total_parts + 1)]
    if timer:
        timer.start_stage("r2_complete")
    client.complete_multipart_upload(
        Bucket=bucket,
        Key=object_key,
        UploadId=upload_id,
        MultipartUpload={"Parts": parts},
    )
    if timer:
        timer.end_stage("r2_complete")

    if timer:
        timer.start_stage("r2_final_head_verify")
    head = head_matching_object(client, bucket, object_key, total_bytes)
    if timer:
        timer.end_stage("r2_final_head_verify")
    if not head:
        raise RuntimeError("r2_size_mismatch_after_complete")
    checkpoint_path.unlink(missing_ok=True)
    report_progress(progress_file, "r2_upload", total_bytes, total_bytes)
    head["upload_method"] = "multipart"
    return head


async def run(args, timer=None):
    global _ACTIVE_TIMER
    _ACTIVE_TIMER = timer
    if not args.api_id or not args.api_hash:
        raise RuntimeError("TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
    require_env("R2_ACCOUNT_ID")
    require_env("R2_ACCESS_KEY_ID")
    require_env("R2_SECRET_ACCESS_KEY")
    bucket = bucket_name()

    cache = cache_root()
    local_name = safe_name(args.original_filename)
    local_path = cache / f"{args.asset_id}-{local_name}.part"
    remux_path = cache / f"{args.asset_id}-{local_name}.faststart.part"
    checkpoint_path = cache / f"{args.asset_id}.r2.json"
    expected = int(args.expected_bytes or 0)
    progress_file = getattr(args, "progress_file", None)
    cache_reused = "none"

    if timer:
        timer.start_stage("r2_preflight_head")
    # If R2 was already completed but the finish callback was lost, a retry can
    # acknowledge the existing object without downloading Telegram again.
    if expected > 0:
        existing = head_matching_object(r2_client(), bucket, args.object_key, expected)
        if timer:
            timer.end_stage("r2_preflight_head")
        if existing:
            clean_asset_cache(args.asset_id, local_name)
            report_progress(progress_file, "r2_upload", expected, expected)
            print(f"R2 object already complete before retry: {expected} bytes", flush=True)
            return {
                "object_key": args.object_key,
                "bytes": existing["bytes"],
                "etag": existing["etag"],
                "telemetry": {
                    "timings_ms": timer.timings if timer else {},
                    "upload_method": "preflight_shortcircuit",
                    "faststart_remuxed": False,
                    "cache_reused": "r2_complete",
                    "attempt": int(getattr(args, "attempt", 0) or 0),
                },
            }
    elif timer:
        timer.end_stage("r2_preflight_head")

    is_photo = (
        args.media_variant == "thumbnail"
        or clean(args.mime_type).startswith("image/")
        or bool(re.search(r"\.(jpe?g|png|webp|gif)$", clean(args.original_filename), re.I))
    )

    manifest = load_cache_manifest(args.asset_id)
    reused_download = can_reuse_download_cache(local_path, manifest, args.channel, args.message_id, expected, is_photo)

    if reused_download:
        actual_bytes = local_path.stat().st_size
        report_progress(progress_file, "telegram_download", actual_bytes, actual_bytes)
        print(f"Reusing existing downloaded Telegram media cache: {actual_bytes} bytes", flush=True)
        cache_reused = "telegram_download"
    else:
        if timer:
            timer.start_stage("telegram_connect")
        async with TelegramClient(local_session(args.session), args.api_id, args.api_hash) as client:
            if timer:
                timer.end_stage("telegram_connect")

            if timer:
                timer.start_stage("telegram_resolve_channel")
            entity = await resolve_channel(client, args.channel)
            if timer:
                timer.end_stage("telegram_resolve_channel")

            if timer:
                timer.start_stage("telegram_message_fetch")
            message_obj = await client.get_messages(entity, ids=int(args.message_id))
            if timer:
                timer.end_stage("telegram_message_fetch")

            if not message_obj or not getattr(message_obj, "media", None):
                raise RuntimeError("telegram_media_message_missing")

            if getattr(message_obj, "photo", None) or getattr(getattr(message_obj, "media", None), "photo", None):
                is_photo = True

            if timer:
                timer.start_stage("telegram_download")
            if args.media_variant == "thumbnail":
                _, actual_bytes = await download_thumbnail(client, entity, message_obj, local_path, expected, progress_file=progress_file)
            else:
                _, actual_bytes = await download_resumable(client, entity, message_obj, local_path, expected, is_photo=is_photo, progress_file=progress_file)
            if timer:
                timer.end_stage("telegram_download")

        save_cache_manifest(args.asset_id, {
            "channel": str(args.channel),
            "message_id": int(args.message_id),
            "download_size": actual_bytes,
        })

    is_video = (
        not is_photo
        and args.media_variant != "thumbnail"
        and (
            clean(args.mime_type).startswith("video/")
            or bool(re.search(r"\.(mp4|m4v|mov)$", clean(args.original_filename), re.I))
            or is_mp4_container(local_path)
        )
    )

    upload_path = local_path
    upload_bytes = actual_bytes
    faststart_remuxed = False

    try:
        if is_video:
            reused_faststart = can_reuse_faststart_cache(remux_path, manifest, args.channel, args.message_id)
            if reused_faststart:
                upload_bytes = remux_path.stat().st_size
                upload_path = remux_path
                print(f"Reusing existing verified faststart remux cache: {upload_bytes} bytes", flush=True)
                cache_reused = "faststart_remux"
            else:
                print(f"Remuxing MP4 with faststart: {local_path} -> {remux_path}", flush=True)
                upload_bytes = remux_video_faststart(local_path, remux_path)
                upload_path = remux_path
                faststart_remuxed = True
                print(f"Faststart remux successful: {upload_bytes} bytes (moov_before_mdat=True)", flush=True)
                save_cache_manifest(args.asset_id, {
                    "channel": str(args.channel),
                    "message_id": int(args.message_id),
                    "faststart_size": upload_bytes,
                    "faststart_verified": True,
                })

        uploaded = upload_resumable(upload_path, args.object_key, args.asset_id, args.mime_type, progress_file=progress_file, timer=timer)
        actual_bytes = upload_bytes
        if uploaded["bytes"] != actual_bytes:
            raise RuntimeError(f"mirror_size_mismatch:{uploaded['bytes']}/{actual_bytes}")

        # Success: clean up cache for this completed asset
        clean_asset_cache(args.asset_id, local_name)
        run_cache_gc(cache, active_asset_ids=[args.asset_id])

        return {
            "object_key": args.object_key,
            "bytes": actual_bytes,
            "etag": uploaded["etag"],
            "telemetry": {
                "timings_ms": timer.timings if timer else {},
                "total_worker_time_ms": timer.total_elapsed_ms() if timer else 0,
                "upload_method": uploaded.get("upload_method", "multipart"),
                "faststart_remuxed": faststart_remuxed,
                "cache_reused": cache_reused,
                "attempt": int(getattr(args, "attempt", 0) or 0),
            },
        }
    except Exception as exc:
        # On retryable failure, invalidate only corrupt files; keep verified partial files
        if remux_path.exists():
            moov_ok, _ = check_moov_before_mdat(remux_path) if remux_path.stat().st_size > 0 else (False, None)
            if not moov_ok:
                remux_path.unlink(missing_ok=True)
        if local_path.exists() and local_path.stat().st_size <= 0:
            local_path.unlink(missing_ok=True)
        raise
    finally:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-id", type=int, default=os.getenv("TELEGRAM_API_ID"))
    parser.add_argument("--api-hash", default=os.getenv("TELEGRAM_API_HASH"))
    parser.add_argument("--session", default="telegram-cloner-reader")
    parser.add_argument("--channel", required=True)
    parser.add_argument("--message-id", required=True, type=int)
    parser.add_argument("--asset-id", required=True)
    parser.add_argument("--object-key", required=True)
    parser.add_argument("--original-filename", default="telegram-media")
    parser.add_argument("--mime-type", default="application/octet-stream")
    parser.add_argument("--expected-bytes", type=int, default=0)
    parser.add_argument("--media-variant", choices=["media", "thumbnail"], default="media")
    parser.add_argument("--progress-file", default=None)
    parser.add_argument("--result-file", required=True)
    parser.add_argument("--attempt", type=int, default=0)
    parser.add_argument("--start-time", type=float, default=None)
    args = parser.parse_args()

    timer = StageTimer(args.start_time)
    if args.start_time:
        timer.record_elapsed("worker_process_startup", max(0, int((time.time() - float(args.start_time)) * 1000)))

    result_path = Path(args.result_file)
    try:
        result = asyncio.run(run(args, timer=timer))
        atomic_json(result_path, {"ok": True, **result})
        print(f"V5 mirror complete: {result['bytes']} bytes → {result['object_key']}")
        return 0
    except Exception as exc:
        atomic_json(result_path, {
            "ok": False,
            "error": str(exc)[:2000],
            "telemetry": {
                "timings_ms": timer.timings,
                "total_worker_time_ms": timer.total_elapsed_ms(),
                "attempt": args.attempt,
            },
        })
        print(f"V5 mirror failed: {exc}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
