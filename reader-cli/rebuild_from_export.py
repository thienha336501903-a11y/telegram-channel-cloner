#!/usr/bin/env python3
"""TEST-only local uploader for a verified Telegram HTML export rebuild manifest.

Source Telegram is never accessed. Media bytes come only from verified local backup.
The first pilot is intentionally capped at two rebuild units.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "reader-manager"))
sys.path.insert(0, str(ROOT / "reader-cli"))

from reader_manager_storage import load_config
from export_history import resolve_channel
from rebuild_export_core import (
    RebuildValidationError,
    completed_unit_map,
    load_manifest,
    load_state,
    pilot_preflight,
    save_state,
    select_pilot_units,
    state_path,
    validate_state,
    verify_selected_media,
)
from telethon import TelegramClient
from telethon.sessions import StringSession


def norm(value):
    return unicodedata.normalize("NFC", str(value or "")).strip().casefold()


def visible(message):
    return bool(
        message
        and not getattr(message, "action", None)
        and (
            str(getattr(message, "raw_text", "") or "").strip()
            or getattr(message, "media", None)
        )
    )


async def resolve_destination(client, reference, title):
    if reference:
        entity = await resolve_channel(client, reference)
        if title and norm(getattr(entity, "title", "")) != norm(title):
            raise RebuildValidationError("destination_title_confirmation_mismatch")
        return entity

    matches = []
    async for dialog in client.iter_dialogs():
        entity = getattr(dialog, "entity", None)
        if norm(getattr(entity, "title", "")) == norm(title):
            matches.append(entity)
    if len(matches) != 1:
        raise RebuildValidationError(
            "destination_title_must_match_exactly_one_reader_dialog"
        )
    return matches[0]


def writer_allowed(entity):
    if not getattr(entity, "broadcast", False):
        return False
    if getattr(entity, "creator", False):
        return True
    rights = getattr(entity, "admin_rights", None)
    return bool(rights and getattr(rights, "post_messages", False))


async def live_visible_ids(client, entity):
    values = []
    async for message in client.iter_messages(entity):
        if visible(message):
            values.append(int(message.id))
    return sorted(values)


async def verify_message_ids(client, entity, message_ids):
    messages = await client.get_messages(entity, ids=message_ids)
    if not isinstance(messages, (list, tuple)):
        messages = [messages]
    actual = sorted(int(m.id) for m in messages if visible(m))
    expected = sorted(int(item) for item in message_ids)
    if actual != expected:
        raise RebuildValidationError(
            f"destination_completed_messages_changed:expected={expected}:actual={actual}"
        )


class UploadProgress:
    def __init__(self, unit_number):
        self.unit_number = unit_number
        self.last_at = 0.0
        self.last_percent = -1

    def __call__(self, current, total):
        now = time.monotonic()
        percent = int((current * 100) / total) if total else 0
        if percent == 100 or percent >= self.last_percent + 10 or now - self.last_at >= 5:
            print(
                f"REBUILD_UPLOAD_PROGRESS unit={self.unit_number:02d} "
                f"percent={percent} bytes={int(current)}/{int(total or 0)}",
                flush=True,
            )
            self.last_percent = percent
            self.last_at = now


async def send_unit(client, entity, unit):
    number = int(unit["unit_number"])
    messages = unit["messages"]
    progress = UploadProgress(number)

    if unit["kind"] == "album":
        files = [message["media"][0]["local_path"] for message in messages]
        captions = [str(message.get("text") or "") for message in messages]
        sent = await client.send_file(
            entity,
            files,
            caption=captions,
            supports_streaming=True,
            progress_callback=progress,
        )
        if not isinstance(sent, (list, tuple)):
            sent = [sent]
        if len(sent) != len(messages):
            raise RebuildValidationError(
                f"telegram_album_result_count_mismatch:{number}"
            )
        return [int(item.id) for item in sent]

    message = messages[0]
    media = message.get("media") or []
    text = str(message.get("text") or "")
    if media:
        sent = await client.send_file(
            entity,
            media[0]["local_path"],
            caption=text or None,
            supports_streaming=message.get("telegram_type") == "video",
            progress_callback=progress,
        )
    else:
        sent = await client.send_message(entity, text, link_preview=False)
    return [int(sent.id)]


async def run_for_profile(profile, args, manifest, units):
    async with TelegramClient(
        StringSession(profile["session"]),
        int(profile["api_id"]),
        profile["api_hash"],
    ) as client:
        try:
            entity = await resolve_destination(
                client, args.destination, args.destination_title
            )
        except Exception:
            return False

        destination_title = str(getattr(entity, "title", "") or "")
        destination_chat_id = str(-1000000000000 - int(entity.id))
        if destination_chat_id == str(manifest["source"]["chat_id"]):
            raise RebuildValidationError("destination_must_not_be_protected_source")
        if not writer_allowed(entity):
            return False

        state_file = state_path(manifest["manifest_sha256"], destination_chat_id)
        state = validate_state(
            load_state(state_file),
            manifest["manifest_sha256"],
            destination_chat_id,
            destination_title,
        )
        completed = completed_unit_map(state)

        live_ids = await live_visible_ids(client, entity)
        completed_ids = sorted(
            message_id for ids in completed.values() for message_id in ids
        )
        if live_ids != completed_ids:
            raise RebuildValidationError(
                f"test_destination_not_ledger_clean:live={live_ids}:ledger={completed_ids}"
            )
        for ids in completed.values():
            await verify_message_ids(client, entity, ids)

        print(f"REBUILD_TEST_READER profile={profile.get('display_name') or profile.get('id')}")
        print(f"REBUILD_TEST_DESTINATION title={destination_title} chat_id={destination_chat_id}")
        print(f"REBUILD_TEST_DESTINATION_CLEAN visible={len(live_ids)} ledger_owned={len(completed_ids)}")
        print(f"REBUILD_TEST_STATE {state_file}")

        if not args.publish:
            print("REBUILD_TEST_DRY_RUN_PASS no_telegram_write=true")
            return True

        for unit in units:
            number = int(unit["unit_number"])
            if number in completed:
                ids = completed[number]
                await verify_message_ids(client, entity, ids)
                print(
                    f"REBUILD_TEST_UNIT_PASS unit={number:02d} "
                    f"destination_message_ids={','.join(map(str, ids))} existing=true"
                )
                continue

            state["inflight"] = {
                "unit_number": number,
                "source_message_ids": unit["source_message_ids"],
                "phase": "armed",
            }
            save_state(state_file, state)
            try:
                destination_ids = await send_unit(client, entity, unit)
                state["inflight"] = {
                    "unit_number": number,
                    "source_message_ids": unit["source_message_ids"],
                    "phase": "sent_unverified",
                    "destination_message_ids": destination_ids,
                }
                save_state(state_file, state)
                await verify_message_ids(client, entity, destination_ids)
            except Exception:
                # Fail closed. The persisted inflight record intentionally blocks
                # a blind retry if Telegram may have accepted the send.
                raise

            state.setdefault("completed_units", []).append({
                "unit_number": number,
                "source_message_ids": unit["source_message_ids"],
                "destination_message_ids": destination_ids,
            })
            state["inflight"] = None
            save_state(state_file, state)
            print(
                f"REBUILD_TEST_UNIT_PASS unit={number:02d} "
                f"destination_message_ids={','.join(map(str, destination_ids))} existing=false"
            )

        print(
            f"REBUILD_TEST_PUBLISH_PASS units={len(units)} "
            f"manifest={manifest['manifest_sha256']}"
        )
        return True


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--destination", default="")
    parser.add_argument("--destination-title", required=True)
    parser.add_argument("--max-units", type=int, default=2)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()

    manifest = load_manifest(args.manifest)
    units = select_pilot_units(manifest, args.max_units)
    pilot_preflight(units)

    def media_progress(row):
        print(
            f"REBUILD_MEDIA_VERIFIED source={row['source_message_id']} "
            f"bytes={row['size_bytes']} file={Path(row['path']).name}"
        )

    media_rows = verify_selected_media(units, progress=media_progress)
    print(
        f"REBUILD_TEST_PLAN manifest={manifest['manifest_sha256']} "
        f"units={len(units)} media={len(media_rows)} publish={str(args.publish).lower()}"
    )
    for unit in units:
        print(
            f"REBUILD_TEST_UNIT_READY unit={int(unit['unit_number']):02d} "
            f"kind={unit['kind']} source_ids={','.join(map(str, unit['source_message_ids']))}"
        )

    config = load_config()
    profiles = [
        profile for profile in config.get("profiles", [])
        if profile.get("session")
        and profile.get("api_id")
        and profile.get("api_hash")
        and str(profile.get("status") or "ready") not in ("revoked", "reauth", "paused")
    ]
    if not profiles:
        raise RebuildValidationError("no_ready_reader_profile")

    for profile in profiles:
        if await run_for_profile(profile, args, manifest, units):
            return
    raise RebuildValidationError(
        "no_reader_profile_has_test_destination_admin_write_access"
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except RebuildValidationError as exc:
        print(f"REBUILD_TEST_BLOCKED reason={exc}", file=sys.stderr)
        raise SystemExit(2)
