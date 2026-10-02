"""Read one safe existing text post for the isolated copy-only E2E check."""
import re
from urllib.parse import urlparse


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


def eligible_limited_copy(message, excluded_ids=()):
    """Avoid album fragments and links that would still point at the source."""
    if not eligible_existing_post(message) or int(message.id) in excluded_ids or getattr(message, "noforwards", False):
        return False
    if getattr(message, "grouped_id", None):
        return False
    raw = str(getattr(message, "raw_text", "") or "")
    if re.search(r"(?:https?://|www\.|t\.me/|telegram\.me/|tg://)", raw, re.IGNORECASE):
        return False
    return not any(
        item.__class__.__name__ in ("MessageEntityUrl", "MessageEntityTextUrl")
        for item in (getattr(message, "entities", None) or [])
    )


def course_prefix_blocker(message):
    if not eligible_existing_post(message):
        return "unsupported_post_type"
    if getattr(message, "noforwards", False):
        return "protected_post"
    return None


def course_link_targets(message, source):
    """Classify links without printing lesson text or invitation tokens."""
    raw = str(getattr(message, "raw_text", "") or "")
    urls = re.findall(r"(?:https?://)?(?:t\.me|telegram\.me)/[^\s<>]+|https?://[^\s<>]+|tg://[^\s<>]+", raw, flags=re.IGNORECASE)
    urls += [str(item.url) for item in (getattr(message, "entities", None) or []) if getattr(item, "url", None)]
    outcomes = set()
    for raw_url in urls:
        clean_url = raw_url.rstrip(".,;!)]}")
        if clean_url.lower().startswith("tg://") or not clean_url.lower().startswith(("http://", "https://")):
            outcomes.add("unrewritable_telegram_link")
            continue
        url = urlparse(clean_url)
        if (url.hostname or "").lower() not in ("t.me", "www.t.me", "telegram.me", "www.telegram.me"):
            outcomes.add("external")
            continue
        parts = url.path.strip("/").split("/")
        source_id = str(getattr(source, "id", "") or "")
        username = str(getattr(source, "username", "") or "").lower()
        if len(parts) >= 3 and parts[0].lower() == "c" and parts[1] == source_id and parts[2].isdigit():
            outcomes.add(f"source_post:{parts[2]}")
        elif len(parts) >= 2 and username and parts[0].lower() == username and parts[1].isdigit():
            outcomes.add(f"source_post:{parts[1]}")
        else:
            outcomes.add("unverified_telegram_link")
    return sorted(outcomes)


async def recent_limited_copyable_posts(client, entity, *, limit, excluded_ids=()):
    if not 1 <= limit <= 4:
        raise ValueError("Limited copy accepts 1 to 4 new posts")
    excluded = set(int(value) for value in excluded_ids)
    selected = 0
    async for message in client.iter_messages(entity):
        if not eligible_limited_copy(message, excluded):
            continue
        yield message
        selected += 1
        if selected == limit:
            return
    if selected == 0:
        raise RuntimeError("No standalone post without links is accessible after the excluded source post")


async def oldest_course_prefix(client, entity, *, limit):
    """Preflight the first visible lessons before yielding any for local E2E import.

    A skipped lesson changes the curriculum. Reject an unsupported member of the
    chronological prefix instead of silently selecting a later, unrelated post.
    """
    if not 1 <= limit <= 5:
        raise ValueError("Course prefix accepts 1 to 5 posts")
    selected = []
    next_after_limit = None
    async for message in client.iter_messages(entity, reverse=True):
        if getattr(message, "action", None):
            continue
        if not str(getattr(message, "raw_text", "") or "").strip() and not getattr(message, "media", None):
            continue
        identifier = int(getattr(message, "id", 0) or 0)
        if len(selected) == limit:
            next_after_limit = message
            break
        reason = course_prefix_blocker(message)
        if reason:
            raise RuntimeError(f"Course prefix blocked at source_message_id={identifier} reason={reason}; no posts were copied")
        selected.append(message)
    if not selected:
        raise RuntimeError("No visible course posts are accessible in the source")
    if next_after_limit is not None and getattr(selected[-1], "grouped_id", None) and selected[-1].grouped_id == getattr(next_after_limit, "grouped_id", None):
        group_start = next(position for position, message in enumerate(selected) if getattr(message, "grouped_id", None) == selected[-1].grouped_id)
        print(f"E2E_COURSE_PREFIX_STOP_BEFORE source_message_id={selected[group_start].id} reason=album_exceeds_limit")
        selected = selected[:group_start]
    while selected:
        previous_count = len(selected)
        selected_ids = {int(message.id) for message in selected}
        for position, message in enumerate(selected):
            links = course_link_targets(message, entity)
            if any(link.startswith(("unverified_", "unrewritable_")) or (link.startswith("source_post:") and int(link.partition(":")[2]) not in selected_ids) for link in links):
                print(f"E2E_COURSE_PREFIX_STOP_BEFORE source_message_id={message.id} reason=unsafe_or_out_of_scope_link")
                selected = selected[:position]
                break
        groups = {}
        for position, message in enumerate(selected):
            if getattr(message, "grouped_id", None):
                groups.setdefault(message.grouped_id, []).append(position)
        broken = [positions[0] for positions in groups.values() if len(positions) < 2 or positions != list(range(positions[0], positions[-1] + 1))]
        if broken:
            print(f"E2E_COURSE_PREFIX_STOP_BEFORE source_message_id={selected[min(broken)].id} reason=incomplete_album")
            selected = selected[:min(broken)]
        if len(selected) == previous_count:
            break
    if not selected:
        raise RuntimeError("No safe chronological course prefix is accessible within the configured limit")
    print(f"E2E_COURSE_PREFIX_SELECTED count={len(selected)} max={limit} ids={','.join(str(message.id) for message in selected)}")
    for message in selected:
        yield message
