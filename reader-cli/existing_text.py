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
