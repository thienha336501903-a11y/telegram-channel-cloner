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

APP_VERSION = "1.3.0"
CONTROL_PATH = "/api/reader/complete"
BASE_CAPABILITIES = ["reconcile_v1", "profiles_v1", "progress_v1", "progress_stage_v1"]
V5_MIRROR_CAPABILITY = "v5_r2_mirror_v1"


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


def local_r2_config(config):
    value = config.get("r2")
    return value if isinstance(value, dict) else {}


def has_v5_r2_config(config):
    r2 = local_r2_config(config)
    return all(str(r2.get(key) or "").strip() for key in ("account_id", "access_key_id", "secret_access_key", "bucket"))


def reader_capabilities(config):
    values = list(BASE_CAPABILITIES)
    if has_v5_r2_config(config):
        values.append(V5_MIRROR_CAPABILITY)
    return values


def worker_command(name):
    executable_names = {
        "export_history.py": "YeuNauAnReaderImport.exe",
        "reconcile_history.py": "YeuNauAnReaderReconcile.exe",
        "mirror_v5_r2.py": "YeuNauAnReaderMirror.exe",
    }
    executable_name = executable_names.get(name)
    if not executable_name:
        raise RuntimeError(f"unknown_reader_worker:{name}")
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


def ready_profiles(config):
    return [
        profile for profile in config.get("profiles", [])
        if profile.get("id") and profile.get("session") and str(profile.get("status") or "ready") == "ready"
    ]


def choose_v5_profile(config, channel, source_id):
    import asyncio
    for profile in ready_profiles(config):
        try:
            asyncio.run(verify_access(profile, channel))
            api(config, "source-access", {"profile_id": profile["id"], "source_id": source_id, "ok": True})
            return profile
        except Exception:
            try:
                api(config, "source-access", {"profile_id": profile["id"], "source_id": source_id, "ok": False, "error": "reader_source_access_denied"})
            except Exception:
                pass
    return None


def progress_value(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return int(value.get("current", 0)), value.get("total")
    except Exception:
        return None, None


def worker_result(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def run_job(config, job, stop_event, status_callback=None):
    channel = str(job.get("channel_ref") or "").strip()
    source_id = str(job.get("source_id") or "")
    job_id = str(job.get("id") or "")
    job_type = str(job.get("job_type") or "import").strip().lower()
    if not job_id or not channel:
        raise RuntimeError("reader_job_missing_identity")

    if job_type == "v5_mirror":
        profile = choose_v5_profile(config, channel, source_id)
        if not profile:
            api(config, "v5-mirror-finish", {"job_id": job_id, "ok": False, "error": "reader_source_access_denied"})
            raise RuntimeError("reader_source_access_denied")
        profile_id = str(profile["id"])
    else:
        profile_id = str(job.get("claimed_reader_profile_id") or job.get("assigned_reader_profile_id") or "")
        profile = profile_for(config, profile_id)
        if not profile:
            raise RuntimeError("reader_profile_local_session_missing")
        api(config, "job-progress", {
            "job_id": job_id,
            "progress_stage": "verifying_source",
            "progress_detail": f"Đang kiểm tra quyền truy cập {channel}",
        })
        if status_callback:
            status_callback(f"Đang kiểm tra quyền truy cập {channel}")
        try:
            import asyncio
            asyncio.run(verify_access(profile, channel))
            api(config, "source-access", {"profile_id": profile_id, "source_id": source_id, "ok": True})
        except Exception as exc:
            api(config, "source-access", {"profile_id": profile_id, "source_id": source_id, "ok": False, "error": "reader_source_access_denied"})
            api(config, "finish-job", {"job_id": job_id, "ok": False, "error": "reader_source_access_denied"})
            raise RuntimeError("reader_source_access_denied") from exc

    api(config, "profile-status", {"profile_id": profile_id, "status": "busy"})
    env = os.environ.copy()
    env.update({
        "TELEGRAM_API_ID": str(profile["api_id"]),
        "TELEGRAM_API_HASH": profile["api_hash"],
        "TELEGRAM_SESSION_STRING": profile["session"],
    })
    if job_type == "v5_mirror":
        env.pop("READER_INGEST_SECRET", None)
        r2 = local_r2_config(config)
        env.update({
            "R2_ACCOUNT_ID": str(r2["account_id"]),
            "R2_ACCESS_KEY_ID": str(r2["access_key_id"]),
            "R2_SECRET_ACCESS_KEY": str(r2["secret_access_key"]),
            "R2_BUCKET": str(r2["bucket"]),
        })
    else:
        env["READER_INGEST_SECRET"] = config["agent_token"]

    try:
        with tempfile.TemporaryDirectory(prefix="yeunauan-reader-") as temp_dir:
            temp = Path(temp_dir)
            progress_file = temp / "progress.json"
            result_file = temp / "result.json"
            if job_type == "reconcile":
                command = worker_command("reconcile_history.py") + ["--source-id", source_id, "--channel", channel,
                           "--cloner-url", config.get("cloner_url", DEFAULT_CLONER_URL), "--result-file", str(result_file)]
                stage = "reconciling"
            elif job_type == "v5_mirror":
                if not has_v5_r2_config(config):
                    raise RuntimeError("v5_r2_config_missing")
                command = worker_command("mirror_v5_r2.py") + [
                    "--channel", channel,
                    "--message-id", str(int(job.get("source_message_id") or 0)),
                    "--asset-id", str(job.get("asset_id") or ""),
                    "--object-key", str(job.get("object_key") or ""),
                    "--original-filename", str(job.get("original_filename") or "telegram-media"),
                    "--mime-type", str(job.get("mime_type") or "application/octet-stream"),
                    "--expected-bytes", str(int(job.get("expected_bytes") or 0)),
                    "--result-file", str(result_file),
                ]
                stage = "mirroring_r2"
            else:
                job_type = "import"
                command = worker_command("export_history.py") + ["--channel", channel,
                           "--cloner-url", config.get("cloner_url", DEFAULT_CLONER_URL), "--progress-file", str(progress_file)]
                stage = "reading_history"

            if job_type != "v5_mirror":
                api(config, "job-progress", {
                    "job_id": job_id,
                    "progress_stage": stage,
                    "progress_detail": "Đang đối chiếu lịch sử kênh" if job_type == "reconcile" else "Đang đọc lịch sử kênh Telegram",
                })
            if status_callback:
                status_callback("Đang sao lưu video sang R2" if job_type == "v5_mirror" else f"Đang xử lý {channel}")

            process = subprocess.Popen(command, env=env)
            last_heartbeat = 0
            while process.poll() is None:
                if stop_event.is_set():
                    process.terminate()
                    break
                if time.time() - last_heartbeat >= 10:
                    if job_type == "v5_mirror":
                        api(config, "v5-mirror-heartbeat", {"job_id": job_id}, timeout=20)
                        if status_callback:
                            status_callback(f"Đang sao lưu media V5 từ {channel}")
                    else:
                        current, total = progress_value(progress_file)
                        payload = {"job_id": job_id}
                        if current is not None:
                            payload["progress_current"] = current
                        if isinstance(total, int):
                            payload["progress_total"] = total
                        payload["progress_stage"] = stage
                        payload["progress_detail"] = (
                            f"Đã xử lý {current} bài" if current is not None else
                            ("Đang đối chiếu lịch sử kênh" if job_type == "reconcile" else "Đang đọc lịch sử kênh Telegram")
                        )
                        api(config, "job-progress", payload, timeout=20)
                        if status_callback and current is not None:
                            status_callback(f"Đang nhập {current} bài từ {channel}")
                    last_heartbeat = time.time()
                time.sleep(2)
            code = process.wait()
            result = worker_result(result_file)
            current, total = progress_value(progress_file)

        if job_type == "v5_mirror":
            ok = code == 0 and result.get("ok") is True
            error = None if ok else str(result.get("error") or f"v5_mirror_exit_{code}")[:2000]
            completion = {"job_id": job_id, "ok": ok, "error": error}
            if ok:
                completion["object_key"] = str(result.get("object_key") or job.get("object_key") or "")
                bytes_value = result.get("bytes")
                if isinstance(bytes_value, int) and not isinstance(bytes_value, bool) and bytes_value >= 0:
                    completion["bytes"] = bytes_value
                completion["etag"] = str(result.get("etag") or "")[:300]
            api(config, "v5-mirror-finish", completion)
        else:
            ok = code == 0
            message_count = current if job_type == "import" and current is not None else result.get("indexed_message_count")
            completion = {"job_id": job_id, "ok": ok, "error": None if ok else f"{job_type}_exit_{code}"}
            if isinstance(message_count, int) and message_count >= 0:
                completion["message_count"] = message_count
            deleted_count = result.get("deleted_count")
            if isinstance(deleted_count, int) and deleted_count >= 0:
                completion["deleted_count"] = deleted_count
            api(config, "finish-job", completion)

        if not ok:
            raise RuntimeError(error if job_type == "v5_mirror" else f"{job_type}_exit_{code}")
    finally:
        try:
            api(config, "profile-status", {"profile_id": profile_id, "status": "ready"})
        except Exception:
            pass


def claim_next_job(config):
    capabilities = reader_capabilities(config)
    response = api(config, "claim", {"capabilities": capabilities}, timeout=30)
    job = response.get("job")
    if job or V5_MIRROR_CAPABILITY not in capabilities:
        return job
    return api(config, "v5-mirror-claim", {"capabilities": capabilities}, timeout=30).get("job")


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
            job = claim_next_job(config)
            if job:
                run_job(config, job, stop_event, status_callback)
                config = load_config()
                config["last_success_at"] = int(time.time())
                save_config(config)
            else:
                if status_callback:
                    suffix = " · R2 V5 sẵn sàng" if has_v5_r2_config(config) else ""
                    status_callback("Đã kết nối · đang chờ công việc" + suffix)
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
