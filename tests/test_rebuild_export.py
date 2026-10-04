import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "reader-cli"))

from rebuild_export_core import (
    RebuildValidationError,
    completed_unit_map,
    load_manifest,
    manifest_digest,
    new_state,
    pilot_preflight,
    select_pilot_units,
    validate_state,
    verify_selected_media,
)


class RebuildExportCoreTests(unittest.TestCase):
    def fixture(self, root):
        root = Path(root)
        media_rows = []
        messages = []
        album_ids = [[2,3],[4,5],[7,8],[9,10],[12,13],[17,18,19,20,21],[22,23,24,25],[27,28,29]]
        album_by_id = {}
        for index, ids in enumerate(album_ids, 1):
            for message_id in ids:
                album_by_id[message_id] = index

        video_ids = {2,3,6,7,8,9,10,22,23,24,25}
        photo_ids = {4,5,12,13,17,18,19,20,21,26,27,28,29}
        text_ids = {11,14,15,16}
        for message_id in range(2, 30):
            media = []
            kind = "text"
            if message_id in video_ids or message_id in photo_ids:
                kind = "video" if message_id in video_ids else "photo"
                path = root / f"{message_id}.bin"
                content = f"media-{message_id}".encode()
                path.write_bytes(content)
                media = [{
                    "kind": kind,
                    "relative_path": path.name,
                    "local_path": str(path),
                    "size_bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                }]
            self.assertTrue(message_id in text_ids or media)
            messages.append({
                "source_message_id": message_id,
                "telegram_type": kind,
                "album_number": album_by_id.get(message_id),
                "grouped_id": str(album_by_id[message_id]) if message_id in album_by_id else None,
                "reply_to_source_message_id": None,
                "text": f"lesson {message_id}",
                "links": [],
                "media": media,
            })

        units = []
        consumed = set()
        for message_id in range(2, 30):
            if message_id in consumed:
                continue
            album = album_by_id.get(message_id)
            ids = album_ids[album - 1] if album else [message_id]
            consumed.update(ids)
            units.append({
                "unit_number": len(units) + 1,
                "kind": "album" if album else "message",
                "source_message_ids": ids,
                "messages": [next(m for m in messages if m["source_message_id"] == mid) for mid in ids],
            })

        manifest = {
            "schema": "tgcloner.rebuild_from_telegram_export.v1",
            "source": {
                "title": "TEST",
                "chat_id": "-1002049524573",
                "protected": True,
                "message_range": [2,29],
                "message_count": 28,
                "pinned_source_message_ids": [],
            },
            "backup": {
                "root": str(root),
                "messages_html_sha256": "a" * 64,
                "media_count": 24,
                "video_count": 11,
                "photo_count": 13,
                "text_only_count": 4,
            },
            "topology": {
                "album_count": 8,
                "single_unit_count": 6,
                "rebuild_unit_count": 14,
                "exact_albums": album_ids,
            },
            "policy": {
                "source_telegram_read_only": True,
                "download_from_protected_source": False,
                "forward_from_protected_source": False,
                "media_source": "verified_local_backup_only",
                "destination_write_allowed_only_after_explicit_publish_gate": True,
            },
            "units": units,
        }
        manifest["manifest_sha256"] = manifest_digest(manifest)
        path = root / "manifest.json"
        path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        return path, manifest

    def test_verified_manifest_and_two_unit_media_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            path, expected = self.fixture(temp)
            manifest = load_manifest(path)
            self.assertEqual(manifest["manifest_sha256"], expected["manifest_sha256"])
            units = select_pilot_units(manifest, 2)
            self.assertTrue(pilot_preflight(units))
            rows = verify_selected_media(units)
            self.assertEqual(len(rows), 4)

    def test_manifest_tamper_is_blocked(self):
        with tempfile.TemporaryDirectory() as temp:
            path, _ = self.fixture(temp)
            value = json.loads(path.read_text(encoding="utf-8"))
            value["source"]["title"] = "tampered"
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(RebuildValidationError, "hash_mismatch"):
                load_manifest(path)

    def test_armed_state_blocks_blind_retry(self):
        state = new_state("b" * 64, "-100123", "TEST")
        state["inflight"] = {"unit_number": 1, "phase": "armed"}
        with self.assertRaisesRegex(RebuildValidationError, "manual_reconcile"):
            validate_state(state, "b" * 64, "-100123", "TEST")

    def test_completed_state_is_idempotent(self):
        state = new_state("c" * 64, "-100123", "TEST")
        state["completed_units"] = [{
            "unit_number": 1,
            "source_message_ids": [2,3],
            "destination_message_ids": [10,11],
        }]
        checked = validate_state(state, "c" * 64, "-100123", "TEST")
        self.assertEqual(completed_unit_map(checked), {1: [10,11]})


if __name__ == "__main__":
    unittest.main()
