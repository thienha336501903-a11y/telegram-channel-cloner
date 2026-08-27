#!/usr/bin/env python3
"""Background Telegram history reader agent.

The Telegram user session stays on this PC. The agent polls the Cloner for queued
history-import/reconcile work and, only when local R2 credentials are configured,
V5 Telegram-to-R2 mirror jobs. No Telegram or R2 secret is uploaded.
"""
import argparse
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests

DEFAULT_POLL_SECONDS = 15
DEFAULT_HEARTBEAT_SECONDS = 30
READER_CONTROL_PATH = "/api/reader/complete"
BASE_READER_CAPABILITIES = ["reconcile_v1"]
V5_MIRROR_CAPABILITY = "v5_r2_mirror_v1"


def post_json(base_url, path, secret, payload, timeout=60):
    response = requests.post(
        base_url.rstrip("/") + path,
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        timeout=timeout,
    )
    if not response.ok:
        raise RuntimeError(f"{path}: HTTP {response.status_code}: {response.text[:500]}")
    return response.json()


def control_path(action):
    return f"{READER_CONTROL_PATH}?action={action}"


def default_agent_id():
    user = os.getenv("USERNAME") or os.getenv("USER") or "user"
    host = platform.node() or "windows"
    return f"{host}:{user}"[:160]


def has_v5_r2_config():
    return bool(
        str(os.getenv("R2_ACCOUNT_ID") or "").strip()
        and str(os.getenv("R2_ACCESS_KEY_ID") or "").strip()
        and str(os.getenv("R2_SECRET_ACCESS_KEY") or "").strip()
        and str(os.getenv("R2_BUCKET") or os.getenv("V5_R2_BUCKET") or "").strip()
    )


def reader_capabilities():
    capabilities = list(BASE_READER_CAPABILITIES)
    if has_v5_r2_config():
        capabilities.append(V5_MIRROR_CAPABILITY)
    return capabilities


def run_worker(command, cwd, cloner_url, agent_id, job_id, secret, heartbeat_seconds, heartbeat_action="heartbeat"):
    env = os.environ.copy()
    proc = subprocess.Popen(command, cwd=str(cwd), env=env)
    last_heartbeat = 0.0
    while True:
        code = proc.poll()
        now = time.time()
        if now - last_heartbeat >= heartbeat_seconds:
            try:
                post_json(
                    cloner_url,
                    control_path(heartbeat_action),
                    secret,
                    {"job_id": job_id, "agent_id": agent_id},
                    timeout=20,
                )
            except Exception as exc:
                print(f"Warning: heartbeat failed: {exc}", file=sys.stderr)
            last_heartbeat = now
        if code is not None:
            return code
        time.sleep(2)


def read_worker_result(path):
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else {}
    except (FileNotFoundError, OSError, ValueError):
        return {}


def nonnegative_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def claim_next_job(cloner_url, secret, agent_id, capabilities):
    normal = post_json(
        cloner_url,
        control_path("claim"),
        secret,
        {"agent_id": agent_id, "capabilities": capabilities},
        timeout=30,
    ).get("job")
    if normal:
        return normal
    if V5_MIRROR_CAPABILITY not in capabilities:
        return None
    return post_json(
        cloner_url,
        control_path("v5-mirror-claim"),
        secret,
        {"agent_id": agent_id, "capabilities": capabilities},
        timeout=30,
    ).get("job")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cloner-url", default=os.getenv("CLONER_URL", "https://reader.yeubep.shop"))
    parser.add_argument("--ingest-secret", default=os.getenv("READER_INGEST_SECRET"))
    parser.add_argument("--agent-id", default=os.getenv("READER_AGENT_ID") or default_agent_id())
    parser.add_argument("--poll-seconds", type=int, default=DEFAULT_POLL_SECONDS)
    parser.add_argument("--heartbeat-seconds", type=int, default=DEFAULT_HEARTBEAT_SECONDS)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    if not args.ingest_secret:
        parser.error("READER_INGEST_SECRET is required")
    if not os.getenv("TELEGRAM_API_ID") or not os.getenv("TELEGRAM_API_HASH"):
        parser.error("TELEGRAM_API_ID and TELEGRAM_API_HASH are required")

    capabilities = reader_capabilities()
    worker_dir = Path(__file__).resolve().parent
    repo_root = worker_dir.parent
    importer = worker_dir / "export_history.py"
    reconciler = worker_dir / "reconcile_history.py"
    mirror = worker_dir / "mirror_v5_r2.py"
    if not importer.exists():
        raise SystemExit(f"Missing importer: {importer}")
    if not reconciler.exists():
        raise SystemExit(f"Missing reconciler: {reconciler}")
    if V5_MIRROR_CAPABILITY in capabilities and not mirror.exists():
        raise SystemExit(f"Missing V5 mirror worker: {mirror}")

    print(f"Reader Agent online: {args.agent_id}")
    print("Telegram session remains local on this PC.")
    print("Capabilities: " + ", ".join(capabilities))

    while True:
        try:
            job = claim_next_job(args.cloner_url, args.ingest_secret, args.agent_id, capabilities)
            if not job:
                if args.once:
                    return 0
                time.sleep(max(5, args.poll_seconds))
                continue

            job_id = str(job.get("id") or "")
            source_id = str(job.get("source_id") or "")
            channel = str(job.get("channel_ref") or "").strip()
            job_type = str(job.get("job_type") or "import").strip().lower()
            if not job_id or not channel:
                raise RuntimeError("Reader job missing id/channel_ref")

            heartbeat_action = "heartbeat"
            finish_action = "finish-job"
            result_required = False

            if job_type == "reconcile":
                if not source_id:
                    raise RuntimeError("Reconcile job missing source_id")
                command = [
                    sys.executable,
                    str(reconciler),
                    "--source-id", source_id,
                    "--channel", channel,
                    "--cloner-url", args.cloner_url,
                ]
                result_required = True
            elif job_type == "v5_mirror":
                required = ["asset_id", "source_message_id", "object_key"]
                if any(not job.get(key) for key in required):
                    raise RuntimeError("V5 mirror job missing asset/message/object key")
                command = [
                    sys.executable,
                    str(mirror),
                    "--channel", channel,
                    "--message-id", str(job["source_message_id"]),
                    "--asset-id", str(job["asset_id"]),
                    "--object-key", str(job["object_key"]),
                    "--original-filename", str(job.get("original_filename") or "telegram-media"),
                    "--mime-type", str(job.get("mime_type") or "application/octet-stream"),
                    "--expected-bytes", str(int(job.get("expected_bytes") or 0)),
                ]
                heartbeat_action = "v5-mirror-heartbeat"
                finish_action = "v5-mirror-finish"
                result_required = True
            else:
                job_type = "import"
                command = [sys.executable, str(importer), "--channel", channel, "--cloner-url", args.cloner_url]

            print(f"Claimed {job_type} job {job_id}: {channel}")
            with tempfile.TemporaryDirectory(prefix="tgcloner-reader-result-") as result_dir:
                result_file = Path(result_dir) / "result.json"
                if job_type == "reconcile":
                    command.extend(["--result-file", str(result_file)])
                elif job_type == "v5_mirror":
                    command.extend(["--result-file", str(result_file)])
                code = run_worker(
                    command,
                    repo_root,
                    args.cloner_url,
                    args.agent_id,
                    job_id,
                    args.ingest_secret,
                    max(10, args.heartbeat_seconds),
                    heartbeat_action=heartbeat_action,
                )
                worker_result = read_worker_result(result_file) if result_required else {}

            ok = code == 0 and (not result_required or worker_result.get("ok", True) is True)
            error = None if ok else str(worker_result.get("error") or f"{job_type}_exit_{code}")[:2000]
            completion = {"job_id": job_id, "agent_id": args.agent_id, "ok": ok, "error": error}

            if job_type == "reconcile":
                deleted_count = nonnegative_int(worker_result.get("deleted_count"))
                if ok and deleted_count is not None:
                    completion["deleted_count"] = deleted_count
            elif job_type == "v5_mirror" and ok:
                completion.update({
                    "object_key": str(worker_result.get("object_key") or job["object_key"]),
                    "bytes": nonnegative_int(worker_result.get("bytes")),
                    "etag": str(worker_result.get("etag") or "")[:300],
                })

            try:
                post_json(
                    args.cloner_url,
                    control_path(finish_action),
                    args.ingest_secret,
                    completion,
                    timeout=30,
                )
            except Exception as exc:
                print(f"Warning: could not report job completion: {exc}", file=sys.stderr)

            if ok:
                print(f"Job {job_id} completed.")
            else:
                print(f"Job {job_id} failed with exit code {code}: {error}", file=sys.stderr)

            if args.once:
                return code
        except KeyboardInterrupt:
            print("Reader Agent stopped.")
            return 0
        except Exception as exc:
            print(f"Reader Agent error: {exc}", file=sys.stderr)
            if args.once:
                return 1
            time.sleep(max(5, args.poll_seconds))


if __name__ == "__main__":
    raise SystemExit(main())
