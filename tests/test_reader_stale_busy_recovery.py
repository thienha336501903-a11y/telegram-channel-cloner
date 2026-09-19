import os
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "reader-manager"))

import reader_manager_agent as agent  # noqa: E402


class FakeEvent:
    def __init__(self, stop_after_waits=None):
        self.flag = False
        self.waits = 0
        self.stop_after_waits = stop_after_waits

    def is_set(self):
        return self.flag

    def set(self):
        self.flag = True

    def wait(self, _seconds):
        self.waits += 1
        if self.stop_after_waits and self.waits >= self.stop_after_waits:
            self.flag = True
        return self.flag


class StaleBusyRecoveryTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("YEUNAUAN_READER_V5_ONE_SHOT", None)

    def test_busy_profile_is_a_v5_candidate_but_not_generic_ready(self):
        config = {
            "profiles": [
                {"id": "busy", "status": "busy", "session": "session"},
                {"id": "paused", "status": "paused", "session": "session-2"},
            ]
        }

        self.assertEqual(agent.ready_profiles(config), [])
        self.assertEqual(
            [item["id"] for item in agent.v5_candidate_profiles(config)],
            ["busy"],
        )

    def test_normal_scheduler_can_resume_one_busy_profile(self):
        stop = FakeEvent()
        config = {
            "agent_token": "token",
            "profiles": [{"id": "busy", "status": "busy", "session": "session"}],
        }
        calls = {"claim": 0, "start": 0}

        def claim(_config):
            calls["claim"] += 1
            return {"id": "job-1", "job_type": "v5_mirror", "attempt": 3, "benchmark": False}

        def start(_config, job, _stop, _status=None):
            self.assertEqual(job["attempt"], 3)
            calls["start"] += 1
            stop.set()

        with mock.patch.multiple(
            agent,
            load_config=mock.Mock(return_value=config),
            sync_remote_profiles=mock.Mock(side_effect=lambda value: value),
            flush_pending_finishes=mock.Mock(return_value=0),
            list_pending_finishes=mock.Mock(return_value=[]),
            active_mirror_stats=mock.Mock(return_value=(0, False, 0)),
            mirror_backoff_remaining=mock.Mock(return_value=0),
            claim_generic_job=mock.Mock(return_value=None),
            can_claim_mirror=mock.Mock(return_value=(True, "any")),
            claim_v5_job=mock.Mock(side_effect=claim),
            start_mirror_job=mock.Mock(side_effect=start),
            terminate_all_subprocesses=mock.Mock(),
            wait_for_active_mirrors=mock.Mock(return_value=True),
        ):
            agent.agent_loop(stop)

        self.assertEqual(calls, {"claim": 1, "start": 1})

    def test_scheduler_does_not_claim_without_usable_profile(self):
        stop = FakeEvent(stop_after_waits=1)
        config = {
            "agent_token": "token",
            "profiles": [{"id": "paused", "status": "paused", "session": "session"}],
        }
        statuses = []

        with mock.patch.multiple(
            agent,
            load_config=mock.Mock(return_value=config),
            sync_remote_profiles=mock.Mock(side_effect=lambda value: value),
            flush_pending_finishes=mock.Mock(return_value=0),
            list_pending_finishes=mock.Mock(return_value=[]),
            active_mirror_stats=mock.Mock(return_value=(0, False, 0)),
            mirror_backoff_remaining=mock.Mock(return_value=0),
            claim_generic_job=mock.Mock(return_value=None),
            can_claim_mirror=mock.Mock(return_value=(True, "any")),
            claim_v5_job=mock.Mock(side_effect=AssertionError("must not claim")),
            terminate_all_subprocesses=mock.Mock(),
            wait_for_active_mirrors=mock.Mock(return_value=True),
        ):
            agent.agent_loop(stop, statuses.append)

        self.assertIn("Reader không nhận job", statuses[-1])

    def test_v5_worker_selection_explicitly_accepts_busy_profile(self):
        config = {
            "profiles": [{"id": "busy", "status": "busy", "session": "session"}]
        }
        selected = []

        def choose(_config, _channel, _source_id, allow_busy=False):
            selected.append(allow_busy)
            return config["profiles"][0]

        fake_thread = mock.Mock()
        fake_thread.start = mock.Mock()
        with mock.patch.object(agent, "choose_v5_profile", side_effect=choose), mock.patch.object(
            agent.threading, "Thread", return_value=fake_thread
        ):
            agent.start_mirror_job(
                config,
                {
                    "id": "job-busy",
                    "channel_ref": "@source",
                    "source_id": "source",
                    "job_type": "v5_mirror",
                    "attempt": 2,
                    "benchmark": False,
                },
                threading.Event(),
            )

        self.assertEqual(selected, [True])
        fake_thread.start.assert_called_once_with()
        with agent._ACTIVE_MIRRORS_LOCK:
            agent._ACTIVE_MIRRORS.pop("job-busy", None)

    def test_run_job_recovery_path_also_accepts_busy_profile(self):
        selected = []
        finishes = []

        def choose(_config, _channel, _source_id, allow_busy=False):
            selected.append(allow_busy)
            return None

        def api(_config, action, payload=None, timeout=45):
            if action == "v5-mirror-finish":
                finishes.append(payload)
            return {"ok": True}

        job = {
            "id": "job-run",
            "channel_ref": "@source",
            "source_id": "source",
            "job_type": "v5_mirror",
            "attempt": 4,
            "benchmark": False,
        }
        with mock.patch.object(agent, "choose_v5_profile", side_effect=choose), mock.patch.object(
            agent, "api", side_effect=api
        ), mock.patch.object(agent, "save_pending_finish"), mock.patch.object(
            agent, "remove_pending_finish"
        ):
            with self.assertRaisesRegex(RuntimeError, "reader_source_access_denied"):
                agent.run_job({}, job, threading.Event())

        self.assertEqual(selected, [True])
        self.assertEqual(finishes[0]["attempt"], 4)

    def test_real_source_access_failure_cannot_burn_queue_rapidly(self):
        self.assertEqual(
            agent.rate_limit_wait_seconds("reader_source_access_denied"),
            (5 * 60, 15 * 60),
        )


if __name__ == "__main__":
    unittest.main()
