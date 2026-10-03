#!/usr/bin/env python3
"""Read-only Telegram and local DB reconciliation before a 1-to-2 resume."""
import asyncio
import os

from telethon import TelegramClient

from verify_telegram import resolve_channel, rest, rest_all


async def main():
    source_chat = os.environ["E2E_SOURCE_CHAT_ID"]
    destinations = os.environ["E2E_DESTINATION_CHAT_IDS"].split(",")
    if source_chat != "-1004320185488" or sorted(destinations) != [
            "-1003933578709", "-1004492904064"]:
        raise RuntimeError("Isolated 1to2 resume identity mismatch")
    sources = rest("tgcloner_sources", f"select=id&chat_id=eq.{source_chat}&limit=1")
    if len(sources) != 1:
        raise RuntimeError("Source missing from isolated DB")
    source_id = sources[0]["id"]
    source_rows = rest_all("tgcloner_source_messages",
                       f"select=source_message_id&source_id=eq.{source_id}")
    source_ids = {int(row["source_message_id"]) for row in source_rows}

    async with TelegramClient("telegram-cloner-e2e-reader",
                              int(os.environ["TELEGRAM_API_ID"]),
                              os.environ["TELEGRAM_API_HASH"]) as client:
        for chat_id in destinations:
            destination_rows = rest("tgcloner_destinations",
                                    f"select=id,source_id&chat_id=eq.{chat_id}&limit=1")
            if len(destination_rows) != 1 or destination_rows[0]["source_id"] != source_id:
                raise RuntimeError(f"Isolated destination identity mismatch: {chat_id}")
            destination_id = destination_rows[0]["id"]
            runs = rest("tgcloner_clone_runs",
                        f"select=id,status,manifest_closed_at&destination_id=eq.{destination_id}")
            if len(runs) != 1 or runs[0]["status"] != "active" or not runs[0]["manifest_closed_at"]:
                raise RuntimeError(f"Isolated run is not safely resumable: {chat_id}")
            run_id = runs[0]["id"]
            unsafe = rest_all("tgcloner_clone_work",
                          f"select=id,status,side_effect_state&run_id=eq.{run_id}"
                          "&status=in.(blocked_ambiguous,blocked_dependency,failed,leased,retry_wait,queued)")
            if any(row["status"] in ("blocked_ambiguous", "blocked_dependency", "failed", "leased")
                   or row["side_effect_state"] != "not_started" for row in unsafe):
                raise RuntimeError(f"Unreconciled work may have Telegram side effects: {chat_id}")
            mappings = rest_all("tgcloner_message_mappings",
                            f"select=source_message_id,destination_message_id,status"
                            f"&destination_id=eq.{destination_id}")
            if any(row["status"] != "copied" or
                   int(row["source_message_id"]) not in source_ids or
                   not int(row["destination_message_id"] or 0) for row in mappings):
                raise RuntimeError(f"Incomplete or foreign mapping in isolated DB: {chat_id}")
            mappings.sort(key=lambda row: int(row["source_message_id"]))
            ids = [int(row["destination_message_id"]) for row in mappings]
            if ids != sorted(set(ids)):
                raise RuntimeError(f"Destination message order or uniqueness mismatch: {chat_id}")
            entity = await resolve_channel(client, chat_id)
            if ids:
                messages = await client.get_messages(entity, ids=ids)
                if not isinstance(messages, list):
                    messages = [messages]
                if {int(message.id) for message in messages if message is not None} != set(ids):
                    raise RuntimeError(f"Mapped Telegram messages were deleted: {chat_id}")
            print(f"E2E_1TO2_RESUME_READBACK_PASS destination={chat_id} mapped={len(ids)}")
    print("E2E_1TO2_RESUME_PREFLIGHT_PASS")


if __name__ == "__main__":
    asyncio.run(main())
