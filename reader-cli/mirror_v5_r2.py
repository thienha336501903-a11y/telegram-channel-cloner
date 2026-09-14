#!/usr/bin/env python3
"""Mirror one Telegram media message into a private Cloudflare R2 bucket.

This worker runs only on the local Reader machine. Telegram user-session secrets and
R2 credentials never leave the Reader environment. Telegram download and R2 upload
keep local checkpoints so retries can continue instead of restarting from 0.
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

PROCESS_STARTED = time.monotonic()
PART_SIZE = 16 * 1024 * 1024
SMALL_PUT_THRESHOLD = 8 * 1024 * 1024
DOWNLOAD_REQUEST_SIZE = 512 * 1024
CACHE_TTL_SECONDS = 72 * 60 * 60
CACHE_MIN_GC_AGE_SECONDS = 60 * 60
CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024

_last_progress_time = 0.0
_progress_stage_state = {}
_telemetry = {
    "version": 1,
    "timings_ms": {},
    "bytes": {},
    "cache": {
        "telegram_reused": False,
        "faststart_reused": False,
        "r2_already_complete": False,
        "r2_small_put": False,
    },
}


def clean(value):
    return str(value or "").strip()


def safe_name(value):
    name = clean(value) or "telegram-media"
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name)
    name = re.sub(r"-+", "-", name).strip("-.")
    return (name or "telegram-media")[:160]


def positive_int_env(name, default, minimum=1, maximum=None):
    try:
        value = int(clean(os.getenv(name)) or default)
    except (TypeError, ValueError):
        value = int(default)
    value = max(int(minimum), value)
    if maximum is not None:
        value = min(int(maximum), value)
    return value


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


def metric_ms(started_at):
    return max(0, int(round((time.monotonic() - started_at) * 1000)))


def record_timing(name, started_at):
    _telemetry["timings_ms"][name] = metric_ms(started_at)


def telemetry_snapshot():
    return {
        "version": 1,
        "timings_ms": {
            str(key): int(value)
            for key, value in (_telemetry.get("timings_ms") or {}).items()
            if isinstance(value, int) and value >= 0
        },
        "bytes": {
            str(key): int(value)
            for key, value in (_telemetry.get("bytes") or {}).items()
            if isinstance(value, int) and value >= 0
        },
        "cache": {
            str(key): bool(value)
            for key, value in (_telemetry.get("cache") or {}).items()
            if isinstance(value, bool)
        },
    }


def report_progress(progress_file, stage, current=0, total=None):
    """Write local progress with rate/ETA. No credentials or identifiers are included."""
    global _last_progress_time
    if not progress_file:
        return

    now_wall = time.time()
    now_mono = time.monotonic()
    curr_int = int(current or 0)
    total_int = int(total) if total is not None and int(total) > 0 else None
    is_done = total_int is not None and curr_int >= total_int

    state = _progress_stage_state.get(stage)
    if not state:
        state = {"started_at": now_mono, "start_bytes": curr_int}
        _progress_stage_state.clear()
        _progress_stage_state[stage] = state

    if not is_done and (now_wall - _last_progress_time) < 0.8:
        return

    elapsed = max(0.001, now_mono - state["started_at"])
    transferred = max(0, curr_int - int(state.get("start_bytes") or 0))
    rate_bps = int(transferred / elapsed) if transferred > 0 else 0
    eta_seconds = None
    if total_int is not None and rate_bps > 0 and curr_int < total_int:
        eta_seconds = max(0, int((total_int - curr_int) / rate_bps))

    _last_progress_time = now_wall
    payload = {
        "stage": str(stage or "")[:80],
        "current": curr_int,
        "total": total_int,
        "rate_bps": rate_bps,
        "eta_seconds": eta_seconds,
        "stage_elapsed_ms": int(elapsed * 1000),
    }
    try:
        atomic_json(Path(progress_file), payload)
    except Exception:
        pass


def parse_mp4_atoms(file_path):
    """Parse top-level atoms of an MP4/ISOBMFF file."""
    path = Path(file_path)
    file_size = path.stat().st_size
    atoms = []
    with path.open("rb") as handle:
        offset = 0
        while offset < file_size:
            header = handle.read(8)
            if len(header) < 8:
                if not header:
                    break
                raise ValueError(f"truncated_atom_header:offset_{offset}")
            size, name_bytes = struct.unpack(">I4s", header)
            name = name_bytes.decode("latin1", errors="replace")
            header_size = 8
            if size == 1:
                ext = handle.read(8)
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
            handle.seek(offset)
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
        return atoms[0]["name"] == "ftyp" or any(item["name"] in ("ftyp", "moov") for item in atoms)
    except Exception:
        return False


def resolve_binary(name):
    """Resolve an executable binary, preferring the bundled Reader bin directory."""
    exe_name = f"{name}.exe" if os.name == "nt" and not name.endswith(".exe") else name
    candidates = []
    try:
        exe_dir = Path(sys.executable).resolve().parent
        candidates.extend([exe_dir / "bin" / exe_name, exe_dir / exe_name])
    except Exception:
        pass

    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        try:
            mei_dir = Path(meipass).resolve()
            candidates.extend([mei_dir / "bin" / exe_name, mei_dir / exe_name])
        except Exception:
            pass

    try:
        cur_file = Path(__file__).resolve()
        candidates.extend([
            cur_file.parent / "bin" / exe_name,
            cur_file.parents[1] / "reader-manager" / "bin" / exe_name,
            cur_file.parents[1] / "bin" / exe_name,
        ])
    except Exception:
        pass

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    found_in_path = shutil.which(name) or shutil.which(exe_name)
    if found_in_path:
        return found_in_path
    raise RuntimeError(f"faststart_dependency_missing:{name}_not_found")


def get_ffmpeg_bin():
    return resolve_binary("ffmpeg")


def get_ffprobe_bin():
    return resolve_binary("ffprobe")


def probe_media(file_path, ffprobe_bin=None):
    ffprobe_bin = ffprobe_bin or get_ffprobe_bin()
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
        raise RuntimeError(f"ffprobe_json_parse_error:{exc}") from exc


def media_equivalent(source_probe, output_probe):
    source_streams = source_probe.get("streams", [])
    output_streams = output_probe.get("streams", [])
    source_video = [item for item in source_streams if item.get("codec_type") == "video"]
    output_video = [item for item in output_streams if item.get("codec_type") == "video"]
    source_audio = [item for item in source_streams if item.get("codec_type") == "audio"]
    output_audio = [item for item in output_streams if item.get("codec_type") == "audio"]

    if not source_video or not output_video:
        return False
    if clean(source_video[0].get("codec_name")) != clean(output_video[0].get("codec_name")):
        return False
    if source_audio:
        if not output_audio:
            return False
        if clean(source_audio[0].get("codec_name")) != clean(output_audio[0].get("codec_name")):
            return False

    try:
        source_duration = float(source_probe.get("format", {}).get("duration") or 0)
        output_duration = float(output_probe.get("format", {}).get("duration") or 0)
        if source_duration > 0 and output_duration > 0 and abs(source_duration - output_duration) > 0.5:
            return False
    except (ValueError, TypeError):
        pass
    return True


def validate_faststart_cache(source_path, output_path):
    try:
        if not output_path.exists() or output_path.stat().st_size <= 0:
            return False
        moov_ok, _ = check_moov_before_mdat(output_path)
        if not moov_ok:
            return False
        ffprobe_bin = get_ffprobe_bin()
        return media_equivalent(
            probe_media(source_path, ffprobe_bin=ffprobe_bin),
            probe_media(output_path, ffprobe_bin=ffprobe_bin),
        )
    except Exception:
        return False


def remux_video_faststart(input_path, output_path):
    ffmpeg_bin = get_ffmpeg_bin()
    ffprobe_bin = get_ffprobe_bin()
    try:
        source_probe = probe_media(input_path, ffprobe_bin=ffprobe_bin)
    except Exception as exc:
        if "faststart_dependency_missing" in str(exc):
            raise
        raise RuntimeError(f"faststart_remux_failed:source_probe_failed:{exc}") from exc

    source_video = [item for item in source_probe.get("streams", []) if item.get("codec_type") == "video"]
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
    res = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=180,
        **popen_kwargs,
    )
    if res.returncode != 0:
        raise RuntimeError(f"faststart_remux_failed:ffmpeg_exit_{res.returncode}:{clean(res.stderr)[:200]}")
    if not output_path.exists():
        raise RuntimeError("faststart_remux_failed:output_missing")
    if output_path.stat().st_size <= 0:
        raise RuntimeError("faststart_remux_failed:output_empty")

    moov_ok, moov_error = check_moov_before_mdat(output_path)
    if not moov_ok:
        raise RuntimeError(f"faststart_remux_failed:{moov_error}")

    try:
        output_probe = probe_media(output_path, ffprobe_bin=ffprobe_bin)
    except Exception as exc:
        if "faststart_dependency_missing" in str(exc):
            raise
        raise RuntimeError(f"faststart_remux_failed:output_probe_failed:{exc}") from exc
    if not media_equivalent(source_probe, output_probe):
        raise RuntimeError("faststart_remux_failed:stream_or_duration_mismatch")
    return output_path.stat().st_size


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


def cache_gc(root, protected_prefix=""):
    """Delete only stale Reader-owned .part files; never touch arbitrary files or live checkpoints."""
    ttl = positive_int_env("V5_R2_CACHE_TTL_SECONDS", CACHE_TTL_SECONDS, 3600, 30 * 24 * 3600)
    max_bytes = positive_int_env("V5_R2_CACHE_MAX_BYTES", CACHE_MAX_BYTES, 256 * 1024 * 1024)
    min_age = positive_int_env("V5_R2_CACHE_MIN_GC_AGE_SECONDS", CACHE_MIN_GC_AGE_SECONDS, 300, ttl)
    now = time.time()
    candidates = []
    total = 0

    try:
        for path in root.glob("*.part"):
            try:
                if protected_prefix and path.name.startswith(f"{protected_prefix}-"):
                    continue
                stat = path.stat()
            except OSError:
                continue
            total += max(0, stat.st_size)
            candidates.append((path, stat.st_mtime, max(0, stat.st_size)))
    except OSError:
        return

    for path, modified, _size in list(candidates):
        if now - modified < ttl:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    remaining = []
    total = 0
    for path, modified, _size in candidates:
        try:
            stat = path.stat()
        except OSError:
            continue
        total += max(0, stat.st_size)
        remaining.append((path, stat.st_mtime, max(0, stat.st_size)))

    if total <= max_bytes:
        return

    for path, modified, size in sorted(remaining, key=lambda item: item[1]):
        if total <= max_bytes:
            break
        if now - modified < min_age:
            continue
        try:
            path.unlink(missing_ok=True)
            total -= size
        except OSError:
            pass


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


async def download_resumable(
    client,
    entity,
    message_id,
    target,
    expected_bytes=0,
    is_photo=False,
    progress_file=None,
    message=None,
):
    message = message or await client.get_messages(entity, ids=int(message_id))
    if not message or not getattr(message, "media", None):
        raise RuntimeError("telegram_media_message_missing")

    total = message_size(message) or int(expected_bytes or 0)
    existing = target.stat().st_size if target.exists() else 0
    if total > 0 and existing > total:
        target.unlink(missing_ok=True)
        existing = 0
    if total > 0 and existing == total and not is_photo:
        _telemetry["cache"]["telegram_reused"] = True
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

    actual = target.stat().st_size
    if actual <= 0:
        raise RuntimeError("telegram_download_empty")
    if total > 0 and actual != total:
        if not is_photo:
            raise RuntimeError(f"telegram_download_size_mismatch:{actual}/{total}")
        target.unlink(missing_ok=True)
        downloaded = await client.download_media(message.media, file=str(target))
        if not downloaded or not target.exists():
            raise RuntimeError("telegram_photo_fresh_download_missing")
        actual = target.stat().st_size
        if actual <= 0:
            raise RuntimeError("telegram_photo_fresh_download_empty")
        report_progress(progress_file, "telegram_download", actual, actual)
    else:
        report_progress(progress_file, "telegram_download", actual, total or actual)
    return message, actual


async def download_thumbnail(
    client,
    entity,
    message_id,
    target,
    expected_bytes=0,
    progress_file=None,
    message=None,
):
    message = message or await client.get_messages(entity, ids=int(message_id))
    if not message or not getattr(message, "media", None):
        raise RuntimeError("telegram_media_message_missing")
    expected = int(expected_bytes or 0)
    existing = target.stat().st_size if target.exists() else 0
    if expected > 0 and existing == expected:
        _telemetry["cache"]["telegram_reused"] = True
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
    response = client.create_multipart_upload(
        Bucket=bucket,
        Key=key,
        ContentType=content_type or "application/octet-stream",
    )
    checkpoint = {
        "upload_id": response["UploadId"],
        "object_key": key,
        "part_size": PART_SIZE,
        "parts": {},
    }
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


def upload_small_object(client, bucket, local_path, object_key, content_type, progress_file=None):
    total_bytes = local_path.stat().st_size
    report_progress(progress_file, "r2_upload", 0, total_bytes)
    with local_path.open("rb") as handle:
        client.put_object(
            Bucket=bucket,
            Key=object_key,
            Body=handle,
            ContentType=content_type or "application/octet-stream",
        )
    report_progress(progress_file, "r2_upload", total_bytes, total_bytes)
    head = head_matching_object(client, bucket, object_key, total_bytes)
    if not head:
        raise RuntimeError("r2_size_mismatch_after_put")
    _telemetry["cache"]["r2_small_put"] = True
    return head


def upload_resumable(local_path, object_key, asset_id, content_type, progress_file=None):
    bucket = bucket_name()
    client = r2_client()
    checkpoint_path = cache_root() / f"{asset_id}.r2.json"
    total_bytes = local_path.stat().st_size
    if total_bytes <= 0:
        raise RuntimeError("mirror_local_file_empty")

    existing = head_matching_object(client, bucket, object_key, total_bytes)
    if existing:
        checkpoint_path.unlink(missing_ok=True)
        _telemetry["cache"]["r2_already_complete"] = True
        report_progress(progress_file, "r2_upload", total_bytes, total_bytes)
        return existing

    if total_bytes <= SMALL_PUT_THRESHOLD:
        checkpoint_path.unlink(missing_ok=True)
        return upload_small_object(client, bucket, local_path, object_key, content_type, progress_file)

    checkpoint = load_or_create_checkpoint(client, bucket, object_key, content_type, checkpoint_path)
    upload_id = checkpoint["upload_id"]
    completed = {
        int(number): etag
        for number, etag in (checkpoint.get("parts") or {}).items()
        if clean(etag)
    }
    total_parts = max(1, math.ceil(total_bytes / PART_SIZE))

    with local_path.open("rb") as handle:
        for part_number in range(1, total_parts + 1):
            if part_number in completed:
                report_progress(
                    progress_file,
                    "r2_upload",
                    min(part_number * PART_SIZE, total_bytes),
                    total_bytes,
                )
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
            checkpoint["parts"] = {
                str(number): value
                for number, value in sorted(completed.items())
            }
            atomic_json(checkpoint_path, checkpoint)
            uploaded_bytes = min(part_number * PART_SIZE, total_bytes)
            report_progress(progress_file, "r2_upload", uploaded_bytes, total_bytes)

    parts = [
        {"PartNumber": number, "ETag": completed[number]}
        for number in range(1, total_parts + 1)
    ]
    client.complete_multipart_upload(
        Bucket=bucket,
        Key=object_key,
        UploadId=upload_id,
        MultipartUpload={"Parts": parts},
    )
    head = head_matching_object(client, bucket, object_key, total_bytes)
    if not head:
        raise RuntimeError("r2_size_mismatch_after_complete")
    checkpoint_path.unlink(missing_ok=True)
    report_progress(progress_file, "r2_upload", total_bytes, total_bytes)
    return head


async def run(args):
    overall_started = time.monotonic()
    if not args.api_id or not args.api_hash:
        raise RuntimeError("TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
    require_env("R2_ACCOUNT_ID")
    require_env("R2_ACCESS_KEY_ID")
    require_env("R2_SECRET_ACCESS_KEY")
    bucket = bucket_name()

    cache = cache_root()
    cache_gc(cache, protected_prefix=str(args.asset_id))
    local_name = safe_name(args.original_filename)
    local_path = cache / f"{args.asset_id}-{local_name}.part"
    remux_path = cache / f"{args.asset_id}-{local_name}.faststart.part"
    checkpoint_path = cache / f"{args.asset_id}.r2.json"
    expected = int(args.expected_bytes or 0)
    progress_file = getattr(args, "progress_file", None)
    success = False

    try:
        precheck_started = time.monotonic()
        report_progress(progress_file, "r2_precheck", 0, expected or None)
        if expected > 0:
            existing = head_matching_object(r2_client(), bucket, args.object_key, expected)
            if existing:
                local_path.unlink(missing_ok=True)
                remux_path.unlink(missing_ok=True)
                checkpoint_path.unlink(missing_ok=True)
                _telemetry["cache"]["r2_already_complete"] = True
                _telemetry["bytes"]["uploaded"] = int(existing["bytes"])
                record_timing("r2_precheck_ms", precheck_started)
                record_timing("total_ms", overall_started)
                success = True
                return {
                    "object_key": args.object_key,
                    "bytes": existing["bytes"],
                    "etag": existing["etag"],
                    "telemetry": telemetry_snapshot(),
                }
        record_timing("r2_precheck_ms", precheck_started)

        is_photo = (
            args.media_variant == "thumbnail"
            or clean(args.mime_type).startswith("image/")
            or bool(re.search(r"\.(jpe?g|png|webp|gif)$", clean(args.original_filename), re.I))
        )

        connect_started = time.monotonic()
        client = TelegramClient(local_session(args.session), args.api_id, args.api_hash)
        async with client:
            record_timing("telegram_connect_ms", connect_started)

            resolve_started = time.monotonic()
            report_progress(progress_file, "telegram_resolve", 0, None)
            entity = await resolve_channel(client, args.channel)
            message_obj = await client.get_messages(entity, ids=int(args.message_id))
            record_timing("telegram_resolve_ms", resolve_started)
            if not message_obj or not getattr(message_obj, "media", None):
                raise RuntimeError("telegram_media_message_missing")

            if message_obj and (
                getattr(message_obj, "photo", None)
                or getattr(getattr(message_obj, "media", None), "photo", None)
            ):
                is_photo = True

            download_started = time.monotonic()
            if args.media_variant == "thumbnail":
                _, actual_bytes = await download_thumbnail(
                    client,
                    entity,
                    args.message_id,
                    local_path,
                    expected,
                    progress_file=progress_file,
                    message=message_obj,
                )
            else:
                _, actual_bytes = await download_resumable(
                    client,
                    entity,
                    args.message_id,
                    local_path,
                    expected,
                    is_photo=is_photo,
                    progress_file=progress_file,
                    message=message_obj,
                )
            record_timing("telegram_download_ms", download_started)

        _telemetry["bytes"]["telegram"] = int(actual_bytes)
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
        if is_video:
            faststart_started = time.monotonic()
            report_progress(progress_file, "faststart", 0, actual_bytes)
            if validate_faststart_cache(local_path, remux_path):
                _telemetry["cache"]["faststart_reused"] = True
                upload_bytes = remux_path.stat().st_size
            else:
                remux_path.unlink(missing_ok=True)
                upload_bytes = remux_video_faststart(local_path, remux_path)
            upload_path = remux_path
            report_progress(progress_file, "faststart", upload_bytes, upload_bytes)
            record_timing("faststart_ms", faststart_started)

        upload_started = time.monotonic()
        uploaded = upload_resumable(
            upload_path,
            args.object_key,
            args.asset_id,
            args.mime_type,
            progress_file=progress_file,
        )
        record_timing("r2_upload_ms", upload_started)

        actual_bytes = upload_bytes
        _telemetry["bytes"]["uploaded"] = int(actual_bytes)
        if uploaded["bytes"] != actual_bytes:
            raise RuntimeError(f"mirror_size_mismatch:{uploaded['bytes']}/{actual_bytes}")

        record_timing("total_ms", overall_started)
        success = True
        return {
            "object_key": args.object_key,
            "bytes": actual_bytes,
            "etag": uploaded["etag"],
            "telemetry": telemetry_snapshot(),
        }
    finally:
        # Preserve completed Telegram / faststart files on failure so the queued
        # retry can avoid re-downloading and re-remuxing. Success cleans them.
        if success:
            remux_path.unlink(missing_ok=True)
            local_path.unlink(missing_ok=True)


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
    args = parser.parse_args()

    result_path = Path(args.result_file)
    try:
        result = asyncio.run(run(args))
        atomic_json(result_path, {"ok": True, **result})
        print(f"V5 mirror complete: {result['bytes']} bytes")
        return 0
    except Exception as exc:
        if "total_ms" not in _telemetry["timings_ms"]:
            _telemetry["timings_ms"]["total_ms"] = metric_ms(PROCESS_STARTED)
        atomic_json(
            result_path,
            {
                "ok": False,
                "error": str(exc)[:2000],
                "telemetry": telemetry_snapshot(),
            },
        )
        print(f"V5 mirror failed: {exc}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
