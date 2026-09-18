"""Managed multi-profile Reader Agent used by the Windows GUI/installer."""
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

try:
    import requests
except ImportError:
    requests = None

try:
    from telethon import TelegramClient
    from telethon.sessions import StringSession
except ImportError:
    TelegramClient = None
    StringSession = None

from reader_manager_storage import load_config, save_config
from reader_manager_pairing import DEFAULT_CLONER_URL

APP_VERSION = "1.4.7"
CONTROL_PATH = "/api/reader/complete"
BASE_CAPABILITIES = ["reconcile_v1", "profiles_v1", "progress_v1", "progress_stage_v1", "benchmark_concurrency_v1"]
V5_MIRROR_CAPABILITY = "v5_r2_mirror_v1"
SMALL_IMAGE_MAX_BYTES = 8 * 1024 * 1024
SMALL_IMAGE_STALL_SECONDS = 60

_ACTIVE_MIRRORS = {}
_ACTIVE_MIRRORS_LOCK = threading.Lock()
_ACTIVE_SUBPROCESSES = {}
_CONFIG_WRITE_LOCK = threading.Lock()
_BACKOFF_LOCK = threading.Lock()
_MIRROR_BACKOFF_UNTIL = 0
_MIRROR_DEGRADED_UNTIL = 0


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


def one_shot_v5_enabled():
    value = str(os.environ.get("YEUNAUAN_READER_V5_ONE_SHOT") or "").strip().lower()
    return value in ("1", "true", "yes", "on")


def required_job_attempt(job):
    value = job.get("attempt") if isinstance(job, dict) else None
    if value is None or isinstance(value, bool):
        raise RuntimeError("v5_mirror_attempt_required")
    if isinstance(value, str):
        stripped = value.strip()
        if not re.fullmatch(r"[1-9]\d*", stripped):
            raise RuntimeError("v5_mirror_attempt_required")
        parsed = int(stripped)
    elif isinstance(value, int):
        parsed = value
    elif isinstance(value, float) and value.is_integer():
        parsed = int(value)
    else:
        raise RuntimeError("v5_mirror_attempt_required")
    if parsed < 1:
        raise RuntimeError("v5_mirror_attempt_required")
    return parsed


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


def ready_profiles(config, allow_busy=False):
    return [
        profile for profile in config.get("profiles", [])
        if profile.get("id") and profile.get("session") and (
            str(profile.get("status") or "ready") == "ready"
            or (allow_busy and str(profile.get("status") or "ready") == "busy")
        )
    ]


_SOURCE_ACCESS_CACHE = {}  # (source_id, channel, profile_id) -> timestamp
SOURCE_ACCESS_CACHE_TTL = 240  # 4 minutes
_LAST_SOURCE_ACCESS_ERROR = None


def invalidate_source_access_cache(source_id=None, channel=None, profile_id=None):
    global _SOURCE_ACCESS_CACHE
    if source_id is None and channel is None and profile_id is None:
        _SOURCE_ACCESS_CACHE.clear()
        return
    keys_to_remove = [
        k for k in _SOURCE_ACCESS_CACHE
        if (source_id is None or k[0] == str(source_id))
        and (channel is None or k[1] == str(channel))
        and (profile_id is None or k[2] == str(profile_id))
    ]
    for k in keys_to_remove:
        _SOURCE_ACCESS_CACHE.pop(k, None)


def classify_telegram_error(error):
    """Map Telegram/network exceptions to structured error taxonomy without disclosing secrets."""
    if error is None:
        return "reader_source_access_denied"
    err_type = type(error).__name__ if isinstance(error, Exception) else ""
    text = str(error or "").strip()
    lower_text = text.lower()

    # 1. FloodWait
    if "floodwait" in lower_text or "flood_wait" in lower_text or err_type == "FloodWaitError":
        wait_match = re.search(r"(\d+)\s*(?:seconds?|secs?|s)\b", lower_text)
        seconds = wait_match.group(1) if wait_match else "30"
        return f"reader_source_access_flood_wait_{seconds}s"

    # 2. Unauthorized / Session revoked / Invalid
    if any(k in lower_text for k in ("unauthorized", "sessionpasswordneeded", "phonenumberunoccupied", "userdeactivated", "session_revoked")) or err_type in ("SessionPasswordNeededError", "UnauthorizedError"):
        return "reader_source_access_unauthorized"

    # 3. Forbidden / Channel Private
    if any(k in lower_text for k in ("forbidden", "channelprivate", "channel_private", "channel_invalid")) or err_type in ("ChannelPrivateError", "ChannelInvalidError"):
        return "reader_source_access_forbidden"

    # 4. Chat Admin Required
    if "chatadminrequired" in lower_text or "chat_admin_required" in lower_text or err_type == "ChatAdminRequiredError":
        return "reader_source_access_chat_admin_required"

    # 5. AuthKey / Session invalid
    if any(k in lower_text for k in ("authkey", "auth_key", "session_invalid", "security error")) or "auth" in err_type.lower():
        return "reader_source_access_session_invalid"

    # 6. Network / Timeout
    if any(k in lower_text for k in ("timeout", "timed out", "connection reset", "connectionerror", "temporarily unavailable")) or "Timeout" in err_type or "Connection" in err_type:
        return "reader_source_access_network_timeout"

    # 7. Source missing / Username not occupied
    if any(k in lower_text for k in ("usernamenotoccupied", "username_not_occupied", "source_missing", "channel_missing", "entity not found")) or err_type == "UsernameNotOccupiedError":
        return "reader_source_access_source_missing"

    # 8. Specific RPC error class
    if "rpcerror" in lower_text or "rpc" in err_type.lower():
        clean_cls = err_type.replace("Error", "").strip()
        if not clean_cls or clean_cls == "Exception":
            clean_cls = "rpc_generic"
        return f"reader_source_access_rpc_error_{clean_cls.lower()}"

    return "reader_source_access_denied"


def terminate_and_kill_process(p, term_timeout=5, kill_timeout=2):
    """Terminate child process cleanly; if still alive after timeout, kill it forcefully and ensure stopped."""
    if p is None or p.poll() is not None:
        return True
    try:
        p.terminate()
    except Exception:
        pass
    try:
        p.wait(timeout=term_timeout)
    except Exception:
        try:
            p.kill()
            p.wait(timeout=kill_timeout)
        except Exception:
            if os.name == "nt" and p.poll() is None:
                try:
                    subprocess.run(["taskkill", "/PID", str(int(p.pid)), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                    p.wait(timeout=2)
                except Exception:
                    pass
    return p.poll() is not None


def small_image_job(job):
    expected = int(job.get("expected_bytes") or 0)
    filename = str(job.get("original_filename") or "").lower()
    mime = str(job.get("mime_type") or "").lower()
    return (0 < expected <= SMALL_IMAGE_MAX_BYTES and (
        mime.startswith("image/") or job.get("media_variant") == "thumbnail"
        or filename.endswith((".jpg", ".jpeg", ".png", ".webp", ".gif"))
    ))


def progress_signature(path):
    current, total, stage = progress_info(path)
    return (stage, current, total) if stage is not None else None


def finish_size_rejected(exc):
    return "v5_mirror_size_mismatch:" in str(exc)


def rejected_success_completion(completion):
    return {
        "job_id": completion["job_id"], "attempt": completion["attempt"],
        "ok": False, "error": "mirror_finish_size_mismatch"
    }


def save_finish_failure_log(job_id, failure_record):
    """Persist structured finish API failure details to local diagnostic log."""
    try:
        log_dir = Path(__file__).resolve().parent / ".finish-failures"
        log_dir.mkdir(parents=True, exist_ok=True)
        clean_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(job_id or "unknown"))
        log_path = log_dir / f"failure_{clean_id}.json"
        log_path.write_text(json.dumps(failure_record, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def save_finish_warning_log(job_id, warning_record):
    """Persist structured finish warning details to local diagnostic log."""
    try:
        log_dir = Path(__file__).resolve().parent / ".finish-warnings"
        log_dir.mkdir(parents=True, exist_ok=True)
        clean_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(job_id or "unknown"))
        log_path = log_dir / f"warning_{clean_id}.json"
        log_path.write_text(json.dumps(warning_record, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def finish_outbox_dir():
    outbox = Path(__file__).resolve().parent / ".finish-outbox"
    outbox.mkdir(parents=True, exist_ok=True)
    return outbox


def save_pending_finish(job_id, completion_payload):
    """Save an unconfirmed finish completion to local outbox for recovery retry."""
    try:
        outbox = finish_outbox_dir()
        clean_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(job_id or "unknown"))
        item_path = outbox / f"finish_{clean_id}.json"
        attempt = completion_payload.get("attempt") if isinstance(completion_payload, dict) else None
        item_path.write_text(json.dumps({
            "job_id": job_id,
            "attempt": attempt,
            "completion": completion_payload,
            "saved_at": time.time(),
            "attempts": 0
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def remove_pending_finish(job_id):
    """Remove a successfully confirmed finish item from local outbox."""
    try:
        outbox = finish_outbox_dir()
        clean_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(job_id or "unknown"))
        item_path = outbox / f"finish_{clean_id}.json"
        item_path.unlink(missing_ok=True)
    except Exception:
        pass


def list_pending_finishes():
    """List all pending unconfirmed finishes in outbox."""
    try:
        outbox = finish_outbox_dir()
        items = []
        for p in outbox.glob("finish_*.json"):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("job_id"):
                    items.append((p, data))
            except Exception:
                pass
        return items
    except Exception:
        return []


def flush_pending_finishes(config):
    """Attempt to replay and drain pending finish submissions before claiming new jobs."""
    items = list_pending_finishes()
    if not items:
        return 0
    replayed = 0
    for path_obj, item in items:
        job_id = item.get("job_id")
        completion = item.get("completion")
        if not job_id or not completion:
            path_obj.unlink(missing_ok=True)
            continue
        attempt = completion.get("attempt") or item.get("attempt")
        if not attempt:
            print(f"Dropping outbox item without attempt for job {job_id}", flush=True)
            path_obj.unlink(missing_ok=True)
            continue
        completion["attempt"] = int(attempt)
        try:
            print(f"Retrying pending finish from outbox for job {job_id}...", flush=True)
            finish_res = api(config, "v5-mirror-finish", completion, timeout=20)
            path_obj.unlink(missing_ok=True)
            if isinstance(finish_res, dict) and finish_res.get("warning") == "finish_committed_metadata_incomplete":
                print(f"[WARN] finish_committed_metadata_incomplete on replayed finish for job {job_id}. Finish RPC committed; DB metadata enrichment incomplete. Do NOT retry finish RPC.", flush=True)
                save_finish_warning_log(job_id, {
                    "job_id": job_id,
                    "attempt": int(attempt),
                    "warning": "finish_committed_metadata_incomplete",
                    "response": finish_res,
                    "timestamp": time.time()
                })
            replayed += 1
            print(f"Successfully replayed pending finish for job {job_id}.", flush=True)
        except Exception as exc:
            err_str = str(exc)
            if any(term in err_str for term in ("v5_mirror_lease_fenced", "not_owned", "v5_mirror_job_not_owned", "409", "410")):
                print(f"Dropping obsolete pending finish for job {job_id}: {exc}", flush=True)
                path_obj.unlink(missing_ok=True)
            elif completion.get("ok") is True and finish_size_rejected(exc):
                # The success payload cannot ever pass strict server validation.
                # Release this exact attempt via the canonical finish RPC, so a
                # retry can fetch the indexed Telegram photo size instead.
                failure = rejected_success_completion(completion)
                save_pending_finish(job_id, failure)
                try:
                    api(config, "v5-mirror-finish", failure, timeout=20)
                    remove_pending_finish(job_id)
                    replayed += 1
                except Exception as release_exc:
                    print(f"Pending failed finish for job {job_id}: {release_exc}", flush=True)
                    break
            else:
                print(f"Pending finish retry for job {job_id} failed: {exc}", flush=True)
                break
    return replayed


def choose_v5_profile(config, channel, source_id, allow_busy=False):
    global _LAST_SOURCE_ACCESS_ERROR
    _LAST_SOURCE_ACCESS_ERROR = None
    import asyncio
    now = time.time()
    for profile in ready_profiles(config, allow_busy=allow_busy):
        profile_id = str(profile.get("id") or "")
        cache_key = (str(source_id), str(channel), profile_id)
        if cache_key in _SOURCE_ACCESS_CACHE and (now - _SOURCE_ACCESS_CACHE[cache_key]) < SOURCE_ACCESS_CACHE_TTL:
            return profile
        try:
            asyncio.run(asyncio.wait_for(verify_access(profile, channel), timeout=30))
            _SOURCE_ACCESS_CACHE[cache_key] = now
            api(config, "source-access", {"profile_id": profile["id"], "source_id": source_id, "ok": True}, timeout=15)
            return profile
        except Exception as exc:
            _SOURCE_ACCESS_CACHE.pop(cache_key, None)
            err_code = classify_telegram_error(exc)
            _LAST_SOURCE_ACCESS_ERROR = err_code
            try:
                api(config, "source-access", {"profile_id": profile["id"], "source_id": source_id, "ok": False, "error": err_code}, timeout=15)
            except Exception:
                pass
    return None


def progress_value(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return int(value.get("current", 0)), value.get("total")
    except Exception:
        return None, None


def progress_info(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        current = int(value.get("current", 0)) if "current" in value else None
        total = int(value.get("total")) if value.get("total") is not None else None
        stage = str(value.get("stage") or "") or None
        return current, total, stage
    except Exception:
        return None, None, None


def progress_telemetry(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            return {}
        return {
            "current": int(value.get("current", 0)) if "current" in value else None,
            "total": int(value.get("total")) if value.get("total") is not None else None,
            "stage": str(value.get("stage") or "") or None,
            "bytes_per_second": int(value.get("bytes_per_second", 0)) if value.get("bytes_per_second") is not None else None,
            "mb_per_second": float(value.get("mb_per_second", 0)) if value.get("mb_per_second") is not None else None,
            "eta_seconds": float(value.get("eta_seconds", 0)) if value.get("eta_seconds") is not None else None,
            "percent": float(value.get("percent", 0)) if value.get("percent") is not None else None,
        }
    except Exception:
        return {}


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

    parsed_job_attempt = required_job_attempt(job) if job_type == "v5_mirror" else None

    if job_type == "v5_mirror":
        is_benchmark = bool(job.get("benchmark"))
        profile = choose_v5_profile(config, channel, source_id, allow_busy=is_benchmark)
        if not profile:
            access_err = _LAST_SOURCE_ACCESS_ERROR or "reader_source_access_denied"
            failure = {
                "job_id": job_id,
                "ok": False,
                "error": access_err,
                "attempt": parsed_job_attempt
            }
            save_pending_finish(job_id, failure)
            api(config, "v5-mirror-finish", failure)
            remove_pending_finish(job_id)
            raise RuntimeError(access_err)
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
            err_code = classify_telegram_error(exc)
            api(config, "source-access", {"profile_id": profile_id, "source_id": source_id, "ok": False, "error": err_code})
            api(config, "finish-job", {"job_id": job_id, "ok": False, "error": err_code})
            raise RuntimeError(err_code) from exc

    try:
        api(config, "profile-status", {"profile_id": profile_id, "status": "busy"})
    except Exception:
        if job_type == "v5_mirror":
            failure = {"job_id": job_id, "attempt": parsed_job_attempt,
                       "ok": False, "error": "reader_profile_busy_update_failed"}
            save_pending_finish(job_id, failure)
            try:
                api(config, "v5-mirror-finish", failure, timeout=20)
                remove_pending_finish(job_id)
            except Exception:
                pass
        raise
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
                    "--media-variant", str(job.get("media_variant") or "media"),
                    "--progress-file", str(progress_file),
                    "--result-file", str(result_file),
                    "--attempt", str(parsed_job_attempt),
                    "--start-time", str(time.time()),
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

            popen_kwargs = {}
            if os.name == "nt":
                popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

            process = subprocess.Popen(command, env=env, **popen_kwargs)
            with _ACTIVE_MIRRORS_LOCK:
                _ACTIVE_SUBPROCESSES[job_id] = process
            last_heartbeat = 0
            consecutive_heartbeat_failures = 0
            max_heartbeat_failures = 3
            lease_lost = False
            watchdog_abort = False
            stalled_since = time.monotonic()
            last_signature = None
            while process.poll() is None:
                if stop_event.is_set():
                    if not terminate_and_kill_process(process):
                        raise RuntimeError("reader_shutdown_child_termination_unconfirmed")
                    break
                now_ts = time.time()
                if job_type == "v5_mirror" and small_image_job(job):
                    signature = progress_signature(progress_file)
                    if signature != last_signature:
                        last_signature = signature
                        stalled_since = time.monotonic()
                    elif time.monotonic() - stalled_since >= SMALL_IMAGE_STALL_SECONDS:
                        print(f"[WARN] Small image job {job_id} stalled at {signature}; terminating child.", flush=True)
                        if not terminate_and_kill_process(process):
                            stop_event.set()  # Fail closed: never claim while the old child may upload.
                            raise RuntimeError("reader_watchdog_child_termination_unconfirmed")
                        watchdog_abort = True
                        break
                heartbeat_interval = 2.5 if job_type == "v5_mirror" else 10
                if now_ts - last_heartbeat >= heartbeat_interval:
                    if job_type == "v5_mirror":
                        current, total, stage = progress_info(progress_file)
                        telem = progress_telemetry(progress_file)
                        payload = {
                            "job_id": job_id,
                            "attempt": parsed_job_attempt
                        }
                        if current is not None:
                            payload["progress_current"] = current
                        if total is not None:
                            payload["progress_total"] = total
                        if telem.get("stage"):
                            payload["progress_stage"] = telem["stage"]
                        if telem.get("bytes_per_second") is not None:
                            payload["bytes_per_second"] = telem["bytes_per_second"]
                        if telem.get("eta_seconds") is not None:
                            payload["eta_seconds"] = telem["eta_seconds"]
                        try:
                            api(config, "v5-mirror-heartbeat", payload, timeout=20)
                            consecutive_heartbeat_failures = 0
                            if status_callback:
                                stage_desc = "Đang tải Telegram" if stage == "telegram_download" else ("Đang upload R2" if stage == "r2_upload" else ("Đang xử lý Faststart" if stage == "faststart_remux" else "Đang sao lưu media V5"))
                                detail_str = f" ({current // 1048576} MB / {total // 1048576} MB)" if (current and total) else ""
                                rate_str = f" @ {telem['mb_per_second']} MB/s" if telem.get("mb_per_second") else ""
                                eta_str = f" · còn {int(telem['eta_seconds'])}s" if telem.get("eta_seconds") else ""
                                status_callback(f"{stage_desc}{detail_str}{rate_str}{eta_str} từ {channel}")
                        except Exception as hb_exc:
                            consecutive_heartbeat_failures += 1
                            err_msg = str(hb_exc)
                            is_fenced = "v5_mirror_lease_fenced" in err_msg or "v5_mirror_job_not_owned" in err_msg
                            print(f"[WARN] V5 mirror heartbeat failure {consecutive_heartbeat_failures}/{max_heartbeat_failures} for job {job_id}: {hb_exc}", flush=True)
                            if is_fenced or consecutive_heartbeat_failures >= max_heartbeat_failures:
                                lease_lost = True
                                print(f"[CRITICAL] Lease lost or heartbeat failure budget exhausted for job {job_id}. Supervising child worker termination.", flush=True)
                                if not terminate_and_kill_process(process):
                                    stop_event.set()
                                    raise RuntimeError("reader_lease_lost_child_termination_unconfirmed")
                                break
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
                time.sleep(1 if job_type == "v5_mirror" else 2)
            code = process.wait()
            with _ACTIVE_MIRRORS_LOCK:
                _ACTIVE_SUBPROCESSES.pop(job_id, None)
            result = worker_result(result_file)
            current, total = progress_value(progress_file)

        if job_type == "v5_mirror":
            if lease_lost:
                print(f"[ERROR] Job {job_id} aborted due to heartbeat lease failure. Not submitting success.", flush=True)
                try:
                    failure = {
                        "job_id": job_id,
                        "ok": False,
                        "error": "heartbeat_lease_lost",
                        "attempt": parsed_job_attempt
                    }
                    save_pending_finish(job_id, failure)
                    api(config, "v5-mirror-finish", failure)
                    remove_pending_finish(job_id)
                except Exception:
                    pass
                raise RuntimeError("heartbeat_lease_lost")

            ok = not watchdog_abort and code == 0 and result.get("ok") is True
            error = None if ok else ("reader_small_image_stalled" if watchdog_abort else str(result.get("error") or f"v5_mirror_exit_{code}")[:2000])
            if not ok and error and any(term in error.lower() for term in ("access_denied", "channelprivate", "chatadminrequired", "authkey", "userdeactivated", "session")):
                invalidate_source_access_cache(source_id, channel, profile_id)
            completion = {
                "job_id": job_id,
                "ok": ok,
                "error": error,
                "attempt": parsed_job_attempt
            }
            telem = result.get("telemetry") or {}
            if ok:
                completion["object_key"] = str(result.get("object_key") or job.get("object_key") or "")
                bytes_value = result.get("bytes")
                if isinstance(bytes_value, int) and not isinstance(bytes_value, bool) and bytes_value >= 0:
                    completion["bytes"] = bytes_value
                source_bytes_val = result.get("source_bytes")
                if isinstance(source_bytes_val, int) and not isinstance(source_bytes_val, bool) and source_bytes_val >= 0:
                    completion["source_bytes"] = source_bytes_val
                final_bytes_val = result.get("final_bytes") or bytes_value
                if isinstance(final_bytes_val, int) and not isinstance(final_bytes_val, bool) and final_bytes_val >= 0:
                    completion["final_bytes"] = final_bytes_val
                if result.get("transform_version"):
                    completion["transform_version"] = str(result.get("transform_version"))
                if result.get("checksum_sha256"):
                    completion["checksum_sha256"] = str(result.get("checksum_sha256"))
                completion["etag"] = str(result.get("etag") or "")[:300]
            if telem:
                completion["telemetry"] = telem

            finish_start = time.time()
            save_pending_finish(job_id, completion)
            try:
                finish_res = api(config, "v5-mirror-finish", completion)
                remove_pending_finish(job_id)
                if isinstance(finish_res, dict) and finish_res.get("warning") == "finish_committed_metadata_incomplete":
                    print(f"[WARN] finish_committed_metadata_incomplete for job {job_id}. Finish RPC committed; DB metadata enrichment incomplete. Do NOT retry finish RPC.", flush=True)
                    save_finish_warning_log(job_id, {
                        "job_id": job_id,
                        "attempt": completion.get("attempt"),
                        "warning": "finish_committed_metadata_incomplete",
                        "response": finish_res,
                        "timestamp": time.time()
                    })
            except Exception as finish_exc:
                if ok and finish_size_rejected(finish_exc):
                    failure = rejected_success_completion(completion)
                    save_pending_finish(job_id, failure)
                    try:
                        api(config, "v5-mirror-finish", failure, timeout=20)
                        remove_pending_finish(job_id)
                    except Exception as release_exc:
                        print(f"[WARN] Failed to release rejected mirror result for job {job_id}: {release_exc}", flush=True)
                failure_record = {
                    "job_id": job_id,
                    "attempt": parsed_job_attempt,
                    "error": str(finish_exc)[:1000],
                    "object_key": completion.get("object_key"),
                    "bytes": completion.get("bytes"),
                    "telemetry": telem,
                    "timestamp": time.time(),
                }
                save_finish_failure_log(job_id, failure_record)
                print(f"V5 mirror finish API call failed for job {job_id}: {finish_exc}. Local failure and outbox logged.", flush=True)
                raise

            finish_ms = int((time.time() - finish_start) * 1000)
            if "timings_ms" in telem:
                telem["timings_ms"]["finish_ms"] = finish_ms

            timings = telem.get("timings_ms") or {}
            if ok:
                print(f"V5 mirror job {job_id} succeeded in {telem.get('total_worker_time_ms', 0)}ms. Timings: {timings}", flush=True)
            else:
                print(f"V5 mirror job {job_id} failed: {error}. Timings: {timings}", flush=True)
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
        if 'process' in locals() and process and process.poll() is None:
            if not terminate_and_kill_process(process):
                stop_event.set()
        with _ACTIVE_MIRRORS_LOCK:
            _ACTIVE_SUBPROCESSES.pop(job_id, None)
            _ACTIVE_MIRRORS.pop(job_id, None)
        try:
            if not is_profile_in_use(profile_id, exclude_job_id=job_id):
                api(config, "profile-status", {"profile_id": profile_id, "status": "ready"})
        except Exception:
            pass


def claim_generic_job(config):
    capabilities = reader_capabilities(config)
    response = api(config, "claim", {"capabilities": capabilities}, timeout=30)
    return response.get("job")


def claim_v5_job(config):
    capabilities = reader_capabilities(config)
    if V5_MIRROR_CAPABILITY not in capabilities:
        return None
    return api(config, "v5-mirror-claim", {"capabilities": capabilities}, timeout=30).get("job")


def claim_next_job(config):
    """Compatibility helper: preserves generic priority."""
    job = claim_generic_job(config)
    return job if job else claim_v5_job(config)


def is_profile_in_use(profile_id, exclude_job_id=None):
    if not profile_id:
        return False
    with _ACTIVE_MIRRORS_LOCK:
        for j_id, info in _ACTIVE_MIRRORS.items():
            if j_id != exclude_job_id and info.get("profile_id") == profile_id:
                return True
    return False


def active_mirror_stats():
    with _ACTIVE_MIRRORS_LOCK:
        total = len(_ACTIVE_MIRRORS)
        has_prod = any(not info.get("benchmark") for info in _ACTIVE_MIRRORS.values())
        benchmark_count = sum(1 for info in _ACTIVE_MIRRORS.values() if info.get("benchmark"))
        return total, has_prod, benchmark_count


def rate_limit_wait_seconds(error):
    text = str(error or "").lower()
    is_flood = any(term in text for term in (
        "floodwait",
        "flood_wait",
        "flood wait",
        "too many requests",
        "rpcerror 420",
        "wait of ",
    ))
    if is_flood:
        matches = re.findall(r"(\d{1,5})\s*(?:seconds?|secs?|s)\b", text)
        wait = int(matches[-1]) if matches else 60
        return max(30, min(900, wait + 5)), 15 * 60
    if any(term in text for term in ("timeout", "timed out", "connection reset", "temporarily unavailable")):
        return 30, 5 * 60
    return None, None


def apply_mirror_backpressure(error):
    global _MIRROR_BACKOFF_UNTIL, _MIRROR_DEGRADED_UNTIL
    wait_seconds, degraded_seconds = rate_limit_wait_seconds(error)
    if wait_seconds is None:
        return False
    now = time.time()
    with _BACKOFF_LOCK:
        _MIRROR_BACKOFF_UNTIL = max(_MIRROR_BACKOFF_UNTIL, now + wait_seconds)
        _MIRROR_DEGRADED_UNTIL = max(_MIRROR_DEGRADED_UNTIL, now + degraded_seconds)
    return True


def mirror_backoff_remaining():
    with _BACKOFF_LOCK:
        return max(0, int(_MIRROR_BACKOFF_UNTIL - time.time()))


def can_claim_mirror():
    """
    Return (can_claim: bool, slot_type: str | None)
    Enforces:
    1. Production mirror concurrency strictly = 1
    2. Benchmark mirror concurrency max = 2
    3. Backoff on rate limit
    """
    now = time.time()
    with _BACKOFF_LOCK:
        if now < _MIRROR_BACKOFF_UNTIL:
            return False, None
        degraded = now < _MIRROR_DEGRADED_UNTIL

    total, has_prod, benchmark_count = active_mirror_stats()

    # Rule 1: If any production job is running, concurrency is strictly 1.
    if has_prod:
        return False, None

    # Rule 2: If degraded due to recent rate-limit/FloodWait, concurrency is capped at 1.
    if degraded and total >= 1:
        return False, None

    # Rule 3: Total active mirrors cannot exceed 2 under any circumstances.
    if total >= 2 or benchmark_count >= 2:
        return False, None

    # Rule 4: If 1 benchmark mirror is currently active, only a second BENCHMARK job is allowed.
    if benchmark_count == 1:
        return True, "benchmark_only"

    # Rule 5: If 0 mirrors active, any job (production or benchmark) is allowed.
    return True, "any"


def record_last_success():
    with _CONFIG_WRITE_LOCK:
        try:
            cfg = load_config()
            cfg["last_success_at"] = int(time.time())
            save_config(cfg)
        except Exception:
            pass


def mirror_worker(config, job, stop_event, status_callback=None):
    job_id = str(job.get("id") or "")
    try:
        run_job(config, job, stop_event, status_callback)
        record_last_success()
    except Exception as exc:
        limited = apply_mirror_backpressure(exc)
        if status_callback:
            if limited:
                status_callback(f"Telegram đang giới hạn tạm thời · Reader tự giảm tốc ({str(exc)[:80]})")
            else:
                status_callback(f"Mirror tạm lỗi: {str(exc)[:160]}")
    finally:
        with _ACTIVE_MIRRORS_LOCK:
            _ACTIVE_MIRRORS.pop(job_id, None)
            _ACTIVE_SUBPROCESSES.pop(job_id, None)


def start_mirror_job(config, job, stop_event, status_callback=None):
    job_id = str(job.get("id") or "")
    if not job_id:
        raise RuntimeError("reader_job_missing_identity")
    channel = str(job.get("channel_ref") or "").strip()
    source_id = str(job.get("source_id") or "")
    is_benchmark = bool(job.get("benchmark"))
    profile = choose_v5_profile(config, channel, source_id, allow_busy=is_benchmark)
    profile_id = str(profile["id"]) if profile else ""

    thread = threading.Thread(
        target=mirror_worker,
        args=(config, job, stop_event, status_callback),
        daemon=True,
        name=f"v5-mirror-{job_id[:8]}"
    )
    with _ACTIVE_MIRRORS_LOCK:
        if job_id in _ACTIVE_MIRRORS:
            raise RuntimeError("v5_mirror_job_already_active")
        _ACTIVE_MIRRORS[job_id] = {
            "thread": thread,
            "benchmark": is_benchmark,
            "profile_id": profile_id,
            "started_at": time.time()
        }
    thread.start()
    return thread


def terminate_all_subprocesses():
    with _ACTIVE_MIRRORS_LOCK:
        procs = list(_ACTIVE_SUBPROCESSES.values())
    for p in procs:
        try:
            p.terminate()
        except Exception:
            pass
    for p in procs:
        try:
            p.wait(timeout=5)
        except Exception:
            try:
                p.kill()
                p.wait(timeout=2)
            except Exception:
                pass


def wait_for_active_mirrors(timeout=10):
    deadline = time.time() + max(0, float(timeout))
    while time.time() < deadline:
        with _ACTIVE_MIRRORS_LOCK:
            threads = [info.get("thread") for info in _ACTIVE_MIRRORS.values() if info.get("thread")]
        if not threads:
            return True
        for thread in threads:
            try:
                thread.join(timeout=min(0.25, max(0, deadline - time.time())))
            except Exception:
                pass
    return active_mirror_stats()[0] == 0


def sync_remote_profiles(config):
    try:
        heartbeat = api(
            config,
            "heartbeat-agent",
            {"platform": f"Windows {platform.release()}", "app_version": APP_VERSION},
        )
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
            with _CONFIG_WRITE_LOCK:
                save_config(config)
    except Exception:
        pass
    return config


def recover_busy_profiles_for_one_shot(config):
    """Recover stale local profile state only in explicit one-shot recovery mode."""
    if not one_shot_v5_enabled():
        return config
    if active_mirror_stats()[0] != 0:
        raise RuntimeError("one_shot_profile_recovery_active_mirror")
    changed = False
    for profile in config.get("profiles", []):
        if str(profile.get("status") or "ready") != "busy":
            continue
        profile_id = str(profile.get("id") or "").strip()
        if not profile_id:
            continue
        api(config, "profile-status", {"profile_id": profile_id, "status": "ready"}, timeout=20)
        profile["status"] = "ready"
        changed = True
        print(f"ONE_SHOT_V5_PROFILE_RECOVERED:{profile_id}", flush=True)
    if changed:
        with _CONFIG_WRITE_LOCK:
            save_config(config)
    return config


def agent_loop(stop_event, status_callback=None):
    one_shot_v5 = one_shot_v5_enabled()
    one_shot_claimed = False

    if one_shot_v5:
        print("ONE_SHOT_V5_CANARY_ENABLED", flush=True)

    while not stop_event.is_set():
        try:
            config = load_config()
            if not config.get("agent_token"):
                stop_event.wait(5)
                continue

            config = sync_remote_profiles(config)

            if one_shot_v5:
                if list_pending_finishes():
                    print("ONE_SHOT_V5_BLOCKED_PENDING_FINISH_OUTBOX", flush=True)
                    stop_event.set()
                    break
                config = recover_busy_profiles_for_one_shot(config)
            elif active_mirror_stats()[0] == 0:
                # The worker may be submitting its own finish right now. Replay
                # only after it has left the active slot to avoid parallel RPCs.
                flush_pending_finishes(config)
                if list_pending_finishes():
                    stop_event.wait(5)
                    continue

            total_active, has_prod, benchmark_count = active_mirror_stats()

            if one_shot_v5 and one_shot_claimed and total_active == 0:
                print("ONE_SHOT_V5_COMPLETE", flush=True)
                stop_event.set()
                break

            backoff = mirror_backoff_remaining()
            if backoff > 0 and total_active == 0:
                if status_callback:
                    status_callback(f"Telegram đang nghỉ an toàn · còn khoảng {backoff}s")
                stop_event.wait(min(10, max(1, backoff)))
                continue

            # Generic import/reconcile remains exclusive and always has priority
            # during normal operation. One-shot V5 mode never claims generic work.
            if total_active == 0 and not one_shot_v5:
                generic_job = claim_generic_job(config)
                if generic_job:
                    run_job(config, generic_job, stop_event, status_callback)
                    record_last_success()
                    continue

            # Evaluate mirror concurrency slots
            can_claim, slot_type = can_claim_mirror()
            if can_claim and not (one_shot_v5 and one_shot_claimed):
                job = claim_v5_job(config)
                if job:
                    if one_shot_v5:
                        # Lock the one-shot boundary at CLAIM TIME so failure cannot
                        # fall through to a second production claim.
                        one_shot_claimed = True
                        print(f"ONE_SHOT_V5_JOB_CLAIMED:{job.get('id')}", flush=True)
                        required_job_attempt(job)

                    is_benchmark = bool(job.get("benchmark"))
                    if slot_type == "benchmark_only" and not is_benchmark:
                        # Defensive: production job claimed while a benchmark job is running.
                        # Safely release it back to the queue with authenticated finish(ok=False) and exact attempt.
                        try:
                            parsed_attempt = required_job_attempt(job)
                            api(config, "v5-mirror-finish", {
                                "job_id": job.get("id"),
                                "ok": False,
                                "error": "benchmark_slot_mismatch",
                                "attempt": parsed_attempt
                            })
                        except Exception as release_exc:
                            print(f"[WARN] Failed to release mismatched job {job.get('id')}: {release_exc}", flush=True)
                    else:
                        start_mirror_job(config, job, stop_event, status_callback)
                        total_active, has_prod, benchmark_count = active_mirror_stats()
                        if status_callback:
                            mode_desc = "benchmark" if is_benchmark else "production"
                            status_callback(f"Đang mirror V5 ({mode_desc}) · {total_active} active job(s)")
                        stop_event.wait(1)
                        continue

            if total_active > 0:
                if status_callback:
                    status_callback(f"Đang mirror V5 · {total_active} active job(s)")
                stop_event.wait(1)
                continue

            if status_callback:
                suffix = " · R2 V5 sẵn sàng" if has_v5_r2_config(config) else ""
                status_callback("Đã kết nối · đang chờ công việc" + suffix)
            stop_event.wait(15)
        except Exception as exc:
            if status_callback:
                status_callback(f"Tạm thời chưa kết nối: {str(exc)[:200]}")
            stop_event.wait(15)

    terminate_all_subprocesses()
    wait_for_active_mirrors(timeout=10)
    if one_shot_v5:
        print("ONE_SHOT_V5_STOPPED", flush=True)

def start_background(status_callback=None):
    stop_event = threading.Event()
    thread = threading.Thread(target=agent_loop, args=(stop_event, status_callback), daemon=True)
    thread.start()
    return stop_event, thread
