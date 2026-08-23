"""Managed multi-profile Reader Agent used by the Windows GUI/installer."""
import json
import os
import platform
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import requests
from telethon import TelegramClient
from telethon.sessions import StringSession

from reader_manager_storage import load_config, save_config
from reader_manager_pairing import DEFAULT_CLONER_URL

APP_VERSION = "1.1.0"
CONTROL_PATH = "/api/reader/complete"
CAPABILITIES = ["reconcile_v1", "profiles_v1", "progress_v1"]


def api(config, action, payload=None, timeout=45):
    response = requests.post(
        config.get("cloner_url", DEFAULT_CLONER_URL).rstrip("/") + f"{CONTROL_PATH}?action={action}",
        headers={"Authorization": f"Bearer {config['agent_token']}", "Content-Type": "application/json"},
        data=json.dumps(payload or {}, ensure_ascii=False).encode("utf-8"),
        timeout=timeout,
    )
    if not response.ok:
        try:
            code = response.json().get("error")
        except Exception:
            code = response.text[:300]
        raise RuntimeError(f"{code or 'reader_api_failed'} (HTTP {response.status_code})")
    return response.json()


def profile_for(config, profile_id):
    return next((item for item in config.get("profiles", []) if item.get("id") == profile_id), None)


def worker_command(name):
    executable_name = "YeuNauAnReaderImport.exe" if name == "export_history.py" else "YeuNauAnReaderReconcile.exe"
    installed = Path(sys.executable).resolve().parent / executable_name
    if installed.exists():
        return [str(installed)]
    bundled = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    candidates = [bundled / "reader-cli" / name, Path(__file__).resolve().parents[1] / "reader-cli" / name]
    script = next((path for path in candidates if path.exists()), candidates[-1])
    return [sys.executable, str(script)]


async def verify_access(profile, channel):
    from export_history import resolve_channel
    async with TelegramClient(StringSession(profile["session"]), int(profile["api_id"]), profile["api_hash"]) as client:
        await resolve_channel(client, channel)


def progress_value(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return int(value.get("current", 0)), value.get("total")
    except Exception:
        return None, None


def run_job(config, job, stop_event, status_callback=None):
    profile_id = str(job.get("claimed_reader_profile_id") or job.get("assigned_reader_profile_id") or "")
    profile = profile_for(config, profile_id)
    if not profile:
        raise RuntimeError("reader_profile_local_session_missing")
    channel = str(job.get("channel_ref") or "").strip()
    source_id = str(job.get("source_id") or "")
    job_id = str(job.get("id") or "")
    job_type = str(job.get("job_type") or "import")
    api(config, "profile-status", {"profile_id": profile_id, "status": "busy"})
    if status_callback:
        status_callback(f"Đang kiểm tra quyền truy cập {channel}")
    try:
        import asyncio
        asyncio.run(verify_access(profile, channel))
        api(config, "source-access", {"profile_id": profile_id, "source_id": source_id, "ok": True})
    except Exception as exc:
        api(config, "source-access", {"profile_id": profile_id, "source_id": source_id, "ok": False, "error": "reader_source_access_denied"})
        api(config, "finish-job", {"job_id": job_id, "ok": False, "error": "reader_source_access_denied"})
        api(config, "profile-status", {"profile_id": profile_id, "status": "ready"})
        raise RuntimeError("reader_source_access_denied") from exc

    env = os.environ.copy()
    env.update({
        "TELEGRAM_API_ID": str(profile["api_id"]),
        "TELEGRAM_API_HASH": profile["api_hash"],
        "TELEGRAM_SESSION_STRING": profile["session"],
        "READER_INGEST_SECRET": config["agent_token"],
    })
    with tempfile.TemporaryDirectory(prefix="yeunauan-reader-") as temp_dir:
        temp = Path(temp_dir)
        progress_file = temp / "progress.json"
        result_file = temp / "result.json"
        if job_type == "reconcile":
            command = worker_command("reconcile_history.py") + ["--source-id", source_id, "--channel", channel,
                       "--cloner-url", config.get("cloner_url", DEFAULT_CLONER_URL), "--result-file", str(result_file)]
        else:
            command = worker_command("export_history.py") + ["--channel", channel,
                       "--cloner-url", config.get("cloner_url", DEFAULT_CLONER_URL), "--progress-file", str(progress_file)]
        process = subprocess.Popen(command, env=env)
        last_heartbeat = 0
        while process.poll() is None:
            if stop_event.is_set():
                process.terminate()
                break
            if time.time() - last_heartbeat >= 20:
                current, total = progress_value(progress_file)
                payload = {"job_id": job_id}
                if current is not None:
                    payload["progress_current"] = current
                if isinstance(total, int):
                    payload["progress_total"] = total
                api(config, "job-progress", payload, timeout=20)
                if status_callback and current is not None:
                    status_callback(f"Đang nhập {current} bài từ {channel}")
                last_heartbeat = time.time()
            time.sleep(2)
        code = process.wait()
    ok = code == 0
    api(config, "finish-job", {"job_id": job_id, "ok": ok, "error": None if ok else f"{job_type}_exit_{code}"})
    api(config, "profile-status", {"profile_id": profile_id, "status": "ready"})
    if not ok:
        raise RuntimeError(f"{job_type}_exit_{code}")


def agent_loop(stop_event, status_callback=None):
    while not stop_event.is_set():
        try:
            config = load_config()
            if not config.get("agent_token"):
                stop_event.wait(5)
                continue
            heartbeat = api(config, "heartbeat-agent", {"platform": f"Windows {platform.release()}", "app_version": APP_VERSION})
            remote_profiles = {item.get("id"): item for item in heartbeat.get("profiles", [])}
            changed = False
            retained_profiles = []
            for local_profile in config.get("profiles", []):
                remote = remote_profiles.get(local_profile.get("id"))
                if not remote:
                    changed = True
                    continue
                retained_profiles.append(local_profile)
                if local_profile.get("status") != remote.get("status"):
                    local_profile["status"] = remote.get("status")
                    changed = True
            if changed:
                config["profiles"] = retained_profiles
                save_config(config)
            response = api(config, "claim", {"capabilities": CAPABILITIES}, timeout=30)
            job = response.get("job")
            if job:
                run_job(config, job, stop_event, status_callback)
                config = load_config()
                config["last_success_at"] = int(time.time())
                save_config(config)
            else:
                if status_callback:
                    status_callback("Đã kết nối · đang chờ công việc")
                stop_event.wait(15)
        except Exception as exc:
            if status_callback:
                status_callback(f"Tạm thời chưa kết nối: {exc}")
            stop_event.wait(15)


def start_background(status_callback=None):
    stop_event = threading.Event()
    thread = threading.Thread(target=agent_loop, args=(stop_event, status_callback), daemon=True)
    thread.start()
    return stop_event, thread
