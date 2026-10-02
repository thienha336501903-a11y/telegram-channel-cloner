"""The copy-only Reader selector must never depend on a new source post."""
import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "reader-cli"))
from existing_text import eligible_existing_post, eligible_existing_text, latest_copyable_post, latest_plain_text


class MessageEntityTextUrl:
    pass


class MessageEntityUrl:
    pass


class MessageEntityBold:
    pass


class MessageMediaPhoto:
    pass


class MessageMediaDocument:
    pass


def message(identifier, text, *, media=None, entities=None, action=None):
    return SimpleNamespace(id=identifier, raw_text=text, media=media, entities=entities or [], action=action)


class FakeReader:
    def __init__(self, messages):
        self.messages = messages
        self.visited = []

    async def iter_messages(self, entity):
        for item in self.messages:
            self.visited.append(item.id)
            yield item


async def collect(reader):
    return [item async for item in latest_plain_text(reader, "source")]


async def collect_copyable(reader):
    return [item async for item in latest_copyable_post(reader, "source")]


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


if __name__ == "__main__":
    unittest.main()
