"""Pure validation helpers for REBUILD_FROM_TELEGRAM_EXPORT.

This module deliberately has no Telegram dependency so CI can exercise the
manifest and backup safety gates without credentials or network access.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


SCHEMA = "tgcloner.rebuild_from_telegram_export.v1"
PILOT_MAX_UNITS = 2


def canonical_manifest_hash(manifest: dict) -> str:
    payload = dict(manifest)
    payload.pop("manifest_sha256", None)
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(8 * 1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def validate_manifest(manifest: dict, *, verify_media_bytes: bool = True) -> dict:
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA:
        raise RuntimeError("rebuild_manifest_schema_invalid")

    expected_hash = str(manifest.get("manifest_sha256") or "").lower()
    if len(expected_hash) != 64 or canonical_manifest_hash(manifest) != expected_hash:
        raise RuntimeError("rebuild_manifest_hash_mismatch")

    source = manifest.get("source") or {}
    backup = manifest.get("backup") or {}
    topology = manifest.get("topology") or {}
    policy = manifest.get("policy") or {}
    units = manifest.get("units") or []

    source_chat = str(source.get("chat_id") or "")
    if not source_chat.startswith("-100") or not source_chat[4:].isdigit():
        raise RuntimeError("rebuild_source_chat_invalid")
    if source.get("protected") is not True:
        raise RuntimeError("rebuild_source_must_be_protected")
    if int(source.get("message_count") or 0) < 1:
        raise RuntimeError("rebuild_source_message_count_invalid")

    if policy.get("source_telegram_read_only") is not True:
        raise RuntimeError("rebuild_policy_source_not_readonly")
    if policy.get("download_from_protected_source") is not False:
        raise RuntimeError("rebuild_policy_source_download_forbidden")
    if policy.get("forward_from_protected_source") is not False:
        raise RuntimeError("rebuild_policy_source_forward_forbidden")
    if policy.get("media_source") != "verified_local_backup_only":
        raise RuntimeError("rebuild_policy_media_source_invalid")
    if policy.get("destination_write_allowed_only_after_explicit_publish_gate") is not True:
        raise RuntimeError("rebuild_policy_publish_gate_missing")

    if not isinstance(units, list) or len(units) != int(topology.get("rebuild_unit_count") or -1):
        raise RuntimeError("rebuild_unit_count_mismatch")
    if not 1 <= len(units) <= 100000:
        raise RuntimeError("rebuild_unit_count_invalid")

    root = Path(str(backup.get("root") or "")).resolve()
    if verify_media_bytes and not root.is_dir():
        raise RuntimeError("rebuild_backup_root_missing")

    seen_ids = set()
    media_count = 0
    previous_unit = 0

    for unit in units:
        number = int(unit.get("unit_number") or 0)
        if number != previous_unit + 1:
            raise RuntimeError("rebuild_unit_order_invalid")
        previous_unit = number

        kind = unit.get("kind")
        if kind not in ("message", "album"):
            raise RuntimeError(f"rebuild_unit_kind_invalid:{number}")

        source_ids = [int(value) for value in (unit.get("source_message_ids") or [])]
        messages = unit.get("messages") or []
        if not source_ids or len(source_ids) != len(messages):
            raise RuntimeError(f"rebuild_unit_members_invalid:{number}")
        if kind == "message" and len(source_ids) != 1:
            raise RuntimeError(f"rebuild_single_unit_size_invalid:{number}")
        if kind == "album" and not 2 <= len(source_ids) <= 10:
            raise RuntimeError(f"rebuild_album_size_invalid:{number}")

        if source_ids != sorted(source_ids):
            raise RuntimeError(f"rebuild_source_order_invalid:{number}")

        for source_id, message in zip(source_ids, messages):
            if source_id in seen_ids:
                raise RuntimeError(f"rebuild_duplicate_source_message:{source_id}")
            seen_ids.add(source_id)
            if int(message.get("source_message_id") or 0) != source_id:
                raise RuntimeError(f"rebuild_message_identity_mismatch:{source_id}")

            text = str(message.get("text") or "")
            media = message.get("media") or []
            telegram_type = str(message.get("telegram_type") or "")

            if not media:
                if telegram_type != "text":
                    raise RuntimeError(f"rebuild_missing_media_for_type:{source_id}")
                if not text:
                    raise RuntimeError(f"rebuild_empty_text_message:{source_id}")
                if len(text) > 4096:
                    raise RuntimeError(f"rebuild_text_too_long:{source_id}")
            else:
                if len(media) != 1:
                    raise RuntimeError(f"rebuild_message_media_cardinality_invalid:{source_id}")
                if telegram_type not in ("photo", "video", "audio", "document"):
                    raise RuntimeError(f"rebuild_media_type_invalid:{source_id}")
                if len(text) > 1024:
                    raise RuntimeError(f"rebuild_caption_too_long:{source_id}")

            for item in media:
                media_count += 1
                local_path = Path(str(item.get("local_path") or "")).resolve()
                relative_path = str(item.get("relative_path") or "")
                expected_size = int(item.get("size_bytes") or -1)
                expected_sha = str(item.get("sha256") or "").lower()
                if not relative_path or expected_size < 0 or len(expected_sha) != 64:
                    raise RuntimeError(f"rebuild_media_descriptor_invalid:{source_id}")
                try:
                    common = os.path.commonpath([str(root), str(local_path)])
                except ValueError:
                    common = ""
                if os.path.normcase(common) != os.path.normcase(str(root)):
                    raise RuntimeError(f"rebuild_media_path_escapes_root:{source_id}")
                if verify_media_bytes:
                    if not local_path.is_file():
                        raise RuntimeError(f"rebuild_media_missing:{source_id}")
                    actual_size = local_path.stat().st_size
                    if actual_size != expected_size:
                        raise RuntimeError(f"rebuild_media_size_changed:{source_id}")
                    if sha256_file(local_path) != expected_sha:
                        raise RuntimeError(f"rebuild_media_hash_changed:{source_id}")

    if len(seen_ids) != int(source.get("message_count") or 0):
        raise RuntimeError("rebuild_source_message_coverage_mismatch")
    if media_count != int(backup.get("media_count") or -1):
        raise RuntimeError("rebuild_media_count_mismatch")

    return {
        "manifest_sha256": expected_hash,
        "source_chat_id": source_chat,
        "unit_count": len(units),
        "media_count": media_count,
        "backup_root": str(root),
    }


def pilot_units(manifest: dict, max_units: int) -> list:
    max_units = int(max_units)
    if not 1 <= max_units <= PILOT_MAX_UNITS:
        raise RuntimeError(f"rebuild_pilot_max_units_must_be_1_to_{PILOT_MAX_UNITS}")
    units = manifest.get("units") or []
    if len(units) < max_units:
        raise RuntimeError("rebuild_pilot_manifest_too_short")
    return units[:max_units]
