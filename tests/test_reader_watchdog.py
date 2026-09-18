"""Executable Reader lifecycle tests; no Telegram, R2 or production DB access."""
import asyncio
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "reader-manager"))
sys.path.insert(0, str(ROOT / "reader-cli"))

import reader_manager_agent as agent
import mirror_v5_r2 as mirror


class ReaderRecoveryTests(unittest.TestCase):
    def test_outbox_replay_waits_for_active_worker_to_exit(self):
        class OnceEvent:
            stopped = False

            def is_set(self):
                return self.stopped

            def set(self):
                self.stopped = True

            def wait(self, seconds):
                self.stopped = True

        actions = []
        with patch.object(agent, "load_config", return_value={"agent_token": "test"}), \
             patch.object(agent, "sync_remote_profiles", side_effect=lambda config: config), \
             patch.object(agent, "active_mirror_stats", return_value=(1, True, 0)), \
             patch.object(agent, "flush_pending_finishes", side_effect=lambda config: actions.append("replay")), \
             patch.object(agent, "can_claim_mirror", return_value=(False, None)), \
             patch.object(agent, "mirror_backoff_remaining", return_value=0), \
             patch.object(agent, "terminate_all_subprocesses"), \
             patch.object(agent, "wait_for_active_mirrors"):
            agent.agent_loop(OnceEvent())
        self.assertEqual(actions, [])

    def test_exact_indexed_photo_variant_and_size_check(self):
        small = SimpleNamespace(type="x", size=73_547, w=900, h=900)
        large = SimpleNamespace(type="y", size=90_738, w=1024, h=1024)
        photo = SimpleNamespace(sizes=[small, large])
        message = SimpleNamespace(media=SimpleNamespace(photo=photo), photo=photo)

        class Client:
            def __init__(self, written):
                self.written = written
                self.selected = None

            async def download_media(self, msg, file, thumb):
                self.selected = thumb
                Path(file).write_bytes(b"x" * self.written)
                return file

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "photo.jpg"
            client = Client(73_547)
            _, downloaded = asyncio.run(mirror.download_resumable(
                client, None, message, target, expected_bytes=73_547, is_photo=True
            ))
            self.assertIs(client.selected, small)
            self.assertEqual(downloaded, 73_547)

            client = Client(90_738)
            with self.assertRaisesRegex(RuntimeError, "telegram_photo_size_mismatch"):
                asyncio.run(mirror.download_resumable(
                    client, None, message, target, expected_bytes=73_547, is_photo=True
                ))
            self.assertFalse(target.exists())
            self.assertFalse(mirror.can_reuse_download_cache(
                Path(directory) / "wrong.part", {}, "channel", 31, 73_547, True
            ))
            with self.assertRaisesRegex(RuntimeError, "telegram_photo_indexed_size_unavailable"):
                mirror.exact_photo_size(message, 12_345)

    def test_stalled_small_image_terminates_before_failed_finish_with_same_attempt(self):
        class Process:
            returncode = None

            def poll(self):
                return self.returncode

            def terminate(self):
                self.returncode = -15

            def wait(self, timeout=None):
                self.assert_finished = True
                return self.returncode

        process = Process()
        events = []

        def fake_api(config, action, payload=None, timeout=45):
            if action == "v5-mirror-finish":
                self.assertEqual(process.poll(), -15)
                self.assertEqual(payload["attempt"], 2)
                self.assertEqual(payload["error"], "reader_small_image_stalled")
            events.append((action, payload))
            return {"ok": True}

        config = {
            "agent_token": "test", "profiles": [],
            "r2": {k: "fake" for k in ("account_id", "access_key_id", "secret_access_key", "bucket")}
        }
        job = {
            "id": "test-job", "job_type": "v5_mirror", "attempt": 2,
            "channel_ref": "@channel", "source_id": "test-source", "asset_id": "asset",
            "source_message_id": 31, "object_key": "test/key", "original_filename": "telegram-31.jpg",
            "mime_type": "image/jpeg", "expected_bytes": 73_547
        }
        profile = {"id": "profile", "api_id": 1, "api_hash": "fake", "session": "fake"}
        clock = iter((0, 31, 62, 93, 124))
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(agent, "finish_outbox_dir", return_value=Path(directory)), \
             patch.object(agent, "choose_v5_profile", return_value=profile), \
             patch.object(agent, "api", side_effect=fake_api), \
             patch.object(agent, "worker_command", return_value=["fake-worker"]), \
             patch.object(agent.subprocess, "Popen", return_value=process), \
             patch.object(agent.time, "monotonic", side_effect=lambda: next(clock)), \
             patch.object(agent.time, "sleep", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "reader_small_image_stalled"):
                agent.run_job(config, job, threading.Event())
            self.assertFalse(list(Path(directory).glob("finish_*")))

        self.assertEqual(sum(action == "v5-mirror-finish" for action, _ in events), 1)
        self.assertGreaterEqual(sum(action == "v5-mirror-heartbeat" for action, _ in events), 1)
        self.assertEqual(events[-1][1]["status"], "ready")

    def test_invalid_success_outbox_releases_exact_attempt(self):
        attempts = []

        def fake_api(config, action, payload=None, timeout=45):
            attempts.append(dict(payload))
            if payload["ok"]:
                raise RuntimeError("v5_mirror_size_mismatch:90738/73547 (HTTP 500)")
            return {"ok": True}

        with tempfile.TemporaryDirectory() as directory, \
             patch.object(agent, "finish_outbox_dir", return_value=Path(directory)), \
             patch.object(agent, "api", side_effect=fake_api):
            agent.save_pending_finish("job", {
                "job_id": "job", "attempt": 3, "ok": True, "bytes": 90_738
            })
            self.assertEqual(agent.flush_pending_finishes({}), 1)
            self.assertFalse(agent.list_pending_finishes())
        self.assertEqual([item["attempt"] for item in attempts], [3, 3])
        self.assertEqual([item["ok"] for item in attempts], [True, False])


if __name__ == "__main__":
    unittest.main()
