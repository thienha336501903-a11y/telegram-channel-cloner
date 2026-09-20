#!/usr/bin/env python3
"""Offline regression tests for the V2 measurement packet."""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

import anti_reader_measure as probe
import build_packet
import finalize_packet


HERE = Path(__file__).resolve().parent


class OutputOwnershipTests(unittest.TestCase):
    def test_probe_claims_nonexistent_directory_once(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            output = Path(value) / "probe-output"
            self.assertFalse(output.exists())
            probe.claim_output_directory(output, enforce_launcher_layout=False)
            self.assertTrue(output.is_dir())
            with self.assertRaisesRegex(RuntimeError, "output_directory_must_not_exist"):
                probe.claim_output_directory(output, enforce_launcher_layout=False)

    def test_missing_parent_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as value:
            output = Path(value) / "missing" / "probe-output"
            with self.assertRaisesRegex(RuntimeError, "output_parent_missing"):
                probe.claim_output_directory(output, enforce_launcher_layout=False)

    def test_launcher_does_not_create_probe_output(self) -> None:
        launcher = (HERE / "Run-AntiReaderMeasurement.ps1").read_text(encoding="utf-8")
        self.assertNotRegex(launcher, r"New-Item[^\n]+\$ProbeDir")
        self.assertIn("probe output path must not exist before launch", launcher)
        self.assertIn("--output-dir $ProbeDir", launcher)


class ConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = {
            "schema_version": 1,
            "profile_id": "11111111-2222-4333-8444-555555555555",
            "channel": "-1001234567890",
            "targets": [
                {"message_id": 10, "filename": "a.mp4", "bytes": 10_000_001},
                {"message_id": 20, "filename": "b.mp4", "bytes": 20_000_002},
                {"message_id": 30, "filename": "c.mp4", "bytes": 30_000_003},
            ],
        }

    def test_probe_and_finalizer_accept_same_valid_config(self) -> None:
        normalized = finalize_packet.validate_config(self.config)
        with tempfile.TemporaryDirectory() as value:
            path = Path(value) / "targets.json"
            path.write_text(json.dumps(normalized), encoding="utf-8")
            loaded = probe.load_measurement_config(path)
        self.assertEqual([item["message_id"] for item in loaded["targets"]], [10, 20, 30])

    def test_duplicate_message_is_rejected(self) -> None:
        self.config["targets"][1]["message_id"] = 10
        with self.assertRaisesRegex(RuntimeError, "duplicate"):
            finalize_packet.validate_config(self.config)

    def test_control_character_in_filename_is_rejected(self) -> None:
        self.config["targets"][0]["filename"] = "bad\nname.mp4"
        with self.assertRaisesRegex(RuntimeError, "filename"):
            finalize_packet.validate_config(self.config)


class TelemetryContractTests(unittest.TestCase):
    def test_percentiles(self) -> None:
        self.assertEqual(probe.percentile([1.0, 2.0, 3.0], 0.5), 2.0)
        self.assertEqual(probe.percentile([1.0, 2.0, 3.0, 4.0], 0.95), 3.85)

    def test_probe_source_has_no_production_network_clients(self) -> None:
        build_packet.validate_probe_source(HERE / "anti_reader_measure.py")

    def test_hashing_is_outside_timed_download_loop(self) -> None:
        source = (HERE / "anti_reader_measure.py").read_text(encoding="utf-8")
        loop = re.search(
            r"async for chunk in client\.iter_download\((.*?)\n\s*except BaseException",
            source,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(loop)
        self.assertNotIn("digest.update", loop.group(1))
        self.assertIn("validation_sha256_seconds_outside_timed_download", source)

    def test_network_events_are_warnings_not_hard_failures(self) -> None:
        source = (HERE / "anti_reader_measure.py").read_text(encoding="utf-8")
        self.assertIn('diagnostic_warnings.append("network_event_observed")', source)
        self.assertNotIn('failures.append("network_event_contamination")', source)

    def test_secret_sanitizer(self) -> None:
        text = probe.sanitize_text("api_hash=abcdef0123456789 session=ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        self.assertNotIn("abcdef0123456789", text)
        self.assertNotIn("ABCDEFGHIJKLMNOPQRSTUVWXYZ", text)


if __name__ == "__main__":
    unittest.main()
