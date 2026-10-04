#!/usr/bin/env python3
"""Read-only Telegram and local DB reconciliation before a 1-to-2 resume."""
import asyncio
import os

from telethon import TelegramClient
from telethon.tl.types import InputMessagesFilterPinned

from verify_telegram import resolve_channel, rest, rest_all


async def main():
    source_chat = os.environ["E2E_SOURCE_CHAT_ID"]
    destinations = os.environ["E2E_DESTINATION_CHAT_IDS"].split(",")
    if source_chat != "-1004320185488" or sorted(destinations) != [
            "-1003933578709", "-1004492904064"]:
        raise RuntimeError("Isolated 1to2 resume identity mismatch")
    sources = rest("tgcloner_sources", f"select=id,active&chat_id=eq.{source_chat}&limit=1")
    if len(sources) != 1 or sources[0]["active"] is not False:
        raise RuntimeError("Source missing from isolated DB")
    source_id = sources[0]["id"]
    recover_after_late = os.environ.get("E2E_RECOVER_TWO_AFTER_LATE", "").lower() == "true"
    continue_one = os.environ.get("E2E_CONTINUE_TWO_ONE_POST", "").lower() == "true"
    baseline_h = int(os.environ.get("E2E_EXPECTED_HIGH_WATERMARK", "0"))
    expected_count = int(os.environ.get("E2E_EXPECTED_HISTORY_COUNT", "0"))
    late_id = 61 if continue_one else int(os.environ.get("E2E_EXPECTED_LATE_SOURCE_ID", "0"))
    source_rows = rest_all("tgcloner_source_messages",
                       f"select=source_message_id,message_type,media_group_id&source_id=eq.{source_id}")
    source_ids = {int(row["source_message_id"]) for row in source_rows}
    baseline_ids = {message_id for message_id in source_ids if message_id <= baseline_h}
    if recover_after_late or continue_one:
        late = [row for row in source_rows if int(row["source_message_id"]) == late_id]
        events = rest_all("tgcloner_source_events",
                          f"select=id,origin,event_kind,source_message_id&source_id=eq.{source_id}")
        if (len(baseline_ids) != expected_count
                or max(baseline_ids, default=0) != baseline_h
                or (continue_one and (expected_count != 60 or baseline_h != 61 or late_id != 61))
                or source_ids != baseline_ids | {late_id} or len(late) != 1
                or late[0]["message_type"] != "text" or late[0]["media_group_id"]
                or len(events) != 1 or events[0]["origin"] != "bot_webhook"
                or events[0]["event_kind"] != "message_new"
                or int(events[0]["source_message_id"] or 0) != late_id):
            raise RuntimeError("Isolated source ledger is not the baseline plus one webhook-captured text post")

    async with TelegramClient("telegram-cloner-e2e-reader",
                              int(os.environ["TELEGRAM_API_ID"]),
                              os.environ["TELEGRAM_API_HASH"]) as client:
        for chat_id in destinations:
            destination_rows = rest("tgcloner_destinations",
                                    f"select=id,source_id,active&chat_id=eq.{chat_id}&limit=1")
            if (len(destination_rows) != 1 or destination_rows[0]["source_id"] != source_id
                    or destination_rows[0]["active"] is not False):
                raise RuntimeError(f"Isolated destination identity mismatch: {chat_id}")
            destination_id = destination_rows[0]["id"]
            runs = rest("tgcloner_clone_runs",
                        f"select=id,status,phase,snapshot_high_watermark,manifest_closed_at,last_verified_at&destination_id=eq.{destination_id}")
            if len(runs) != 1 or runs[0]["status"] != "active" or not runs[0]["manifest_closed_at"]:
                raise RuntimeError(f"Isolated run is not safely resumable: {chat_id}")
            if recover_after_late or continue_one:
                valid_phases = (("ready_for_new",) if continue_one else
                                ("catching_up", "rewriting", "verifying", "ready_for_new"))
                if (int(runs[0]["snapshot_high_watermark"] or 0) != 60
                        or runs[0]["phase"] not in valid_phases
                        or continue_one and not runs[0]["last_verified_at"]):
                    raise RuntimeError(f"Retained TEST run has changed: {chat_id}")
            run_id = runs[0]["id"]
            if recover_after_late or continue_one:
                manifest = rest_all("tgcloner_clone_manifest",
                                    f"select=source_message_id&run_id=eq.{run_id}")
                manifest_ids = {int(row["source_message_id"]) for row in manifest}
                expected_manifest_ids = {message_id for message_id in source_ids if message_id <= 60}
                if (manifest_ids != expected_manifest_ids or len(manifest) != 59):
                    raise RuntimeError(f"Closed baseline manifest changed: {chat_id}")
            unsafe = rest_all("tgcloner_clone_work",
                          f"select=id,phase,status,side_effect_state&run_id=eq.{run_id}"
                          "&status=in.(blocked_ambiguous,blocked_dependency,failed,leased,retry_wait,queued)")
            if any(row["status"] in ("blocked_ambiguous", "blocked_dependency", "failed", "leased")
                   or row["side_effect_state"] not in ("not_started", "not_applicable")
                   or (row["side_effect_state"] == "not_applicable" and row["phase"] != "verify")
                   for row in unsafe):
                raise RuntimeError(f"Unreconciled work may have Telegram side effects: {chat_id}")
            if continue_one and unsafe:
                raise RuntimeError(f"TEST run has pending work before the new post: {chat_id}")
            mappings = rest_all("tgcloner_message_mappings",
                            f"select=source_message_id,destination_message_id,status"
                            f"&destination_id=eq.{destination_id}")
            if any(row["status"] != "copied" or
                   int(row["source_message_id"]) not in source_ids or
                   not int(row["destination_message_id"] or 0) for row in mappings):
                raise RuntimeError(f"Incomplete or foreign mapping in isolated DB: {chat_id}")
            if recover_after_late or continue_one:
                mapped_source_ids = {int(row["source_message_id"]) for row in mappings}
                if (len(mappings) != len(mapped_source_ids)
                        or (continue_one and mapped_source_ids != source_ids)
                        or (recover_after_late and mapped_source_ids not in (baseline_ids, source_ids))):
                    raise RuntimeError(f"Baseline mappings incomplete or duplicated: {chat_id}")
            mappings.sort(key=lambda row: int(row["source_message_id"]))
            ids = [int(row["destination_message_id"]) for row in mappings]
            if ids != sorted(set(ids)):
                raise RuntimeError(f"Destination message order or uniqueness mismatch: {chat_id}")
            entity = await resolve_channel(client, chat_id)
            if recover_after_late or continue_one:
                pinned = [message.id async for message in client.iter_messages(
                    entity, filter=InputMessagesFilterPinned)]
                if pinned:
                    raise RuntimeError(f"Unexpected TEST destination pin before recovery: {chat_id}")
            if ids:
                messages = await client.get_messages(entity, ids=ids)
                if not isinstance(messages, list):
                    messages = [messages]
                if {int(message.id) for message in messages if message is not None} != set(ids):
                    raise RuntimeError(f"Mapped Telegram messages were deleted: {chat_id}")
            if recover_after_late or continue_one:
                visible_ids = set()
                async for message in client.iter_messages(entity):
                    if not getattr(message, "action", None) and (
                            str(getattr(message, "raw_text", "") or "").strip()
                            or getattr(message, "media", None)):
                        visible_ids.add(int(message.id))
                if visible_ids != set(ids):
                    raise RuntimeError(f"Unmapped or missing visible Telegram post: {chat_id}")
            print(f"E2E_1TO2_RESUME_READBACK_PASS destination={chat_id} mapped={len(ids)}")
    print("E2E_1TO2_RESUME_PREFLIGHT_PASS")


if __name__ == "__main__":
    asyncio.run(main())
