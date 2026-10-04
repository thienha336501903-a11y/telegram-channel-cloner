import hashlib
import json
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "reader-cli"))

from rebuild_export_core import canonical_manifest_hash, pilot_units, validate_manifest


class RebuildExportCoreTest(unittest.TestCase):
    def make_manifest(self, root):
        media = root / "video.mp4"
        media.write_bytes(b"verified-local-backup")
        sha = hashlib.sha256(media.read_bytes()).hexdigest()
        manifest = {
            "schema": "tgcloner.rebuild_from_telegram_export.v1",
            "source": {
                "title": "Protected source",
                "chat_id": "-1002049524573",
                "protected": True,
                "message_range": [2, 3],
                "message_count": 2,
                "pinned_source_message_ids": [],
            },
            "backup": {
                "root": str(root),
                "messages_html_sha256": "a" * 64,
                "media_count": 1,
                "video_count": 1,
                "photo_count": 0,
                "text_only_count": 1,
            },
            "topology": {
                "album_count": 0,
                "single_unit_count": 2,
                "rebuild_unit_count": 2,
                "exact_albums": [],
            },
            "policy": {
                "source_telegram_read_only": True,
                "download_from_protected_source": False,
                "forward_from_protected_source": False,
                "media_source": "verified_local_backup_only",
                "destination_write_allowed_only_after_explicit_publish_gate": True,
            },
            "units": [
                {
                    "unit_number": 1,
                    "kind": "message",
                    "source_message_ids": [2],
                    "messages": [{
                        "source_message_id": 2,
                        "telegram_type": "video",
                        "album_number": None,
                        "grouped_id": None,
                        "reply_to_source_message_id": None,
                        "text": "caption",
                        "links": [],
                        "media": [{
                            "kind": "video",
                            "relative_path": "video.mp4",
                            "local_path": str(media),
                            "size_bytes": media.stat().st_size,
                            "sha256": sha,
                        }],
                    }],
                },
                {
                    "unit_number": 2,
                    "kind": "message",
                    "source_message_ids": [3],
                    "messages": [{
                        "source_message_id": 3,
                        "telegram_type": "text",
                        "album_number": None,
                        "grouped_id": None,
                        "reply_to_source_message_id": None,
                        "text": "lesson text",
                        "links": [],
                        "media": [],
                    }],
                },
            ],
        }
        manifest["manifest_sha256"] = canonical_manifest_hash(manifest)
        return manifest, media

    def test_valid_manifest_and_pilot_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest, _ = self.make_manifest(Path(directory))
            summary = validate_manifest(manifest)
            self.assertEqual(summary["unit_count"], 2)
            self.assertEqual(len(pilot_units(manifest, 1)), 1)
            self.assertEqual(len(pilot_units(manifest, 2)), 2)
            self.assertEqual(pilot_units(manifest, 1, 2)[0]["unit_number"], 2)
            with self.assertRaisesRegex(RuntimeError, "must_be_1_to_2"):
                pilot_units(manifest, 3)
            with self.assertRaisesRegex(RuntimeError, "start_unit_invalid"):
                pilot_units(manifest, 1, 0)

    def test_modified_media_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest, media = self.make_manifest(Path(directory))
            media.write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeError, "media_size_changed|media_hash_changed"):
                validate_manifest(manifest)

    def test_manifest_policy_tamper_is_rejected_by_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest, _ = self.make_manifest(Path(directory))
            manifest["policy"]["forward_from_protected_source"] = True
            with self.assertRaisesRegex(RuntimeError, "manifest_hash_mismatch"):
                validate_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
