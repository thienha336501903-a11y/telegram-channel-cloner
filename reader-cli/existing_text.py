"""Read one safe existing text post for the isolated copy-only E2E check."""
import re


def eligible_existing_text(message):
    raw = str(getattr(message, "raw_text", "") or "")
    if not raw.strip() or getattr(message, "media", None):
        return False
    if re.search(r"(?:https?://|www\.|t\.me/|telegram\.me/|tg://)", raw, re.IGNORECASE):
        return False
    return not any(
        entity.__class__.__name__ in ("MessageEntityUrl", "MessageEntityTextUrl")
        for entity in (getattr(message, "entities", None) or [])
    )


async def latest_plain_text(client, entity):
    async for message in client.iter_messages(entity):
        if eligible_existing_text(message):
            yield message
            return
    raise RuntimeError("No existing plain-text post without media or links is accessible in the source")


def eligible_existing_post(message):
    """Accept a message that Bot API copyMessage can plausibly copy as one unit."""
    if not getattr(message, "id", None) or getattr(message, "action", None):
        return False
    raw = str(getattr(message, "raw_text", "") or "")
    media = getattr(message, "media", None)
    media_name = media.__class__.__name__ if media else ""
    return bool(
        (raw.strip() and media_name in ("", "MessageMediaWebPage"))
        or media_name in ("MessageMediaPhoto", "MessageMediaDocument")
    )


async def latest_copyable_post(client, entity):
    async for message in client.iter_messages(entity):
        if eligible_existing_post(message):
            yield message
            return
    raise RuntimeError("No existing text, photo, video or document post is accessible in the source")
