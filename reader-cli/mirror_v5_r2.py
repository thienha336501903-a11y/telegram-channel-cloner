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
from pathlib import Path

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from telethon import TelegramClient

from export_history import local_session, resolve_channel

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


async def download_resumable(client, entity, message_id, target, expected_bytes=0):
    message = await client.get_messages(entity, ids=int(message_id))
    if not message or not getattr(message, "media", None):
        raise RuntimeError("telegram_media_message_missing")

    total = message_size(message) or int(expected_bytes or 0)
    existing = target.stat().st_size if target.exists() else 0
    if total > 0 and existing > total:
        target.unlink(missing_ok=True)
        existing = 0
    if total > 0 and existing == total:
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
            if total > 0:
                print(f"Telegram download {existing}/{total} bytes", flush=True)

    actual = target.stat().st_size
    if total > 0 and actual != total:
        raise RuntimeError(f"telegram_download_size_mismatch:{actual}/{total}")
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


def upload_resumable(local_path, object_key, asset_id, content_type):
    bucket = require_env("R2_BUCKET") if clean(os.getenv("R2_BUCKET")) else require_env("V5_R2_BUCKET")
    client = r2_client()
    checkpoint_path = cache_root() / f"{asset_id}.r2.json"
    checkpoint = load_or_create_checkpoint(client, bucket, object_key, content_type, checkpoint_path)
    upload_id = checkpoint["upload_id"]
    completed = {int(number): etag for number, etag in (checkpoint.get("parts") or {}).items() if clean(etag)}
    total_bytes = local_path.stat().st_size
    total_parts = max(1, math.ceil(total_bytes / PART_SIZE))

    with local_path.open("rb") as handle:
        for part_number in range(1, total_parts + 1):
            if part_number in completed:
                continue
            offset = (part_number - 1) * PART_SIZE
            handle.seek(offset)
            chunk = handle.read(min(PART_SIZE, total_bytes - offset))
            if not chunk and total_bytes > 0:
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
            print(f"R2 upload part {part_number}/{total_parts}", flush=True)

    parts = [{"PartNumber": number, "ETag": completed[number]} for number in range(1, total_parts + 1)]
    client.complete_multipart_upload(
        Bucket=bucket,
        Key=object_key,
        UploadId=upload_id,
        MultipartUpload={"Parts": parts},
    )
    head = client.head_object(Bucket=bucket, Key=object_key)
    remote_bytes = int(head.get("ContentLength") or 0)
    if remote_bytes != total_bytes:
        raise RuntimeError(f"r2_size_mismatch:{remote_bytes}/{total_bytes}")
    checkpoint_path.unlink(missing_ok=True)
    return {"bytes": remote_bytes, "etag": clean(head.get("ETag"))}


async def run(args):
    if not args.api_id or not args.api_hash:
        raise RuntimeError("TELEGRAM_API_ID and TELEGRAM_API_HASH are required")
    require_env("R2_ACCOUNT_ID")
    require_env("R2_ACCESS_KEY_ID")
    require_env("R2_SECRET_ACCESS_KEY")
    if not clean(os.getenv("R2_BUCKET")) and not clean(os.getenv("V5_R2_BUCKET")):
        raise RuntimeError("R2_BUCKET or V5_R2_BUCKET is required")

    cache = cache_root()
    local_name = safe_name(args.original_filename)
    local_path = cache / f"{args.asset_id}-{local_name}.part"

    async with TelegramClient(local_session(args.session), args.api_id, args.api_hash) as client:
        entity = await resolve_channel(client, args.channel)
        _, actual_bytes = await download_resumable(client, entity, args.message_id, local_path, args.expected_bytes)

    uploaded = upload_resumable(local_path, args.object_key, args.asset_id, args.mime_type)
    if uploaded["bytes"] != actual_bytes:
        raise RuntimeError(f"mirror_size_mismatch:{uploaded['bytes']}/{actual_bytes}")
    local_path.unlink(missing_ok=True)
    return {"object_key": args.object_key, "bytes": actual_bytes, "etag": uploaded["etag"]}


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
