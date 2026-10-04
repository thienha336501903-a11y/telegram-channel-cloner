"""Pure validation/state helpers for rebuilding a Telegram course from a verified local export.

This module never connects to Telegram and never mutates backup media.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

SCHEMA = "tgcloner.rebuild_from_telegram_export.v1"
MAX_PILOT_UNITS = 2


class RebuildValidationError(RuntimeError):
    pass


def _canonical_without_hash(manifest):
    value = dict(manifest)
    value.pop("manifest_sha256", None)
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def manifest_digest(manifest):
    return hashlib.sha256(_canonical_without_hash(manifest)).hexdigest()


def load_manifest(path):
    path = Path(path).resolve()
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != SCHEMA:
        raise RebuildValidationError("unsupported_rebuild_manifest_schema")
    expected_hash = str(value.get("manifest_sha256") or "").lower()
    if len(expected_hash) != 64 or manifest_digest(value) != expected_hash:
        raise RebuildValidationError("rebuild_manifest_hash_mismatch")

    source = value.get("source") or {}
    backup = value.get("backup") or {}
    topology = value.get("topology") or {}
    policy = value.get("policy") or {}
    units = value.get("units") or []

    if (
        source.get("protected") is not True
        or str(source.get("chat_id") or "") != "-1002049524573"
        or int(source.get("message_count") or 0) != 28
    ):
        raise RebuildValidationError("unexpected_verified_source_identity")

    if (
        int(backup.get("media_count") or 0) != 24
        or int(backup.get("video_count") or 0) != 11
        or int(backup.get("photo_count") or 0) != 13
        or int(backup.get("text_only_count") or 0) != 4
    ):
        raise RebuildValidationError("unexpected_verified_backup_inventory")

    if (
        int(topology.get("album_count") or 0) != 8
        or int(topology.get("single_unit_count") or 0) != 6
        or int(topology.get("rebuild_unit_count") or 0) != 14
        or len(units) != 14
    ):
        raise RebuildValidationError("unexpected_verified_rebuild_topology")

    required_policy = {
        "source_telegram_read_only": True,
        "download_from_protected_source": False,
        "forward_from_protected_source": False,
        "media_source": "verified_local_backup_only",
        "destination_write_allowed_only_after_explicit_publish_gate": True,
    }
    for key, expected in required_policy.items():
        if policy.get(key) != expected:
            raise RebuildValidationError(f"unsafe_rebuild_policy:{key}")

    seen_ids = []
    for expected_number, unit in enumerate(units, start=1):
        if int(unit.get("unit_number") or 0) != expected_number:
            raise RebuildValidationError("rebuild_unit_number_gap")
        if unit.get("kind") not in ("album", "message"):
            raise RebuildValidationError("rebuild_unit_kind_invalid")
        ids = [int(item) for item in unit.get("source_message_ids") or []]
        messages = unit.get("messages") or []
        if not ids or [int(m.get("source_message_id") or 0) for m in messages] != ids:
            raise RebuildValidationError("rebuild_unit_message_identity_mismatch")
        if unit["kind"] == "album" and not 2 <= len(ids) <= 10:
            raise RebuildValidationError("rebuild_album_size_invalid")
        if unit["kind"] == "message" and len(ids) != 1:
            raise RebuildValidationError("rebuild_single_unit_size_invalid")
        seen_ids.extend(ids)

    if seen_ids != list(range(2, 30)):
        raise RebuildValidationError("rebuild_source_id_sequence_changed")
    return value


def select_pilot_units(manifest, max_units):
    max_units = int(max_units)
    if max_units < 1 or max_units > MAX_PILOT_UNITS:
        raise RebuildValidationError("pilot_max_units_must_be_1_or_2")
    return list(manifest["units"][:max_units])


def utf16_length(value):
    return len(str(value or "").encode("utf-16-le")) // 2


def pilot_preflight(units):
    """Reject fidelity cases not implemented in the first local TEST pilot."""
    for unit in units:
        messages = unit["messages"]
        if unit["kind"] == "album":
            if any(len(message.get("media") or []) != 1 for message in messages):
                raise RebuildValidationError("pilot_album_requires_one_media_per_message")
        for message in messages:
            if message.get("links"):
                raise RebuildValidationError(
                    f"pilot_internal_or_external_links_not_supported:{message['source_message_id']}"
                )
            if message.get("reply_to_source_message_id") is not None:
                raise RebuildValidationError(
                    f"pilot_replies_not_supported:{message['source_message_id']}"
                )
            media = message.get("media") or []
            if len(media) > 1:
                raise RebuildValidationError("pilot_message_has_multiple_media_refs")
            text = str(message.get("text") or "")
            if media and utf16_length(text) > 1024:
                raise RebuildValidationError(
                    f"pilot_media_caption_too_long:{message['source_message_id']}"
                )
            if not media and utf16_length(text) > 4096:
                raise RebuildValidationError(
                    f"pilot_text_too_long:{message['source_message_id']}"
                )
    return True


def _sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while True:
            block = handle.read(8 * 1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def verify_selected_media(units, progress=None):
    rows = []
    for unit in units:
        for message in unit["messages"]:
            for media in message.get("media") or []:
                path = Path(media["local_path"]).resolve()
                if not path.is_file():
                    raise RebuildValidationError(
                        f"verified_backup_media_missing:{message['source_message_id']}:{path.name}"
                    )
                expected_size = int(media.get("size_bytes") or 0)
                actual_size = path.stat().st_size
                if actual_size != expected_size:
                    raise RebuildValidationError(
                        f"verified_backup_media_size_changed:{message['source_message_id']}:{path.name}"
                    )
                actual_hash = _sha256_file(path)
                if actual_hash != str(media.get("sha256") or "").lower():
                    raise RebuildValidationError(
                        f"verified_backup_media_hash_changed:{message['source_message_id']}:{path.name}"
                    )
                row = {
                    "source_message_id": int(message["source_message_id"]),
                    "path": str(path),
                    "size_bytes": actual_size,
                    "sha256": actual_hash,
                }
                rows.append(row)
                if progress:
                    progress(row)
    return rows


def state_path(manifest_sha256, destination_chat_id, root=None):
    if root is None:
        root = Path(os.getenv("LOCALAPPDATA") or Path.home()) / "YeuNauAnReader" / "RebuildState"
    safe_chat = str(destination_chat_id).replace("-", "m")
    path = Path(root) / manifest_sha256 / f"{safe_chat}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def load_state(path):
    path = Path(path)
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RebuildValidationError("rebuild_state_invalid")
    return value


def save_state(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    os.replace(temporary, path)


def new_state(manifest_sha256, destination_chat_id, destination_title):
    return {
        "schema": "tgcloner.rebuild_local_state.v1",
        "manifest_sha256": manifest_sha256,
        "destination_chat_id": str(destination_chat_id),
        "destination_title": str(destination_title),
        "completed_units": [],
        "inflight": None,
    }


def validate_state(value, manifest_sha256, destination_chat_id, destination_title):
    if value is None:
        return new_state(manifest_sha256, destination_chat_id, destination_title)
    if value.get("schema") != "tgcloner.rebuild_local_state.v1":
        raise RebuildValidationError("rebuild_state_schema_invalid")
    if value.get("manifest_sha256") != manifest_sha256:
        raise RebuildValidationError("rebuild_state_manifest_changed")
    if str(value.get("destination_chat_id")) != str(destination_chat_id):
        raise RebuildValidationError("rebuild_state_destination_changed")
    if str(value.get("destination_title")) != str(destination_title):
        raise RebuildValidationError("rebuild_state_destination_title_changed")
    inflight = value.get("inflight")
    if inflight:
        raise RebuildValidationError(
            "rebuild_previous_send_needs_manual_reconcile_before_retry"
        )
    seen = set()
    for row in value.get("completed_units") or []:
        number = int(row.get("unit_number") or 0)
        ids = [int(item) for item in row.get("destination_message_ids") or []]
        if number < 1 or not ids or number in seen:
            raise RebuildValidationError("rebuild_state_completed_unit_invalid")
        seen.add(number)
    return value


def completed_unit_map(state):
    return {
        int(row["unit_number"]): [int(item) for item in row["destination_message_ids"]]
        for row in state.get("completed_units") or []
    }
