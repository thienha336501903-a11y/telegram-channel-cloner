"""The copy-only Reader selector must never depend on a new source post."""
import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "reader-cli"))
from existing_text import eligible_existing_post, eligible_existing_text, latest_copyable_post, latest_plain_text, oldest_course_prefix, recent_limited_copyable_posts


class MessageEntityTextUrl:
    def __init__(self, url=None):
        self.url = url


class MessageEntityUrl:
    pass


class MessageEntityBold:
    pass


class MessageMediaPhoto:
    pass


class MessageMediaDocument:
    pass


def message(identifier, text, *, media=None, entities=None, action=None, grouped_id=None, noforwards=False):
    return SimpleNamespace(id=identifier, raw_text=text, media=media, entities=entities or [], action=action, grouped_id=grouped_id, noforwards=noforwards)


class FakeReader:
    def __init__(self, messages):
        self.messages = messages
        self.visited = []

    async def iter_messages(self, entity, reverse=False):
        for item in reversed(self.messages) if reverse else self.messages:
            self.visited.append(item.id)
            yield item


async def collect(reader):
    return [item async for item in latest_plain_text(reader, "source")]


async def collect_copyable(reader):
    return [item async for item in latest_copyable_post(reader, "source")]


async def collect_limited(reader, limit=4, excluded_ids=(56,)):
    return [item async for item in recent_limited_copyable_posts(reader, "source", limit=limit, excluded_ids=excluded_ids)]


async def collect_prefix(reader, limit=5, entity="source"):
    return [item async for item in oldest_course_prefix(reader, entity, limit=limit)]


class ExistingTextTests(unittest.TestCase):
    def test_only_old_plain_text_without_links_is_selected(self):
        reader = FakeReader([
            message(9, "photo", media=object()),
            message(8, "hidden", entities=[MessageEntityTextUrl()]),
            message(7, "https://t.me/example/4"),
            message(6, "visible", entities=[MessageEntityUrl()]),
            message(5, "Bài chữ đã đăng", entities=[MessageEntityBold()]),
            message(4, "older text"),
        ])
        self.assertEqual([item.id for item in asyncio.run(collect(reader))], [5])
        self.assertEqual(reader.visited, [9, 8, 7, 6, 5])

    def test_no_eligible_post_fails_without_fabricating_one(self):
        reader = FakeReader([message(2, "", media=object()), message(1, "t.me/example/1")])
        with self.assertRaisesRegex(RuntimeError, "No existing plain-text post"):
            asyncio.run(collect(reader))

    def test_empty_text_is_not_eligible(self):
        self.assertFalse(eligible_existing_text(message(3, "  ")))

    def test_copyable_post_selects_existing_media_without_posting(self):
        reader = FakeReader([
            message(12, "channel setup", action=object()),
            message(11, "", media=MessageMediaPhoto()),
            message(10, "caption", media=MessageMediaDocument()),
        ])
        self.assertEqual([item.id for item in asyncio.run(collect_copyable(reader))], [11])
        self.assertEqual(reader.visited, [12, 11])

    def test_copyable_post_accepts_links_in_existing_text(self):
        reader = FakeReader([message(4, "https://t.me/example/3", entities=[MessageEntityUrl()])])
        self.assertEqual([item.id for item in asyncio.run(collect_copyable(reader))], [4])
        self.assertTrue(eligible_existing_post(reader.messages[0]))

    def test_copyable_post_rejects_service_and_unsupported_media(self):
        reader = FakeReader([message(2, "service", action=object()), message(1, "", media=object())])
        with self.assertRaisesRegex(RuntimeError, "No existing text, photo, video or document"):
            asyncio.run(collect_copyable(reader))

    def test_limited_copy_skips_previous_post_album_and_links(self):
        reader = FakeReader([
            message(56, "", media=MessageMediaPhoto()),
            message(55, "photo", media=MessageMediaPhoto()),
            message(54, "album", media=MessageMediaPhoto(), grouped_id=991),
            message(53, "protected", media=MessageMediaPhoto(), noforwards=True),
            message(52, "video", media=MessageMediaDocument()),
            message(51, "https://t.me/c/123/20"),
            message(50, "caption link", media=MessageMediaPhoto(), entities=[MessageEntityTextUrl()]),
            message(49, "old text"),
            message(48, "another photo", media=MessageMediaPhoto()),
            message(47, "beyond limit"),
        ])
        self.assertEqual([item.id for item in asyncio.run(collect_limited(reader))], [55, 52, 49, 48])
        self.assertEqual(reader.visited, [56, 55, 54, 53, 52, 51, 50, 49, 48])

    def test_limited_copy_fails_without_any_other_standalone_post(self):
        reader = FakeReader([message(56, "", media=MessageMediaPhoto()), message(55, "album", media=MessageMediaPhoto(), grouped_id=991)])
        with self.assertRaisesRegex(RuntimeError, "No standalone post"):
            asyncio.run(collect_limited(reader))

    def test_limited_copy_rejects_more_than_four(self):
        with self.assertRaisesRegex(ValueError, "1 to 4"):
            asyncio.run(collect_limited(FakeReader([]), limit=5))

    def test_course_prefix_uses_earliest_five_visible_posts_without_gaps(self):
        reader = FakeReader([
            message(56, "newer"), message(55, "new"), message(6, "lesson 5"),
            message(5, "lesson 4", media=MessageMediaPhoto(), grouped_id=991),
            message(4, "lesson 3", media=MessageMediaPhoto(), grouped_id=991),
            message(3, "lesson 2"), message(2, "lesson 1"), message(1, "", action=object()),
        ])
        self.assertEqual([item.id for item in asyncio.run(collect_prefix(reader))], [2, 3, 4, 5, 6])
        self.assertEqual(reader.visited, [1, 2, 3, 4, 5, 6, 55])

    def test_course_prefix_keeps_link_for_preflight_and_rewrite(self):
        reader = FakeReader([message(9, "later"), message(4, "later"), message(3, "link", entities=[MessageEntityTextUrl()]), message(2, "first")])
        self.assertEqual([item.id for item in asyncio.run(collect_prefix(reader, limit=4))], [2, 3, 4, 9])

    def test_course_prefix_blocks_protected_post_before_copy(self):
        reader = FakeReader([message(4, "later"), message(3, "protected", noforwards=True), message(2, "first")])
        with self.assertRaisesRegex(RuntimeError, "source_message_id=3 reason=protected_post"):
            asyncio.run(collect_prefix(reader))

    def test_course_prefix_stops_before_partial_album_or_split_limit(self):
        reader = FakeReader([message(7, "later"), message(5, "album", media=MessageMediaPhoto(), grouped_id=991), message(4, "before")])
        self.assertEqual([item.id for item in asyncio.run(collect_prefix(reader))], [4])
        reader = FakeReader([
            message(7, "later"), message(5, "album-other", media=MessageMediaPhoto(), grouped_id=992),
            message(4, "album-first", media=MessageMediaPhoto(), grouped_id=991),
            message(3, "video2", media=MessageMediaDocument()), message(2, "video1", media=MessageMediaDocument()),
        ])
        self.assertEqual([item.id for item in asyncio.run(collect_prefix(reader))], [2, 3])
        reader = FakeReader([
            message(7, "album3", media=MessageMediaPhoto(), grouped_id=991),
            message(6, "album2", media=MessageMediaPhoto(), grouped_id=991),
            message(5, "album1", media=MessageMediaPhoto(), grouped_id=991),
            message(4, "lesson4"), message(3, "lesson3"), message(2, "lesson2"), message(1, "lesson1")
        ])
        self.assertEqual([item.id for item in asyncio.run(collect_prefix(reader))], [1, 2, 3, 4])

    def test_course_prefix_stops_before_link_to_sixth_post_without_skipping(self):
        source = SimpleNamespace(id=3535777660, username=None)
        reader = FakeReader([
            message(8, "later"),
            message(7, "caption", media=MessageMediaPhoto(), entities=[MessageEntityTextUrl("https://t.me/c/3535777660/8")]),
            message(5, "album2", media=MessageMediaDocument(), grouped_id=991),
            message(4, "album1", media=MessageMediaDocument(), grouped_id=991),
            message(3, "video2", media=MessageMediaDocument()),
            message(2, "video1", media=MessageMediaDocument()),
        ])
        self.assertEqual([item.id for item in asyncio.run(collect_prefix(reader, entity=source))], [2, 3, 4, 5])

    def test_course_prefix_rechecks_earlier_links_after_truncation(self):
        source = SimpleNamespace(id=3535777660, username=None)
        reader = FakeReader([
            message(8, "later"),
            message(7, "link to later", entities=[MessageEntityTextUrl("https://t.me/c/3535777660/8")]),
            message(5, "album2", media=MessageMediaDocument(), grouped_id=991),
            message(4, "album1", media=MessageMediaDocument(), grouped_id=991),
            message(3, "video2", media=MessageMediaDocument()),
            message(2, "link to fifth", entities=[MessageEntityTextUrl("https://t.me/c/3535777660/7")]),
        ])
        with self.assertRaisesRegex(RuntimeError, "No safe chronological course prefix"):
            asyncio.run(collect_prefix(reader, entity=source))

    def test_course_prefix_keeps_internal_link_to_included_post_and_external_link(self):
        source = SimpleNamespace(id=3535777660, username=None)
        reader = FakeReader([
            message(7, "caption https://example.com/help", media=MessageMediaPhoto(), entities=[MessageEntityTextUrl("https://t.me/c/3535777660/2")]),
            message(5, "album2", media=MessageMediaDocument(), grouped_id=991),
            message(4, "album1", media=MessageMediaDocument(), grouped_id=991),
            message(3, "video2", media=MessageMediaDocument()),
            message(2, "video1", media=MessageMediaDocument()),
        ])
        self.assertEqual([item.id for item in asyncio.run(collect_prefix(reader, entity=source))], [2, 3, 4, 5, 7])

    def test_course_prefix_allows_fewer_than_five_and_rejects_six(self):
        reader = FakeReader([message(2, "second"), message(1, "first")])
        self.assertEqual([item.id for item in asyncio.run(collect_prefix(reader))], [1, 2])
        with self.assertRaisesRegex(ValueError, "1 to 5"):
            asyncio.run(collect_prefix(reader, limit=6))


if __name__ == "__main__":
    unittest.main()
