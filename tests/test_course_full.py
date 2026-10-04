"""Pure snapshot rules; Telegram sessions are never used in these tests."""
import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "reader-cli"))
sys.modules.setdefault("export_history", types.SimpleNamespace(classify=lambda message: "text", entity_to_bot_api=lambda entity: {}))
from course_full import validate_snapshot  # noqa: E402


def post(identifier, *, text="lesson", album=None, protected=False):
    return SimpleNamespace(id=identifier, raw_text=text, media=None, action=None,
                           grouped_id=album, noforwards=protected, entities=[],
                           document=None, photo=None, date=datetime(2026, 10, 2, tzinfo=timezone.utc))


class FullCourseSnapshotTest(unittest.TestCase):
    source = SimpleNamespace(id=3535777660, username=None)

    def test_snapshot_is_stable_and_includes_appendix(self):
        messages = [post(2), post(3, text="phụ lục 1")]
        info = validate_snapshot(messages, self.source, {2})
        self.assertEqual(info["count"], 2)
        self.assertEqual(info["high_watermark"], 3)
        self.assertEqual(info["appendix_candidates"], 1)
        self.assertEqual(info["sha256"], validate_snapshot(messages, self.source, {2})["sha256"])

    def test_protected_post_and_missing_internal_target_block_copy(self):
        with self.assertRaisesRegex(RuntimeError, "protected_post"):
            validate_snapshot([post(2, protected=True)], self.source, set())
        with self.assertRaisesRegex(RuntimeError, "Internal links"):
            validate_snapshot([post(2, text="https://t.me/c/3535777660/99")], self.source, set())

    def test_album_requires_full_contiguous_group(self):
        with self.assertRaisesRegex(RuntimeError, "Incomplete"):
            validate_snapshot([post(2, album=123), post(3)], self.source, set())
        info = validate_snapshot([post(2, album=123), post(3, album=123)], self.source, set())
        self.assertEqual(info["albums"], 1)


if __name__ == "__main__":
    unittest.main()
