"""The copy-only Reader selector must never depend on a new source post."""
import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "reader-cli"))
from existing_text import eligible_existing_text, latest_plain_text


class MessageEntityTextUrl:
    pass


class MessageEntityUrl:
    pass


class MessageEntityBold:
    pass


def message(identifier, text, *, media=None, entities=None):
    return SimpleNamespace(id=identifier, raw_text=text, media=media, entities=entities or [])


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


if __name__ == "__main__":
    unittest.main()
