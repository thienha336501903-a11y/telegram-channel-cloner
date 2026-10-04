#!/usr/bin/env python3
"""Guarded local TEST uploader for REBUILD_FROM_TELEGRAM_EXPORT.

Source Telegram is never read or written here. Media bytes come only from the
verified local backup paths embedded in the signed rebuild manifest.

Pilot scope is intentionally capped at the first one or two rebuild units.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from telethon import TelegramClient
from telethon.sessions import StringSession

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "reader-manager"))

from reader_manager_storage import load_config  # noqa: E402
from rebuild_export_core import pilot_units, validate_manifest  # noqa: E402


def visible(message) -> bool:
    return not getattr(message, "action", None) and bool(
        str(getattr(message, "raw_text", "") or "").strip()
        or getattr(message, "media", None)
    )


def bot_chat_id(entity) -> str:
    return str(-1000000000000 - int(entity.id))


def state_path(manifest_sha: str, destination_chat: str) -> Path:
    root = Path(os.getenv("LOCALAPPDATA") or Path.home()) / "YeuNauAnReader" / "RebuildState"
    path = root / manifest_sha / f"{destination_chat}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def load_state(path: Path):
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("rebuild_state_invalid")
    return value


def save_state(path: Path, value: dict):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def choose_profile(config: dict, profile_name: str):
    candidates = [
        item for item in config.get("profiles", [])
        if item.get("session")
        and str(item.get("status") or "ready") not in ("revoked", "reauth", "paused")
    ]
    if profile_name:
        matches = [item for item in candidates if str(item.get("display_name") or "") == profile_name]
        if len(matches) != 1:
            raise RuntimeError("rebuild_reader_profile_not_found")
        return matches[0]
    if len(candidates) != 1:
        names = ", ".join(str(item.get("display_name") or item.get("id")) for item in candidates)
        raise RuntimeError(f"rebuild_reader_profile_must_be_explicit available=[{names}]")
    return candidates[0]


async def resolve_destination(client, destination, destination_title):
    if destination:
        entity = await client.get_entity(destination)
        if destination_title and str(getattr(entity, "title", "") or "") != destination_title:
            raise RuntimeError("rebuild_destination_title_mismatch")
        return entity

    matches = []
    async for dialog in client.iter_dialogs():
        entity = getattr(dialog, "entity", None)
        if str(getattr(entity, "title", "") or "") == destination_title:
            matches.append(entity)
    if len(matches) != 1:
        raise RuntimeError(f"rebuild_destination_title_not_unique count={len(matches)}")
    return matches[0]


async def assert_destination_writer(client, entity):
    permissions = await client.get_permissions(entity, "me")
    if not (bool(getattr(permissions, "is_admin", False)) or bool(getattr(permissions, "is_creator", False))):
        raise RuntimeError("rebuild_destination_reader_not_admin")


async def live_visible_ids(client, entity):
    return {
        int(message.id)
        async for message in client.iter_messages(entity)
        if visible(message)
    }


def media_kind(message):
    media = getattr(message, "media", None)
    if media is None:
        return "text"
    name = media.__class__.__name__
    if name == "MessageMediaPhoto":
        return "photo"
    if name == "MessageMediaDocument":
        document = getattr(media, "document", None)
        mime = str(getattr(document, "mime_type", "") or "")
        if mime.startswith("video/"):
            return "video"
        if mime.startswith("audio/"):
            return "audio"
        return "document"
    return "other"


async def verify_unit_messages(client, entity, unit, destination_ids):
    destination_ids = [int(value) for value in destination_ids]
    messages = await client.get_messages(entity, ids=destination_ids)
    resolved = [item for item in messages if item is not None]
    if len(resolved) != len(destination_ids):
        raise RuntimeError(f"rebuild_existing_unit_missing:{unit['unit_number']}")
    by_id = {int(item.id): item for item in resolved}
    ordered = [by_id.get(value) for value in destination_ids]
    if any(item is None for item in ordered):
        raise RuntimeError(f"rebuild_existing_unit_order_missing:{unit['unit_number']}")

    expected = unit["messages"]
    if len(expected) != len(ordered):
        raise RuntimeError(f"rebuild_existing_unit_cardinality_changed:{unit['unit_number']}")

    for source, actual in zip(expected, ordered):
        if str(getattr(actual, "raw_text", "") or "") != str(source.get("text") or ""):
            raise RuntimeError(f"rebuild_existing_text_changed:{unit['unit_number']}")
        if media_kind(actual) != str(source.get("telegram_type") or ""):
            raise RuntimeError(f"rebuild_existing_media_type_changed:{unit['unit_number']}")

    if unit["kind"] == "album":
        grouped = [getattr(item, "grouped_id", None) for item in ordered]
        if not all(grouped) or len(set(grouped)) != 1:
            raise RuntimeError(f"rebuild_existing_album_broken:{unit['unit_number']}")


def unit_files(unit):
    return [
        message["media"][0]["local_path"]
        for message in unit["messages"]
        if message.get("media")
    ]


async def send_unit(client, entity, unit):
    messages = unit["messages"]
    if unit["kind"] == "album":
        files = unit_files(unit)
        captions = [str(item.get("text") or "") for item in messages]
        if len(files) != len(messages):
            raise RuntimeError(f"rebuild_album_contains_text_only_member:{unit['unit_number']}")
        sent = await client.send_file(
            entity,
            files,
            caption=captions,
            force_document=False,
            supports_streaming=True,
        )
        result = list(sent) if isinstance(sent, (list, tuple)) else [sent]
    else:
        message = messages[0]
        media = message.get("media") or []
        text = str(message.get("text") or "")
        if media:
            sent = await client.send_file(
                entity,
                media[0]["local_path"],
                caption=text,
                force_document=False,
                supports_streaming=True,
            )
        else:
            sent = await client.send_message(entity, text)
        result = [sent]

    if len(result) != len(messages) or any(not getattr(item, "id", None) for item in result):
        raise RuntimeError(f"rebuild_send_result_invalid:{unit['unit_number']}")
    return [int(item.id) for item in result]


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--profile-name", default="")
    parser.add_argument("--destination", default="")
    parser.add_argument("--destination-title", required=True)
    parser.add_argument("--max-units", type=int, default=1)
    parser.add_argument("--start-unit", type=int, default=1)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    print("REBUILD_BACKUP_VERIFY_BEGIN")
    summary = validate_manifest(manifest, verify_media_bytes=True)
    selected = pilot_units(manifest, args.max_units, args.start_unit)
    print(
        f"REBUILD_BACKUP_VERIFY_PASS manifest={summary['manifest_sha256']} "
        f"units={summary['unit_count']} media={summary['media_count']}"
    )

    config = load_config()
    profile = choose_profile(config, args.profile_name)

    async with TelegramClient(
        StringSession(profile["session"]),
        int(profile["api_id"]),
        profile["api_hash"],
    ) as client:
        entity = await resolve_destination(client, args.destination, args.destination_title)
        destination_chat = bot_chat_id(entity)
        if destination_chat == summary["source_chat_id"]:
            raise RuntimeError("rebuild_destination_must_not_be_source")
        if str(getattr(entity, "title", "") or "") != args.destination_title:
            raise RuntimeError("rebuild_destination_identity_changed")

        await assert_destination_writer(client, entity)

        state_file = state_path(summary["manifest_sha256"], destination_chat)
        state = load_state(state_file)
        if state:
            if (
                state.get("schema") != "tgcloner.rebuild_export.pilot_state.v1"
                or state.get("manifest_sha256") != summary["manifest_sha256"]
                or state.get("destination_chat_id") != destination_chat
                or state.get("destination_title") != args.destination_title
                or state.get("reader_profile_id") != profile.get("id")
            ):
                raise RuntimeError("rebuild_state_identity_mismatch")
        else:
            state = {
                "schema": "tgcloner.rebuild_export.pilot_state.v1",
                "manifest_sha256": summary["manifest_sha256"],
                "destination_chat_id": destination_chat,
                "destination_title": args.destination_title,
                "reader_profile_id": profile.get("id"),
                "units": {},
            }

        live_ids = await live_visible_ids(client, entity)
        known_ids = {
            int(message_id)
            for row in state.get("units", {}).values()
            if row.get("phase") == "published"
            for message_id in row.get("destination_message_ids", [])
        }
        if live_ids != known_ids:
            if not state.get("units") and live_ids:
                raise RuntimeError(f"rebuild_destination_not_empty visible={sorted(live_ids)}")
            raise RuntimeError(
                f"rebuild_destination_drift visible={sorted(live_ids)} expected={sorted(known_ids)}"
            )

        print(
            f"REBUILD_TEST_DESTINATION_PASS chat={destination_chat} "
            f"title={args.destination_title} existing_visible={len(live_ids)}"
        )
        print(
            f"REBUILD_READER_ADMIN_PASS profile={profile.get('display_name')} "
            f"destination={destination_chat}"
        )

        if not args.publish:
            for unit in selected:
                ids = ",".join(str(x) for x in unit["source_message_ids"])
                print(
                    f"REBUILD_PILOT_UNIT_READY unit={unit['unit_number']} "
                    f"kind={unit['kind']} source_ids={ids}"
                )
            print("REBUILD_PILOT_PREFLIGHT_PASS no_telegram_write=true")
            return

        for unit in selected:
            key = str(unit["unit_number"])
            existing = state["units"].get(key)
            if existing:
                if existing.get("phase") == "armed":
                    raise RuntimeError(
                        f"rebuild_previous_send_ambiguous unit={unit['unit_number']} "
                        "inspect destination before any retry"
                    )
                if existing.get("phase") != "published":
                    raise RuntimeError(f"rebuild_unknown_unit_state:{unit['unit_number']}")
                await verify_unit_messages(
                    client, entity, unit, existing.get("destination_message_ids") or []
                )
                print(
                    f"REBUILD_PILOT_UNIT_PASS unit={unit['unit_number']} "
                    f"destination_ids={','.join(map(str, existing['destination_message_ids']))} "
                    "existing=true"
                )
                continue

            state["units"][key] = {
                "phase": "armed",
                "source_message_ids": unit["source_message_ids"],
            }
            save_state(state_file, state)

            destination_ids = await send_unit(client, entity, unit)

            state["units"][key] = {
                "phase": "published",
                "source_message_ids": unit["source_message_ids"],
                "destination_message_ids": destination_ids,
            }
            save_state(state_file, state)

            await verify_unit_messages(client, entity, unit, destination_ids)
            print(
                f"REBUILD_PILOT_UNIT_PASS unit={unit['unit_number']} "
                f"destination_ids={','.join(map(str, destination_ids))} existing=false"
            )

        final_live = await live_visible_ids(client, entity)
        expected_final = {
            int(message_id)
            for row in state["units"].values()
            if row.get("phase") == "published"
            for message_id in row.get("destination_message_ids", [])
        }
        if final_live != expected_final:
            raise RuntimeError("rebuild_final_destination_drift")

        print(
            f"REBUILD_PILOT_PUBLISH_PASS destination={destination_chat} "
            f"published_units={len(state['units'])} visible={len(final_live)}"
        )


if __name__ == "__main__":
    asyncio.run(main())
