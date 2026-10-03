#!/usr/bin/env python3
"""Read-only inventory for the isolated 1-to-2 Telegram E2E fixture."""
import argparse
import asyncio
import os
import sys
from pathlib import Path

from telethon import TelegramClient
from telethon.tl.types import InputMessagesFilterPinned

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "reader-cli"))
from course_full import scan_course, validate_snapshot  # noqa: E402
from export_history import resolve_channel  # noqa: E402


def visible(message):
    return not getattr(message, "action", None) and bool(
        str(getattr(message, "raw_text", "") or "").strip()
        or getattr(message, "media", None)
    )


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", action="append", required=True)
    parser.add_argument("--expected-count", type=int, default=0)
    parser.add_argument("--expected-high-watermark", type=int, default=0)
    parser.add_argument("--expected-sha256", default="")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--recover-after-late", action="store_true")
    parser.add_argument("--expected-late-source-id", type=int, default=0)
    args = parser.parse_args()
    if len(args.destination) != 2 or len(set(args.destination + [args.source])) != 3:
        parser.error("One distinct source and exactly two distinct destinations are required")
    if args.recover_after_late and (not args.resume or not args.expected_count
            or not args.expected_high_watermark or not args.expected_sha256
            or args.expected_late_source_id != args.expected_high_watermark + 1):
        parser.error("Recovery requires the immutable baseline inventory and its one late post")
    api_id = int(os.environ.get("TELEGRAM_API_ID", "0") or 0)
    api_hash = os.environ.get("TELEGRAM_API_HASH", "")
    if not api_id or not api_hash:
        parser.error("Local TEST Reader API credentials are required")

    async with TelegramClient("telegram-cloner-e2e-reader", api_id, api_hash) as client:
        source = await resolve_channel(client, args.source)
        messages, pinned_ids, info = await scan_course(client, source)
        if info["pinned"] > 1:
            raise RuntimeError("TEST source has multiple pinned posts; pin parity cannot be verified")
        if args.recover_after_late:
            late = messages[-1]
            baseline = validate_snapshot(messages[:-1], source, pinned_ids)
            if (baseline["count"] != args.expected_count
                    or baseline["high_watermark"] != args.expected_high_watermark
                    or baseline["sha256"] != args.expected_sha256.lower()
                    or info["count"] != args.expected_count + 1
                    or info["high_watermark"] != args.expected_late_source_id
                    or int(late.id) != args.expected_late_source_id
                    or getattr(late, "media", None) or getattr(late, "grouped_id", None)
                    or not str(getattr(late, "raw_text", "") or "").strip()):
                raise RuntimeError("Recovery source differs from baseline plus one plain-text post; no destination write started")
            print(f"E2E_1TO2_RECOVERY_SOURCE_PASS baseline={baseline['count']} "
                  f"H={baseline['high_watermark']} late={late.id} current_sha256={info['sha256']}")
        elif (args.expected_count and info["count"] != args.expected_count
                or args.expected_high_watermark and info["high_watermark"] != args.expected_high_watermark
                or args.expected_sha256 and info["sha256"] != args.expected_sha256.lower()):
            raise RuntimeError("Source inventory drifted; no destination write started")
        print("E2E_1TO2_SOURCE_INVENTORY_READY " + " ".join(
            f"{name}={info[name]}" for name in (
                "count", "high_watermark", "sha256", "albums", "pinned"
            )
        ))

        for chat_id in args.destination:
            entity = await resolve_channel(client, chat_id)
            if args.resume:
                print(f"E2E_1TO2_DESTINATION_ACCESSIBLE {chat_id} resume=true")
                continue
            async for message in client.iter_messages(entity):
                if visible(message):
                    raise RuntimeError(
                        f"Destination {chat_id} contains visible post {message.id}; no copy started"
                    )
            async for message in client.iter_messages(entity, filter=InputMessagesFilterPinned):
                raise RuntimeError(
                    f"Destination {chat_id} still has pinned post {message.id}; no copy started"
                )
            print(f"E2E_1TO2_DESTINATION_EMPTY {chat_id}")
    print("E2E_1TO2_READONLY_PREFLIGHT_PASS")


if __name__ == "__main__":
    asyncio.run(main())
