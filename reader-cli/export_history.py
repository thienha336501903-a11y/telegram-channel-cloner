#!/usr/bin/env python3
"""One-time/local Telegram history reader.

Runs on the owner's computer, signs in as a dedicated Telegram account, reads the MASTER
channel history, and uploads only normalized message metadata/text to the Cloner API.
The session file stays local and must never be committed.
"""
import argparse
import asyncio
import json
import os
import sys
from datetime import timezone

import requests
from telethon import TelegramClient
from telethon.tl.types import MessageEntityTextUrl, MessageEntityUrl


def entity_to_bot_api(entity):
    base = {"offset": int(entity.offset), "length": int(entity.length)}
    name = entity.__class__.__name__
    mapping = {
        "MessageEntityBold": "bold", "MessageEntityItalic": "italic", "MessageEntityUnderline": "underline",
        "MessageEntityStrike": "strikethrough", "MessageEntityCode": "code", "MessageEntityPre": "pre",
        "MessageEntityTextUrl": "text_link", "MessageEntityUrl": "url", "MessageEntityMention": "mention",
        "MessageEntityHashtag": "hashtag", "MessageEntityCashtag": "cashtag", "MessageEntityBotCommand": "bot_command",
        "MessageEntityEmail": "email", "MessageEntityPhone": "phone_number", "MessageEntitySpoiler": "spoiler",
        "MessageEntityBlockquote": "blockquote",
    }
    bot_type = mapping.get(name)
    if not bot_type:
        return None
    base["type"] = bot_type
    if isinstance(entity, MessageEntityTextUrl): base["url"] = entity.url
    if name == "MessageEntityPre" and getattr(entity, "language", None): base["language"] = entity.language
    return base


def classify(message):
    if message.raw_text and not message.media: return "text"
    media = message.media
    if not media: return "other"
    name = media.__class__.__name__.lower()
    if "photo" in name: return "photo"
    if "document" in name:
        doc = getattr(media, "document", None); mime = getattr(doc, "mime_type", "") or ""
        if mime.startswith("video/"): return "video"
        if mime.startswith("audio/"): return "audio"
        return "document"
    return "other"


def post_json(base_url, path, secret, payload):
    r = requests.post(base_url.rstrip("/") + path, headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), timeout=60)
    if not r.ok: raise RuntimeError(f"{path}: HTTP {r.status_code}: {r.text[:500]}")
    return r.json()


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--api-id", type=int, default=os.getenv("TELEGRAM_API_ID"))
    p.add_argument("--api-hash", default=os.getenv("TELEGRAM_API_HASH"))
    p.add_argument("--channel", required=True, help="@username, t.me link, or numeric channel id")
    p.add_argument("--cloner-url", required=True, help="https://telegram-channel-cloner.vercel.app")
    p.add_argument("--ingest-secret", default=os.getenv("READER_INGEST_SECRET"))
    p.add_argument("--session", default="telegram-cloner-reader")
    p.add_argument("--batch-size", type=int, default=50)
    args = p.parse_args()
    if not args.api_id or not args.api_hash or not args.ingest_secret: p.error("api-id, api-hash and ingest-secret are required (flags or env vars)")

    async with TelegramClient(args.session, args.api_id, args.api_hash) as client:
        entity = await client.get_entity(args.channel)
        bot_chat_id = -1000000000000 - int(entity.id)
        username = getattr(entity, "username", None); title = getattr(entity, "title", None); private_link_id = str(entity.id)
        registered = post_json(args.cloner_url, "/api/reader/register-source", args.ingest_secret, {"chat_id": str(bot_chat_id), "title": title, "username": username, "private_link_id": private_link_id})
        source_id = registered["source"]["id"]
        print(f"Source: {title} ({source_id})")
        pinned_ids = set()
        try:
            from telethon.tl.types import InputMessagesFilterPinned
            async for msg in client.iter_messages(entity, filter=InputMessagesFilterPinned): pinned_ids.add(int(msg.id))
        except Exception as e: print(f"Warning: could not enumerate pinned messages: {e}", file=sys.stderr)

        batch = []; count = 0
        async for msg in client.iter_messages(entity, reverse=True):
            if not getattr(msg, "id", None): continue
            raw = msg.raw_text or ""; has_media = bool(msg.media); text = raw if not has_media else None; caption = raw if has_media and raw else None
            entities = [x for x in (entity_to_bot_api(e) for e in (msg.entities or [])) if x]
            item = {"source_message_id": int(msg.id), "media_group_id": str(msg.grouped_id) if msg.grouped_id else None, "message_type": classify(msg), "text": text, "text_entities": entities if text is not None else [], "caption": caption, "caption_entities": entities if caption is not None else [], "reply_to_source_message_id": int(msg.reply_to_msg_id) if msg.reply_to_msg_id else None, "is_pinned": int(msg.id) in pinned_ids, "source_date": msg.date.astimezone(timezone.utc).isoformat() if msg.date else None, "raw_message": {"from_reader": True}}
            batch.append(item); count += 1
            if len(batch) >= args.batch_size:
                result = post_json(args.cloner_url, "/api/reader/ingest", args.ingest_secret, {"source_id": source_id, "messages": batch})
                print(f"Indexed {count} messages; links found in batch: {result.get('internal_links', 0)}"); batch = []
        if batch: post_json(args.cloner_url, "/api/reader/ingest", args.ingest_secret, {"source_id": source_id, "messages": batch})
        post_json(args.cloner_url, "/api/reader/complete", args.ingest_secret, {"source_id": source_id, "message_count": count})
        print(f"Done. Indexed {count} messages.")


if __name__ == "__main__": asyncio.run(main())
