#!/usr/bin/env python3
"""Background Telegram history reader agent.

The Telegram user session stays on this PC. The agent polls the Cloner for queued
history-import and reconcile jobs, launches the matching local worker, and reports
job status back to the server.

No Telegram session, OTP, 2FA password, API hash, or reader secret is uploaded.
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
READER_CAPABILITIES = ["reconcile_v1"]


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


def run_worker(command, cwd, cloner_url, agent_id, job_id, secret, heartbeat_seconds):
    env = os.environ.copy()
    proc = subprocess.Popen(command, cwd=str(cwd), env=env)
    last_heartbeat = 0.0
    while True:
        code = proc.poll()
        now = time.time()
        if now - last_heartbeat >= heartbeat_seconds:
            try:
                post_json(cloner_url, control_path("heartbeat"), secret, {"job_id": job_id, "agent_id": agent_id}, timeout=20)
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

    worker_dir = Path(__file__).resolve().parent
    repo_root = worker_dir.parent
    importer = worker_dir / "export_history.py"
    reconciler = worker_dir / "reconcile_history.py"
    if not importer.exists():
        raise SystemExit(f"Missing importer: {importer}")
    if not reconciler.exists():
        raise SystemExit(f"Missing reconciler: {reconciler}")

    print(f"Reader Agent online: {args.agent_id}")
    print("Telegram session remains local on this PC.")

    while True:
        try:
            result = post_json(
                args.cloner_url,
                control_path("claim"),
                args.ingest_secret,
                {"agent_id": args.agent_id, "capabilities": READER_CAPABILITIES},
                timeout=30,
            )
            job = result.get("job")
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

            if job_type == "reconcile":
                if not source_id:
                    raise RuntimeError("Reconcile job missing source_id")
                command = [
                    sys.executable,
                    str(reconciler),
                    "--source-id",
                    source_id,
                    "--channel",
                    channel,
                    "--cloner-url",
                    args.cloner_url,
                ]
            else:
                job_type = "import"
                command = [sys.executable, str(importer), "--channel", channel, "--cloner-url", args.cloner_url]

            print(f"Claimed {job_type} job {job_id}: {channel}")
            with tempfile.TemporaryDirectory(prefix="tgcloner-reader-") as result_dir:
                result_file = Path(result_dir) / "result.json"
                if job_type == "reconcile":
                    command.extend(["--result-file", str(result_file)])
                code = run_worker(
                    command,
                    repo_root,
                    args.cloner_url,
                    args.agent_id,
                    job_id,
                    args.ingest_secret,
                    max(10, args.heartbeat_seconds),
                )
                worker_result = read_worker_result(result_file)
            ok = code == 0
            error = None if ok else f"{job_type}_exit_{code}"
            completion = {"job_id": job_id, "agent_id": args.agent_id, "ok": ok, "error": error}
            deleted_count = nonnegative_int(worker_result.get("deleted_count"))
            if ok and job_type == "reconcile" and deleted_count is not None:
                completion["deleted_count"] = deleted_count
            try:
                post_json(
                    args.cloner_url,
                    control_path("finish-job"),
                    args.ingest_secret,
                    completion,
                    timeout=30,
                )
            except Exception as exc:
                print(f"Warning: could not report job completion: {exc}", file=sys.stderr)

            if ok:
                print(f"Job {job_id} completed.")
            else:
                print(f"Job {job_id} failed with exit code {code}.", file=sys.stderr)

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
