#!/usr/bin/env python3
"""Background Telegram history reader agent.

The Telegram user session stays on this PC. The agent polls the Cloner for queued
history-import jobs, launches the existing local export_history.py importer, and
reports job status back to the server.

No Telegram session, OTP, 2FA password, API hash, or reader secret is uploaded.
"""
import argparse
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

import requests

DEFAULT_POLL_SECONDS = 15
DEFAULT_HEARTBEAT_SECONDS = 30
READER_CONTROL_PATH = "/api/reader/complete"


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


def run_import(importer, channel, cloner_url, agent_id, job_id, secret, heartbeat_seconds):
    env = os.environ.copy()
    proc = subprocess.Popen(
        [sys.executable, str(importer), "--channel", channel, "--cloner-url", cloner_url],
        cwd=str(importer.parent.parent),
        env=env,
    )
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cloner-url", default=os.getenv("CLONER_URL", "https://telegram-channel-cloner.vercel.app"))
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

    importer = Path(__file__).resolve().parent / "export_history.py"
    if not importer.exists():
        raise SystemExit(f"Missing importer: {importer}")

    print(f"Reader Agent online: {args.agent_id}")
    print("Telegram session remains local on this PC.")

    while True:
        try:
            result = post_json(cloner_url=args.cloner_url, path=control_path("claim"), secret=args.ingest_secret, payload={"agent_id": args.agent_id}, timeout=30)
            job = result.get("job")
            if not job:
                if args.once:
                    return 0
                time.sleep(max(5, args.poll_seconds))
                continue

            job_id = str(job.get("id") or "")
            channel = str(job.get("channel_ref") or "").strip()
            if not job_id or not channel:
                raise RuntimeError("Reader job missing id/channel_ref")

            print(f"Claimed job {job_id}: {channel}")
            code = run_import(importer, channel, args.cloner_url, args.agent_id, job_id, args.ingest_secret, max(10, args.heartbeat_seconds))
            ok = code == 0
            error = None if ok else f"export_history_exit_{code}"
            try:
                post_json(args.cloner_url, control_path("finish-job"), args.ingest_secret, {"job_id": job_id, "agent_id": args.agent_id, "ok": ok, "error": error}, timeout=30)
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
