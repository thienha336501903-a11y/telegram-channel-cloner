#!/usr/bin/env python3
"""Read-only local Telegram inventory before a five-post chronological E2E run."""
import argparse
import asyncio
import os
import sys
from pathlib import Path

from telethon import TelegramClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "reader-cli"))
from existing_text import course_link_targets, course_prefix_blocker, oldest_course_prefix  # noqa: E402
from export_history import classify, resolve_channel  # noqa: E402


def visible(message):
    return not getattr(message, "action", None) and bool(
        str(getattr(message, "raw_text", "") or "").strip() or getattr(message, "media", None)
    )


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.limit <= 5 or args.source == args.destination:
        parser.error("Use distinct source/destination channels and a limit from 1 to 5")
    api_id = int(os.environ.get("TELEGRAM_API_ID", "0") or 0)
    api_hash = os.environ.get("TELEGRAM_API_HASH", "")
    if not api_id or not api_hash:
        parser.error("Local Telegram API credentials are required")

    async with TelegramClient("telegram-cloner-e2e-reader", api_id, api_hash) as client:
        source = await resolve_channel(client, args.source)
        print(f"E2E_COURSE_SOURCE title={getattr(source, 'title', '')!r} first_visible_limit={args.limit}")
        count = 0
        blockers = []
        async for message in client.iter_messages(source, reverse=True):
            if not visible(message):
                continue
            count += 1
            reason = course_prefix_blocker(message)
            if reason:
                blockers.append(f"{message.id}:{reason}")
            print(f"E2E_COURSE_SOURCE_POST position={count} id={message.id} type={classify(message)} album={bool(message.grouped_id)} links={','.join(course_link_targets(message, source)) or 'none'} blocker={reason or 'none'}")
            if count >= args.limit:
                break
        if not count:
            blockers.append("source_empty")

        if args.require_ready:
            try:
                selected = [message async for message in oldest_course_prefix(client, source, limit=args.limit)]
                print(f"E2E_COURSE_PLAN count={len(selected)} source_ids={','.join(str(message.id) for message in selected)}")
            except RuntimeError as exc:
                blockers.append(str(exc))
        try:
            destination = await resolve_channel(client, args.destination)
        except ValueError:
            print("E2E_COURSE_READER_DESTINATION_UNAVAILABLE; use TEST bot and local mapping verification")
        else:
            dest_ids = []
            async for message in client.iter_messages(destination):
                if visible(message):
                    dest_ids.append(int(message.id))
                if len(dest_ids) >= 20:
                    break
            print(f"E2E_COURSE_DESTINATION_RECENT_VISIBLE_IDS {','.join(map(str, dest_ids)) or 'none'}")
        if args.require_ready and blockers:
            raise RuntimeError(
                f"Course copy preflight blocked: source={','.join(blockers)}. "
                "No source or destination message was changed."
            )
        print("E2E_COURSE_READONLY_INSPECTION_PASS" if not args.require_ready else "E2E_COURSE_PREFLIGHT_READY")


if __name__ == "__main__":
    asyncio.run(main())
