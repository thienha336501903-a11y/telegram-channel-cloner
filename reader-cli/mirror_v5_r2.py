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


_last_progress_time = 0


def report_progress(progress_file, stage, current, total):
    global _last_progress_time
    if not progress_file:
        return
    now = time.time()
    curr_int = int(current or 0)
    total_int = int(total) if total is not None and int(total) > 0 else None
    is_done = total_int is not None and curr_int >= total_int
    if not is_done and (now - _last_progress_time) < 0.8:
        return
    _last_progress_time = now
    payload = {
        "stage": stage,
        "current": curr_int,
        "total": total_int,
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


def remux_video_faststart(input_path, output_path):
    ffmpeg_bin = get_ffmpeg_bin()
    ffprobe_bin = get_ffprobe_bin()
    try:
        source_probe = probe_media(input_path, ffprobe_bin=ffprobe_bin)
    except Exception as exc:
        if "faststart_dependency_missing" in str(exc):
            raise
        raise RuntimeError(f"faststart_remux_failed:source_probe_failed:{exc}") from exc
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

    out_size = output_path.stat().st_size
    if out_size <= 0:
        raise RuntimeError("faststart_remux_failed:output_empty")

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
        report_progress(progress_file, "r2_upload", total_bytes, total_bytes)
        print(f"R2 object already complete: {total_bytes} bytes", flush=True)
        return existing

    checkpoint = load_or_create_checkpoint(client, bucket, object_key, content_type, checkpoint_path)
    upload_id = checkpoint["upload_id"]
    completed = {int(number): etag for number, etag in (checkpoint.get("parts") or {}).items() if clean(etag)}
    total_parts = max(1, math.ceil(total_bytes / PART_SIZE))

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

    parts = [{"PartNumber": number, "ETag": completed[number]} for number in range(1, total_parts + 1)]
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
    if not args.api_id or not args.api_hash:
        raise RuntimeError("TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
    require_env("R2_ACCOUNT_ID")
    require_env("R2_ACCESS_KEY_ID")
    require_env("R2_SECRET_ACCESS_KEY")
    bucket = bucket_name()

    cache = cache_root()
    local_name = safe_name(args.original_filename)
    local_path = cache / f"{args.asset_id}-{local_name}.part"
    checkpoint_path = cache / f"{args.asset_id}.r2.json"
    expected = int(args.expected_bytes or 0)
    progress_file = getattr(args, "progress_file", None)

    # If R2 was already completed but the finish callback was lost, a retry can
    # acknowledge the existing object without downloading Telegram again.
    if expected > 0:
        existing = head_matching_object(r2_client(), bucket, args.object_key, expected)
        if existing:
            local_path.unlink(missing_ok=True)
            checkpoint_path.unlink(missing_ok=True)
            report_progress(progress_file, "r2_upload", expected, expected)
            print(f"R2 object already complete before retry: {expected} bytes", flush=True)
            return {"object_key": args.object_key, "bytes": existing["bytes"], "etag": existing["etag"]}

    is_photo = (
        args.media_variant == "thumbnail"
        or clean(args.mime_type).startswith("image/")
        or bool(re.search(r"\.(jpe?g|png|webp|gif)$", clean(args.original_filename), re.I))
    )

    async with TelegramClient(local_session(args.session), args.api_id, args.api_hash) as client:
        entity = await resolve_channel(client, args.channel)
        if args.media_variant == "thumbnail":
            _, actual_bytes = await download_thumbnail(client, entity, args.message_id, local_path, expected, progress_file=progress_file)
        else:
            message_obj = await client.get_messages(entity, ids=int(args.message_id))
            if message_obj and (getattr(message_obj, "photo", None) or getattr(getattr(message_obj, "media", None), "photo", None)):
                is_photo = True
            _, actual_bytes = await download_resumable(client, entity, args.message_id, local_path, expected, is_photo=is_photo, progress_file=progress_file)

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
    remux_path = cache / f"{args.asset_id}-{local_name}.faststart.part"

    try:
        if is_video:
            print(f"Remuxing MP4 with faststart: {local_path} -> {remux_path}", flush=True)
            upload_bytes = remux_video_faststart(local_path, remux_path)
            upload_path = remux_path
            print(f"Faststart remux successful: {upload_bytes} bytes (moov_before_mdat=True)", flush=True)

        uploaded = upload_resumable(upload_path, args.object_key, args.asset_id, args.mime_type, progress_file=progress_file)
        actual_bytes = upload_bytes
        if uploaded["bytes"] != actual_bytes:
            raise RuntimeError(f"mirror_size_mismatch:{uploaded['bytes']}/{actual_bytes}")
        return {"object_key": args.object_key, "bytes": actual_bytes, "etag": uploaded["etag"]}
    finally:
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
        print(f"V5 mirror complete: {result['bytes']} bytes → {result['object_key']}")
        return 0
    except Exception as exc:
        atomic_json(result_path, {"ok": False, "error": str(exc)[:2000]})
        print(f"V5 mirror failed: {exc}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
