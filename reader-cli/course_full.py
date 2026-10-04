"""Read-only snapshot of every visible course post for local TEST copying."""
import hashlib
import json

from existing_text import course_link_targets, course_prefix_blocker
from export_history import classify, entity_to_bot_api


def signature(message):
    media = getattr(message, "media", None)
    document = getattr(media, "document", None) or getattr(message, "document", None)
    photo = getattr(media, "photo", None) or getattr(message, "photo", None)
    return {
        "id": int(message.id),
        "type": classify(message),
        "album": str(getattr(message, "grouped_id", None) or ""),
        "text": str(getattr(message, "raw_text", "") or ""),
        "entities": [entity_to_bot_api(item) for item in (getattr(message, "entities", None) or [])],
        "media": media.__class__.__name__ if media else "",
        "document_id": str(getattr(document, "id", "") or ""),
        "photo_id": str(getattr(photo, "id", "") or ""),
        "date": message.date.isoformat() if getattr(message, "date", None) else "",
    }


def validate_snapshot(messages, source, pinned_ids):
    """Reject gaps, incomplete albums and internal links to missing source posts."""
    if not messages or len(messages) > 100000:
        raise RuntimeError("Full course requires 1..100000 visible posts")
    ids = [int(item.id) for item in messages]
    if ids != sorted(set(ids)):
        raise RuntimeError("Source messages are not in unique ascending order")
    id_set = set(ids)
    groups = {}
    unresolved = []
    external_telegram = 0
    appendix_candidates = 0
    for position, message in enumerate(messages):
        reason = course_prefix_blocker(message)
        if reason:
            raise RuntimeError(f"Source post {message.id} blocks full copy: {reason}")
        if getattr(message, "grouped_id", None):
            groups.setdefault(str(message.grouped_id), []).append(position)
        for target in course_link_targets(message, source):
            if target.startswith("source_post:") and int(target.partition(":")[2]) not in id_set:
                unresolved.append(int(message.id))
            elif target.startswith(("unverified_", "unrewritable_")):
                external_telegram += 1
        if "phụ lục" in str(getattr(message, "raw_text", "") or "").lower():
            appendix_candidates += 1
    if unresolved:
        raise RuntimeError(f"Internal links point outside visible history in source posts {sorted(set(unresolved))[:20]}")
    for positions in groups.values():
        if not 2 <= len(positions) <= 10 or positions != list(range(positions[0], positions[-1] + 1)):
            raise RuntimeError(f"Incomplete or oversized album starting at source post {ids[positions[0]]}")
    if not set(pinned_ids).issubset(id_set):
        raise RuntimeError("Pinned source post is not in the visible course history")
    digest = hashlib.sha256()
    for message in messages:
        digest.update(json.dumps(signature(message), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        digest.update(b"\n")
    digest.update(json.dumps(sorted(pinned_ids)).encode("ascii"))
    return {
        "count": len(ids), "high_watermark": ids[-1], "sha256": digest.hexdigest(),
        "ids": ids, "albums": len(groups), "pinned": len(pinned_ids),
        "external_telegram_links": external_telegram, "appendix_candidates": appendix_candidates,
    }


async def scan_course(client, source):
    from telethon.tl.types import InputMessagesFilterPinned

    messages = []
    async for message in client.iter_messages(source, reverse=True):
        if getattr(message, "action", None):
            continue
        if str(getattr(message, "raw_text", "") or "").strip() or getattr(message, "media", None):
            messages.append(message)
            if len(messages) > 100000:
                raise RuntimeError("Full course exceeds 100000 posts")
    pinned_ids = set()
    async for message in client.iter_messages(source, filter=InputMessagesFilterPinned):
        pinned_ids.add(int(message.id))
    return messages, pinned_ids, validate_snapshot(messages, source, pinned_ids)
