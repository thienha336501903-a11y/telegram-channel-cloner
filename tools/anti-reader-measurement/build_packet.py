#!/usr/bin/env python3
"""Assemble and smoke-test the frozen Windows measurement packet."""

from __future__ import annotations

import argparse
import ast
import datetime as dt
import hashlib
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import telethon


BUNDLE_NAME = "ANTI_READER_MEASUREMENT_V2_GENERIC"
BUNDLE_VERSION = "2.0.0"
BASELINE_MAIN_SHA = "931c064798e1c5e278c88637129397643963fa26"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_probe_source(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    forbidden_imports = {"boto3", "botocore", "requests", "supabase", "urllib3", "httpx"}
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".", 1)[0])
    bad = sorted(imported & forbidden_imports)
    if bad:
        raise RuntimeError("forbidden probe imports: " + ", ".join(bad))
    if "http://" in source.lower() or "https://" in source.lower():
        raise RuntimeError("probe source contains an HTTP endpoint")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    exe = args.exe.resolve()
    output_dir = args.output_dir.resolve()
    if not exe.is_file():
        raise SystemExit(f"missing executable: {exe}")
    if tuple(sys.version_info[:3]) != (3, 12, 10):
        raise SystemExit(f"build requires Python 3.12.10, got {sys.version.split()[0]}")
    if telethon.__version__ != "1.45.0":
        raise SystemExit(f"build requires Telethon 1.45.0, got {telethon.__version__}")
    validate_probe_source(here / "anti_reader_measure.py")
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="anti-reader-packet-") as temp_value:
        stage = Path(temp_value) / BUNDLE_NAME
        stage.mkdir()
        shutil.copy2(exe, stage / "AntiReaderMeasure.exe")
        shutil.copy2(here / "Run-AntiReaderMeasurement.ps1", stage)
        shutil.copy2(here / "README-ANTI.md", stage)
        (stage / "measurement-targets.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "profile_id": "FINALIZE_BEFORE_USE",
                    "channel": "FINALIZE_BEFORE_USE",
                    "targets": [],
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        dependency_lock = [
            line.strip()
            for line in (here / "requirements-build.txt").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        payload_files = []
        for name in (
            "AntiReaderMeasure.exe",
            "Run-AntiReaderMeasurement.ps1",
            "README-ANTI.md",
            "measurement-targets.json",
        ):
            path = stage / name
            payload_files.append(
                {"name": name, "bytes": path.stat().st_size, "sha256": sha256(path)}
            )
        manifest = {
            "schema_version": 1,
            "bundle_name": BUNDLE_NAME,
            "bundle_version": BUNDLE_VERSION,
            "built_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_repository": "thienha336501903-a11y/telegram-channel-cloner",
            "baseline_main_sha": BASELINE_MAIN_SHA,
            "tooling_commit_sha": os.environ.get("GITHUB_SHA", "local"),
            "python_version": sys.version.split()[0],
            "telethon_version": telethon.__version__,
            "pyinstaller_version": importlib.metadata.version("PyInstaller"),
            "self_contained_frozen_probe": True,
            "measurement_config_finalized": False,
            "cryptg_bundled": False,
            "request_size_bytes": 524288,
            "max_requests_inflight": 1,
            "probe_output_directory_contract": "probe_creates_nonexistent_directory",
            "network_events_are_diagnostic_warnings": True,
            "sha256_validation_excluded_from_timed_download": True,
            "measurement_configuration": None,
            "dependency_lock": dependency_lock,
            "safety": {
                "production_queue_access": False,
                "reader_control_api_access": False,
                "object_storage_access": False,
                "config_write": False,
                "session_persistence": False,
                "telegram_download_parallelism": 1,
            },
            "files": payload_files,
        }
        manifest_path = stage / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        smoke = subprocess.run(
            [str(stage / "AntiReaderMeasure.exe"), "--self-test", "--bundle-root", str(stage)],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if smoke.returncode != 0 or "SELF_TEST_PASS" not in smoke.stdout:
            raise RuntimeError(
                "offline frozen smoke test failed: "
                + (smoke.stdout + " " + smoke.stderr).strip()[:1000]
            )

        contract_output = Path(temp_value) / "contract-output"
        contract = subprocess.run(
            [
                str(stage / "AntiReaderMeasure.exe"),
                "--contract-test",
                "--bundle-root",
                str(stage),
                "--output-dir",
                str(contract_output),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if (
            contract.returncode != 0
            or "CONTRACT_TEST_PASS" not in contract.stdout
            or not (contract_output / "contract-test.json").is_file()
        ):
            raise RuntimeError(
                "frozen output ownership contract test failed: "
                + (contract.stdout + " " + contract.stderr).strip()[:1000]
            )
        repeated_contract = subprocess.run(
            [
                str(stage / "AntiReaderMeasure.exe"),
                "--contract-test",
                "--bundle-root",
                str(stage),
                "--output-dir",
                str(contract_output),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if repeated_contract.returncode == 0 or "output_directory_must_not_exist" not in repeated_contract.stdout:
            raise RuntimeError("frozen output ownership negative contract test failed")

        sum_names = (
            "AntiReaderMeasure.exe",
            "README-ANTI.md",
            "Run-AntiReaderMeasurement.ps1",
            "measurement-targets.json",
            "manifest.json",
        )
        sums_path = stage / "SHA256SUMS.txt"
        sums_path.write_text(
            "".join(f"{sha256(stage / name)} *{name}\n" for name in sum_names),
            encoding="utf-8",
        )
        zip_path = output_dir / f"{BUNDLE_NAME}.zip"
        if zip_path.exists():
            zip_path.unlink()
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name in (*sum_names, "SHA256SUMS.txt"):
                archive.write(stage / name, arcname=name)
        bundle_hash = sha256(zip_path)
        (output_dir / f"{BUNDLE_NAME}.zip.sha256").write_text(
            f"{bundle_hash} *{zip_path.name}\n", encoding="utf-8"
        )
        print(json.dumps({"bundle": str(zip_path), "sha256": bundle_hash}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
