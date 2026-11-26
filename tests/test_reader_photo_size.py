"""The Reader must send a photo descriptor with a real byte size, so the server never hydrates the post
through the source channel just because the largest size had no byte count (PhotoCachedSize/stripped)."""
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

# export_history imports telethon/requests at module level; this test only needs the pure helpers.
for name in ("requests", "telethon", "telethon.sessions", "telethon.tl", "telethon.tl.types"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["telethon"].TelegramClient = object
sys.modules["telethon.sessions"].StringSession = object
sys.modules["telethon.tl.types"].MessageEntityTextUrl = type("MessageEntityTextUrl", (), {})
sys.modules["telethon.tl.types"].MessageEntityUrl = type("MessageEntityUrl", (), {})

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "reader-cli"))
from export_history import largest_size, reader_raw_message  # noqa: E402


def size(type_, w, h, n=None, sizes=None):
    item = SimpleNamespace(type=type_, w=w, h=h)
    if n is not None:
        item.size = n
    if sizes is not None:
        item.sizes = sizes
    return item


class LargestSizeTest(unittest.TestCase):
    def test_prefers_largest_size_with_bytes(self):
        cached = size("w", 2560, 1440)          # largest area but no byte count
        medium = size("x", 1280, 720, n=90000)
        small = size("m", 320, 180, n=9000)
        self.assertIs(largest_size([small, cached, medium]), medium)

    def test_progressive_sizes_count(self):
        progressive = size("y", 1280, 720, sizes=[1000, 50000])
        self.assertIs(largest_size([size("w", 2560, 1440), progressive]), progressive)

    def test_falls_back_when_no_size_has_bytes(self):
        a = size("w", 2560, 1440)
        b = size("x", 1280, 720)
        self.assertIs(largest_size([b, a]), a)

    def test_photo_descriptor_is_usable(self):
        photo = SimpleNamespace(sizes=[size("w", 2560, 1440), size("x", 1280, 720, n=90000)])
        raw = reader_raw_message(SimpleNamespace(media=SimpleNamespace(photo=photo)), "photo")
        self.assertTrue(raw["photo"][0]["mtproto"])
        self.assertGreater(raw["photo"][0]["file_size"], 0)


if __name__ == "__main__":
    unittest.main()
