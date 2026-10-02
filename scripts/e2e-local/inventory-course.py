#!/usr/bin/env python3
"""Inventory a whole source channel through the existing TEST Reader session."""
import argparse
import asyncio
import os
import sys
from pathlib import Path

from telethon import TelegramClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "reader-cli"))
from course_full import scan_course  # noqa: E402
from export_history import resolve_channel  # noqa: E402


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-count", type=int, default=0)
    parser.add_argument("--expected-high-watermark", type=int, default=0)
    parser.add_argument("--expected-sha256", default="")
    args = parser.parse_args()
    api_id = int(os.environ.get("TELEGRAM_API_ID", "0") or 0)
    api_hash = os.environ.get("TELEGRAM_API_HASH", "")
    if not api_id or not api_hash:
        parser.error("TEST Reader API credentials are required")
    async with TelegramClient("telegram-cloner-e2e-reader", api_id, api_hash) as client:
        source = await resolve_channel(client, args.source)
        _, _, info = await scan_course(client, source)
    if (args.expected_count and info["count"] != args.expected_count
            or args.expected_high_watermark and info["high_watermark"] != args.expected_high_watermark
            or args.expected_sha256 and info["sha256"] != args.expected_sha256.lower()):
        raise RuntimeError("Source history changed since the approved inventory; no Telegram copy was started")
    print("E2E_FULL_COURSE_INVENTORY_READY " + " ".join(
        f"{name}={info[name]}" for name in (
            "count", "high_watermark", "sha256", "albums", "pinned", "appendix_candidates", "external_telegram_links"
        )
    ))


if __name__ == "__main__":
    asyncio.run(main())
