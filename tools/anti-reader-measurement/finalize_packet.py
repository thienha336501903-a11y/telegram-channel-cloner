#!/usr/bin/env python3
"""Privately inject a local measurement configuration into a generic artifact."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import tempfile
import zipfile
from pathlib import Path


GENERIC_FILES = {
    "AntiReaderMeasure.exe",
    "README-ANTI.md",
    "Run-AntiReaderMeasurement.ps1",
    "measurement-targets.json",
    "manifest.json",
    "SHA256SUMS.txt",
}
HASHED_FILES = (
    "AntiReaderMeasure.exe",
    "README-ANTI.md",
    "Run-AntiReaderMeasurement.ps1",
    "measurement-targets.json",
    "manifest.json",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_config(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"schema_version", "profile_id", "channel", "targets"}:
        raise RuntimeError("configuration must contain only schema_version, profile_id, channel and targets")
    if value.get("schema_version") != 1:
        raise RuntimeError("unsupported configuration schema")
    profile_id = value.get("profile_id")
    channel = value.get("channel")
    targets = value.get("targets")
    if not isinstance(profile_id, str) or not re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        profile_id,
    ):
        raise RuntimeError("invalid profile id")
    if not isinstance(channel, str) or not channel.startswith("-100") or not channel[1:].isdigit():
        raise RuntimeError("invalid channel")
    if not isinstance(targets, list) or len(targets) != 3:
        raise RuntimeError("exactly three targets are required")
    allowed_target_keys = {"message_id", "filename", "bytes"}
    seen = set()
    normalized = []
    for target in targets:
        if not isinstance(target, dict) or set(target) != allowed_target_keys:
            raise RuntimeError("invalid target fields")
        message_id = target.get("message_id")
        byte_count = target.get("bytes")
        filename = target.get("filename")
        if isinstance(message_id, bool) or not isinstance(message_id, int) or message_id < 1 or message_id in seen:
            raise RuntimeError("invalid or duplicate message id")
        if (
            isinstance(byte_count, bool)
            or not isinstance(byte_count, int)
            or not (1 <= byte_count <= 2_147_483_647)
        ):
            raise RuntimeError("invalid target byte count")
        if (
            not isinstance(filename, str)
            or not filename.strip()
            or len(filename) > 180
            or any(character in filename for character in "\r\n")
        ):
            raise RuntimeError("invalid target filename")
        seen.add(message_id)
        normalized.append(
            {"message_id": message_id, "filename": filename.strip(), "bytes": byte_count}
        )
    return {
        "schema_version": 1,
        "profile_id": profile_id,
        "channel": channel,
        "targets": normalized,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generic-zip", type=Path, required=True)
    parser.add_argument("--config-json", type=Path, required=True)
    parser.add_argument("--output-zip", type=Path, required=True)
    args = parser.parse_args()
    config = validate_config(json.loads(args.config_json.read_text(encoding="utf-8")))
    with tempfile.TemporaryDirectory(prefix="anti-reader-finalize-") as temp_value:
        root = Path(temp_value)
        with zipfile.ZipFile(args.generic_zip, "r") as archive:
            names = set(archive.namelist())
            if names != GENERIC_FILES or any("/" in name or "\\" in name for name in names):
                raise RuntimeError("generic packet file list mismatch")
            archive.extractall(root)
        (root / "measurement-targets.json").write_text(
            json.dumps(config, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("bundle_version") != "2.0.0":
            raise RuntimeError("generic packet version mismatch")
        if manifest.get("baseline_main_sha") != "931c064798e1c5e278c88637129397643963fa26":
            raise RuntimeError("generic packet baseline mismatch")
        if manifest.get("measurement_config_finalized") is not False:
            raise RuntimeError("generic packet is already finalized")
        manifest["bundle_name"] = "ANTI_READER_MEASUREMENT_V2_BUNDLE"
        manifest["measurement_config_finalized"] = True
        manifest["measurement_configuration_sha256"] = sha256(root / "measurement-targets.json")
        manifest["measurement_configuration"] = {
            "profile_id": config["profile_id"],
            "channel": config["channel"],
            "targets": [
                {
                    "message_id": target["message_id"],
                    "bytes": target["bytes"],
                    "expected_chunks": math.ceil(target["bytes"] / 524288),
                }
                for target in config["targets"]
            ],
        }
        payload_names = HASHED_FILES[:-1]
        manifest["files"] = [
            {"name": name, "bytes": (root / name).stat().st_size, "sha256": sha256(root / name)}
            for name in payload_names
        ]
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        (root / "SHA256SUMS.txt").write_text(
            "".join(f"{sha256(root / name)} *{name}\n" for name in HASHED_FILES),
            encoding="utf-8",
        )
        output = args.output_zip.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists():
            output.unlink()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name in (*HASHED_FILES, "SHA256SUMS.txt"):
                archive.write(root / name, arcname=name)
        print(json.dumps({"bundle": str(output), "sha256": sha256(output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
