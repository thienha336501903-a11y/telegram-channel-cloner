#!/usr/bin/env python3
"""One-time/local Telegram history reader.

Runs on the owner's computer, signs in as a dedicated Telegram user account, reads one
registered channel history, and uploads only normalized message metadata/text to the
Cloner API. Registering/importing a source must not change the clone/mirror MASTER.
The session file stays local and must never be committed.
"""
import argparse
import asyncio
import json
import os
import re
import sys
from datetime import timezone

import requests
from telethon import TelegramClient
from telethon.sessions import StringSession
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


def size_bytes(item):
    if item is None:
        return 0
    direct = int(getattr(item, "size", 0) or 0)
    if direct > 0:
        return direct
    progressive = [int(value or 0) for value in (getattr(item, "sizes", None) or [])]
    return max(progressive) if progressive else 0


def largest_size(items):
    candidates = []
    for item in items or []:
        item_type = str(getattr(item, "type", "") or "")
        if not item_type:
            continue
        width = int(getattr(item, "w", 0) or 0)
        height = int(getattr(item, "h", 0) or 0)
        byte_size = size_bytes(item)
        candidates.append((width * height, byte_size, item))
    if not candidates:
        return None
    candidates.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
    return candidates[0][2]


def document_file_name(document, message_type):
    for attribute in getattr(document, "attributes", None) or []:
        file_name = str(getattr(attribute, "file_name", "") or "").strip()
        if file_name:
            return file_name
    mime = str(getattr(document, "mime_type", "") or "").lower()
    if mime == "video/mp4":
        return "telegram-video.mp4"
    if message_type == "video":
        return "telegram-video"
    if message_type == "audio":
        return "telegram-audio"
    return "telegram-document"


def mtproto_size_metadata(item):
    if item is None:
        return None
    return {
        "file_id": "",
        "file_size": size_bytes(item),
        "width": int(getattr(item, "w", 0) or 0),
        "height": int(getattr(item, "h", 0) or 0),
        "type": str(getattr(item, "type", "") or ""),
        "mtproto": True,
    }


def reader_raw_message(message, message_type):
    """Return non-secret historical media descriptors safe to upload to Cloner.

    These fields intentionally contain no Telegram user session/API hash/OTP data and
    no Bot API file_id. The server resolves the actual media later by source chat id
    plus source message id using its own bot MTProto session.
    """
    raw_message = {"from_reader": True}
    media = getattr(message, "media", None)

    if message_type == "photo":
        photo = getattr(media, "photo", None) or getattr(message, "photo", None)
        chosen = largest_size(getattr(photo, "sizes", None) or [])
        descriptor = mtproto_size_metadata(chosen)
        if descriptor:
            raw_message["photo"] = [descriptor]
        return raw_message

    document = getattr(media, "document", None) or getattr(message, "document", None)
    if document is None or message_type not in ("video", "audio", "document"):
        return raw_message

    item = {
        "file_id": "",
        "file_size": int(getattr(document, "size", 0) or 0),
        "mime_type": str(getattr(document, "mime_type", "") or "application/octet-stream"),
        "file_name": document_file_name(document, message_type),
        "mtproto": True,
    }
    thumbnail = mtproto_size_metadata(largest_size(getattr(document, "thumbs", None) or []))
    if thumbnail:
        item["thumbnail"] = thumbnail
    raw_message[message_type] = item
    return raw_message


def private_channel_id(value):
    """Return the MTProto channel id from a Bot API -100 id or t.me/c link."""
    raw = str(value or "").strip()
    if re.fullmatch(r"-100\d+", raw):
        return -1000000000000 - int(raw)
    match = re.search(r"(?:https?://)?t\.me/c/(\d+)(?:/\d+)?", raw, re.IGNORECASE)
    if match:
        return int(match.group(1))
    return None


async def resolve_channel(client, channel):
    """Resolve public inputs directly and private ids by scanning dialogs safely."""
    try:
        return await client.get_entity(channel)
    except Exception as direct_error:
        wanted_id = private_channel_id(channel)
        if wanted_id is None:
            raise

        async for dialog in client.iter_dialogs():
            entity = getattr(dialog, "entity", None)
            entity_id = getattr(entity, "id", None)
            if entity_id is not None and int(entity_id) == int(wanted_id):
                return entity

        raise ValueError(
            "Cannot resolve the private channel from this Telegram account. "
            "Make sure the reader account is a member of the channel, then retry."
        ) from direct_error


def post_json(base_url, path, secret, payload):
    r = requests.post(base_url.rstrip("/") + path, headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), timeout=60)
    if not r.ok: raise RuntimeError(f"{path}: HTTP {r.status_code}: {r.text[:500]}")
    return r.json()


def local_session(value):
    """Use an encrypted-at-rest StringSession supplied only by Reader Manager."""
    session_string = os.getenv("TELEGRAM_SESSION_STRING", "").strip()
    return StringSession(session_string) if session_string else value


def write_progress(path, current, total=None):
    if not path:
        return
    payload = {"current": int(current)}
    if isinstance(total, int) and total >= 0:
        payload["total"] = total
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--api-id", type=int, default=os.getenv("TELEGRAM_API_ID"))
    p.add_argument("--api-hash", default=os.getenv("TELEGRAM_API_HASH"))
    p.add_argument("--channel", required=True, help="@username, t.me link, t.me/c link, or numeric channel id")
    p.add_argument("--cloner-url", required=True, help="Public HTTPS origin of this clone's Cloner service")
    p.add_argument("--ingest-secret", default=os.getenv("READER_INGEST_SECRET"))
    p.add_argument("--session", default="telegram-cloner-reader")
    p.add_argument("--progress-file", help=argparse.SUPPRESS)
    p.add_argument("--latest-plain-text-only", action="store_true", help="Index one existing text post without links; do not publish to source")
    p.add_argument("--latest-copyable-only", action="store_true", help="Local E2E only: index one old text or media post for Bot API copy")
    p.add_argument("--recent-safe-copy-limit", type=int, default=0, help="Local E2E only: index up to four standalone old posts without links")
    p.add_argument("--course-prefix-limit", type=int, default=0, help="Local E2E only: index the first one to five visible posts in source order, or fail before import")
    p.add_argument("--local-full-copy-only", action="store_true", help="Local E2E only: import every visible post for Bot API copy; never hydrate source media")
    p.add_argument("--expected-count", type=int, default=0)
    p.add_argument("--expected-high-watermark", type=int, default=0)
    p.add_argument("--expected-sha256", default="")
    p.add_argument("--exclude-source-id", type=int, default=0, help="Exclude the source post already copied in a prior local E2E run")
    # Keep each serverless request comfortably below the runtime deadline even
    # when a future/legacy message still requires Bot API hydration.
    p.add_argument("--batch-size", type=int, default=20)
    args = p.parse_args()
    if not args.api_id or not args.api_hash or not args.ingest_secret: p.error("api-id, api-hash and ingest-secret are required (flags or env vars)")
    if sum(bool(value) for value in (args.latest_plain_text_only, args.latest_copyable_only, args.recent_safe_copy_limit, args.course_prefix_limit, args.local_full_copy_only)) > 1:
        p.error("Choose only one existing-post selection mode")
    if (args.latest_copyable_only or args.recent_safe_copy_limit or args.course_prefix_limit) and args.cloner_url.rstrip("/") != "http://127.0.0.1:8787":
        p.error("Copy-only selection is restricted to the isolated local E2E server")
    if args.local_full_copy_only and args.cloner_url.rstrip("/") != "http://127.0.0.1:8787":
        p.error("Full copy-only import is restricted to the isolated local E2E server")
    if args.local_full_copy_only and (args.expected_count < 5 or args.expected_high_watermark < 7 or len(args.expected_sha256) != 64):
        p.error("Full local copy requires the exact count, high watermark and SHA256 from read-only inventory")
    if args.recent_safe_copy_limit and not 1 <= args.recent_safe_copy_limit <= 4:
        p.error("--recent-safe-copy-limit must be between 1 and 4")
    if args.exclude_source_id < 0 or (args.exclude_source_id and not args.recent_safe_copy_limit):
        p.error("--exclude-source-id requires --recent-safe-copy-limit and a positive message ID")
    if args.course_prefix_limit and not 1 <= args.course_prefix_limit <= 5:
        p.error("--course-prefix-limit must be between 1 and 5")
    one_post_only = args.latest_plain_text_only or args.latest_copyable_only or bool(args.recent_safe_copy_limit or args.course_prefix_limit)

    async with TelegramClient(local_session(args.session), args.api_id, args.api_hash) as client:
        entity = await resolve_channel(client, args.channel)
        bot_chat_id = -1000000000000 - int(entity.id)
        username = getattr(entity, "username", None); title = getattr(entity, "title", None); private_link_id = str(entity.id)
        registered = post_json(args.cloner_url, "/api/reader/register-source", args.ingest_secret, {"chat_id": str(bot_chat_id), "title": title, "username": username, "private_link_id": private_link_id})
        source_id = registered["source"]["id"]
        history_summary = None if one_post_only or args.local_full_copy_only else await client.get_messages(entity, limit=0)
        history_total = (args.recent_safe_copy_limit or args.course_prefix_limit or 1) if one_post_only else args.expected_count if args.local_full_copy_only else max(0, int(getattr(history_summary, "total", 0) or 0))
        write_progress(args.progress_file, 0, history_total)
        role = "MASTER mirror" if registered.get("mirror_master") else "nguồn V4 không MASTER"
        print(f"Source: {title} ({source_id}) · {role}")
        pinned_ids = set()
        full_messages = None
        if args.local_full_copy_only:
            from course_full import scan_course
            full_messages, pinned_ids, inventory = await scan_course(client, entity)
            if (inventory["count"] != args.expected_count or inventory["high_watermark"] != args.expected_high_watermark
                    or inventory["sha256"] != args.expected_sha256.lower()):
                raise RuntimeError("Course inventory changed before import; no Telegram post was copied")
            print(f"E2E_FULL_COURSE_IMPORT_PREFLIGHT count={inventory['count']} H={inventory['high_watermark']}")
        elif not one_post_only:
            try:
                from telethon.tl.types import InputMessagesFilterPinned
                async for msg in client.iter_messages(entity, filter=InputMessagesFilterPinned): pinned_ids.add(int(msg.id))
            except Exception as e: print(f"Warning: could not enumerate pinned messages: {e}", file=sys.stderr)

        if one_post_only:
            from existing_text import latest_copyable_post, latest_plain_text, oldest_course_prefix, recent_limited_copyable_posts
            if args.course_prefix_limit:
                messages = oldest_course_prefix(client, entity, limit=args.course_prefix_limit)
            elif args.recent_safe_copy_limit:
                excluded_ids = (args.exclude_source_id,) if args.exclude_source_id else ()
                messages = recent_limited_copyable_posts(client, entity, limit=args.recent_safe_copy_limit, excluded_ids=excluded_ids)
            else:
                messages = latest_copyable_post(client, entity) if args.latest_copyable_only else latest_plain_text(client, entity)
        elif args.local_full_copy_only:
            async def selected_full_messages():
                for message in full_messages:
                    yield message
            messages = selected_full_messages()
        else:
            messages = client.iter_messages(entity, reverse=True)

        batch = []; count = 0
        async for msg in messages:
            if not getattr(msg, "id", None): continue
            raw = msg.raw_text or ""
            # Telegram link previews are text posts, not editable photo/video
            # captions. The full TEST copy must rewrite links with editMessageText.
            has_media = bool(msg.media) and not (args.local_full_copy_only and msg.media.__class__.__name__ == "MessageMediaWebPage")
            # Telegram channel history includes service messages such as the
            # channel-created event. They have no user-visible text or media
            # and must not become empty V4 lesson items or inflate index counts.
            if not raw and not has_media: continue
            text = raw if not has_media else None; caption = raw if has_media and raw else None
            entities = [x for x in (entity_to_bot_api(e) for e in (msg.entities or [])) if x]
            message_type = "text" if args.local_full_copy_only and not has_media else classify(msg)
            # The isolated copy-only run needs an ID/type for Bot API copyMessage,
            # not a Reader media descriptor. Never ask ingestion to self-forward
            # a historical media post into the live source to hydrate metadata.
            local_copy_raw = {"e2e_copy_only": True}
            item = {"source_message_id": int(msg.id), "media_group_id": str(msg.grouped_id) if msg.grouped_id else None, "message_type": message_type, "text": text, "text_entities": entities if text is not None else [], "caption": caption, "caption_entities": entities if caption is not None else [], "reply_to_source_message_id": int(msg.reply_to_msg_id) if msg.reply_to_msg_id else None, "is_pinned": int(msg.id) in pinned_ids, "source_date": msg.date.astimezone(timezone.utc).isoformat() if msg.date else None, "raw_message": local_copy_raw if (args.latest_copyable_only or args.recent_safe_copy_limit or args.course_prefix_limit or args.local_full_copy_only) else reader_raw_message(msg, message_type)}
            if args.latest_plain_text_only:
                print(f"E2E_EXISTING_TEXT_SELECTED source_message_id={item['source_message_id']}")
            elif args.latest_copyable_only:
                print(f"E2E_EXISTING_POST_SELECTED source_message_id={item['source_message_id']} type={message_type}")
            elif args.recent_safe_copy_limit:
                print(f"E2E_LIMITED_POST_SELECTED source_message_id={item['source_message_id']} type={message_type}")
            elif args.course_prefix_limit:
                print(f"E2E_COURSE_POST_SELECTED source_message_id={item['source_message_id']} type={message_type}")
            batch.append(item); count += 1
            if len(batch) >= args.batch_size:
                result = post_json(args.cloner_url, "/api/reader/ingest", args.ingest_secret, {"source_id": source_id, "messages": batch})
                write_progress(args.progress_file, count, history_total)
                print(f"Indexed {count} messages; links found in batch: {result.get('internal_links', 0)}"); batch = []
        if batch:
            post_json(args.cloner_url, "/api/reader/ingest", args.ingest_secret, {"source_id": source_id, "messages": batch})
            write_progress(args.progress_file, count, count)
        if args.local_full_copy_only and count != args.expected_count:
            raise RuntimeError("Full course import count changed; no Telegram copy was started")
        post_json(args.cloner_url, "/api/reader/complete", args.ingest_secret, {"source_id": source_id, "message_count": count})
        print(f"Done. Indexed {count} messages. MASTER mirror role was not changed.")


if __name__ == "__main__": asyncio.run(main())
