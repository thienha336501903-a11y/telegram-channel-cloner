#!/usr/bin/env python3
"""Reconcile deleted Telegram messages without uploading the local user session.

The server first returns a database upper-bound message id. This reader then scans
Telegram locally and reports which message ids still exist at or below that bound.
The server may delete only indexed rows inside that frozen range, so newer posts
arriving during the scan are never removed.
"""
import argparse
import asyncio
import os

from telethon import TelegramClient

from export_history import post_json, resolve_channel


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-id", type=int, default=os.getenv("TELEGRAM_API_ID"))
    parser.add_argument("--api-hash", default=os.getenv("TELEGRAM_API_HASH"))
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--cloner-url", required=True)
    parser.add_argument("--ingest-secret", default=os.getenv("READER_INGEST_SECRET"))
    parser.add_argument("--session", default="telegram-cloner-reader")
    args = parser.parse_args()

    if not args.api_id or not args.api_hash or not args.ingest_secret:
        parser.error("api-id, api-hash and ingest-secret are required (flags or env vars)")

    plan_response = post_json(
        args.cloner_url,
        "/api/reader/complete?action=reconcile-plan",
        args.ingest_secret,
        {"source_id": args.source_id},
    )
    plan = plan_response.get("plan") or {}
    upper_bound = int(plan.get("upper_bound_message_id") or 0)
    expected_chat_id = str(plan.get("chat_id") or "").strip()
    if not expected_chat_id:
        raise RuntimeError("Reconcile plan did not return the registered Telegram chat id")

    present_ids = []
    async with TelegramClient(args.session, args.api_id, args.api_hash) as client:
        entity = await resolve_channel(client, args.channel)
        telegram_chat_id = str(-1000000000000 - int(entity.id))
        if telegram_chat_id != expected_chat_id:
            raise RuntimeError("Resolved Telegram channel does not match the registered source")

        if upper_bound > 0:
            async for message in client.iter_messages(entity):
                message_id = int(getattr(message, "id", 0) or 0)
                if message_id <= 0:
                    continue
                if message_id > upper_bound:
                    continue
                present_ids.append(message_id)

    result_response = post_json(
        args.cloner_url,
        "/api/reader/complete?action=reconcile",
        args.ingest_secret,
        {
            "source_id": args.source_id,
            "telegram_chat_id": expected_chat_id,
            "upper_bound_message_id": upper_bound,
            "present_message_ids": present_ids,
        },
    )
    result = result_response.get("result") or {}
    deleted = int(result.get("deleted_count") or 0)
    indexed = int(result.get("indexed_message_count") or 0)
    print(
        f"Reconcile complete for {args.channel}: "
        f"observed {len(set(present_ids))} ids <= {upper_bound}; "
        f"deleted {deleted}; indexed count {indexed}."
    )
    return deleted


if __name__ == "__main__":
    asyncio.run(main())
