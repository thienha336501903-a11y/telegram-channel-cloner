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

import requests
from telethon import TelegramClient
from telethon.sessions import StringSession

from reader_manager_storage import load_config, save_config
from reader_manager_pairing import DEFAULT_CLONER_URL

APP_VERSION = "1.4.0"
CONTROL_PATH = "/api/reader/complete"
BASE_CAPABILITIES = ["reconcile_v1", "profiles_v1", "progress_v1", "progress_stage_v1"]
V5_MIRROR_CAPABILITY = "v5_r2_mirror_v1"
SOURCE_ACCESS_CACHE_TTL = 240
MAX_V5_MIRROR_CONCURRENCY = 2

_SOURCE_ACCESS_CACHE = {}  # (source_id, channel, profile_id) -> timestamp
_SOURCE_ACCESS_LOCK = threading.RLock()
_PROFILE_USAGE_LOCK = threading.RLock()
_PROFILE_ACTIVE_COUNTS = {}
_ACTIVE_MIRRORS_LOCK = threading.RLock()
_ACTIVE_MIRRORS = {}
_CONFIG_WRITE_LOCK = threading.RLock()
_BACKOFF_LOCK = threading.RLock()
_MIRROR_BACKOFF_UNTIL = 0.0
_MIRROR_DEGRADED_UNTIL = 0.0


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


def mirror_concurrency(config):
    """Canary-controlled concurrency. Default remains exactly one."""
    raw = os.getenv("V5_MIRROR_CONCURRENCY")
    if raw is None or not str(raw).strip():
        raw = config.get("v5_mirror_concurrency", 1)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = 1
    return max(1, min(MAX_V5_MIRROR_CONCURRENCY, value))


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


def profile_active_count(profile_id):
    with _PROFILE_USAGE_LOCK:
        return int(_PROFILE_ACTIVE_COUNTS.get(str(profile_id), 0))


def ready_profiles(config):
    return [
        profile for profile in config.get("profiles", [])
        if profile.get("id") and profile.get("session") and str(profile.get("status") or "ready") == "ready"
    ]


def v5_candidate_profiles(config):
    values = []
    for profile in config.get("profiles", []):
        profile_id = str(profile.get("id") or "")
        if not profile_id or not profile.get("session"):
            continue
        status = str(profile.get("status") or "ready")
        if status == "ready" or (status == "busy" and profile_active_count(profile_id) > 0):
            values.append(profile)
    return values


def invalidate_source_access_cache(source_id=None, channel=None, profile_id=None):
    with _SOURCE_ACCESS_LOCK:
        if source_id is None and channel is None and profile_id is None:
            _SOURCE_ACCESS_CACHE.clear()
            return
        keys_to_remove = [
            key for key in _SOURCE_ACCESS_CACHE
            if (source_id is None or key[0] == str(source_id))
            and (channel is None or key[1] == str(channel))
            and (profile_id is None or key[2] == str(profile_id))
        ]
        for key in keys_to_remove:
            _SOURCE_ACCESS_CACHE.pop(key, None)


def choose_v5_profile(config, channel, source_id):
    """Resolve access once per source/profile TTL, serialized so C2 cannot duplicate verification."""
    import asyncio

    with _SOURCE_ACCESS_LOCK:
        now = time.time()
        for profile in v5_candidate_profiles(config):
            profile_id = str(profile.get("id") or "")
            cache_key = (str(source_id), str(channel), profile_id)
            cached_at = _SOURCE_ACCESS_CACHE.get(cache_key)
            if cached_at and (now - cached_at) < SOURCE_ACCESS_CACHE_TTL:
                return profile
            try:
                asyncio.run(verify_access(profile, channel))
                _SOURCE_ACCESS_CACHE[cache_key] = time.time()
                try:
                    api(config, "source-access", {
                        "profile_id": profile["id"],
                        "source_id": source_id,
                        "ok": True,
                    })
                except Exception:
                    pass
                return profile
            except Exception:
                _SOURCE_ACCESS_CACHE.pop(cache_key, None)
                try:
                    api(config, "source-access", {
                        "profile_id": profile["id"],
                        "source_id": source_id,
                        "ok": False,
                        "error": "reader_source_access_denied",
                    })
                except Exception:
                    pass
    return None


def acquire_profile_usage(config, profile_id):
    profile_id = str(profile_id or "")
    if not profile_id:
        raise RuntimeError("reader_profile_identity_missing")
    with _PROFILE_USAGE_LOCK:
        previous = int(_PROFILE_ACTIVE_COUNTS.get(profile_id, 0))
        _PROFILE_ACTIVE_COUNTS[profile_id] = previous + 1
    if previous == 0:
        try:
            api(config, "profile-status", {"profile_id": profile_id, "status": "busy"})
        except Exception:
            with _PROFILE_USAGE_LOCK:
                remaining = max(0, int(_PROFILE_ACTIVE_COUNTS.get(profile_id, 1)) - 1)
                if remaining:
                    _PROFILE_ACTIVE_COUNTS[profile_id] = remaining
                else:
                    _PROFILE_ACTIVE_COUNTS.pop(profile_id, None)
            raise


def release_profile_usage(config, profile_id):
    profile_id = str(profile_id or "")
    if not profile_id:
        return
    should_mark_ready = False
    with _PROFILE_USAGE_LOCK:
        remaining = max(0, int(_PROFILE_ACTIVE_COUNTS.get(profile_id, 1)) - 1)
        if remaining:
            _PROFILE_ACTIVE_COUNTS[profile_id] = remaining
        else:
            _PROFILE_ACTIVE_COUNTS.pop(profile_id, None)
            should_mark_ready = True
    if should_mark_ready:
        try:
            api(config, "profile-status", {"profile_id": profile_id, "status": "ready"})
        except Exception:
            pass


def progress_value(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return int(value.get("current", 0)), value.get("total")
    except Exception:
        return None, None


def progress_info(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return {
            "current": int(value.get("current", 0)) if "current" in value else None,
            "total": int(value.get("total")) if value.get("total") is not None else None,
            "stage": str(value.get("stage") or "") or None,
            "rate_bps": int(value.get("rate_bps") or 0),
            "eta_seconds": int(value.get("eta_seconds")) if value.get("eta_seconds") is not None else None,
            "stage_elapsed_ms": int(value.get("stage_elapsed_ms") or 0),
        }
    except Exception:
        return {
            "current": None,
            "total": None,
            "stage": None,
            "rate_bps": 0,
            "eta_seconds": None,
            "stage_elapsed_ms": 0,
        }


def worker_result(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def stage_description(stage):
    return {
        "r2_precheck": "Đang kiểm tra R2",
        "telegram_resolve": "Đang mở nguồn Telegram",
        "telegram_download": "Đang tải Telegram",
        "faststart": "Đang tối ưu video",
        "r2_upload": "Đang upload R2",
    }.get(str(stage or ""), "Đang sao lưu media V5")


def progress_detail(progress):
    current = progress.get("current")
    total = progress.get("total")
    rate = int(progress.get("rate_bps") or 0)
    eta = progress.get("eta_seconds")
    details = []
    if isinstance(current, int) and isinstance(total, int) and total > 0:
        details.append(f"{current / 1048576:.1f}/{total / 1048576:.1f} MB")
    if rate > 0:
        details.append(f"{rate / 1048576:.1f} MB/s")
    if isinstance(eta, int) and eta >= 0:
        details.append(f"ETA {eta}s")
    return " · ".join(details)


def merge_manager_telemetry(result, worker_elapsed_ms, first_progress_ms):
    raw = result.get("telemetry")
    telemetry = dict(raw) if isinstance(raw, dict) else {}
    timings = telemetry.get("timings_ms")
    timings = dict(timings) if isinstance(timings, dict) else {}
    timings["manager_worker_elapsed_ms"] = max(0, int(worker_elapsed_ms))
    if first_progress_ms is not None:
        timings["manager_first_progress_ms"] = max(0, int(first_progress_ms))
    telemetry["version"] = 1
    telemetry["timings_ms"] = timings
    return telemetry


def run_job(config, job, stop_event, status_callback=None):
    channel = str(job.get("channel_ref") or "").strip()
    source_id = str(job.get("source_id") or "")
    job_id = str(job.get("id") or "")
    job_type = str(job.get("job_type") or "import").strip().lower()
    if not job_id or not channel:
        raise RuntimeError("reader_job_missing_identity")

    profile_id = ""
    profile_acquired = False
    if job_type == "v5_mirror":
        profile = choose_v5_profile(config, channel, source_id)
        if not profile:
            api(config, "v5-mirror-finish", {
                "job_id": job_id,
                "ok": False,
                "error": "reader_source_access_denied",
            })
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
            "progress_detail": "Đang kiểm tra quyền truy cập nguồn",
        })
        if status_callback:
            status_callback("Đang kiểm tra quyền truy cập nguồn Telegram")
        try:
            import asyncio
            asyncio.run(verify_access(profile, channel))
            api(config, "source-access", {
                "profile_id": profile_id,
                "source_id": source_id,
                "ok": True,
            })
        except Exception as exc:
            api(config, "source-access", {
                "profile_id": profile_id,
                "source_id": source_id,
                "ok": False,
                "error": "reader_source_access_denied",
            })
            api(config, "finish-job", {
                "job_id": job_id,
                "ok": False,
                "error": "reader_source_access_denied",
            })
            raise RuntimeError("reader_source_access_denied") from exc

    acquire_profile_usage(config, profile_id)
    profile_acquired = True

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
                command = worker_command("reconcile_history.py") + [
                    "--source-id", source_id,
                    "--channel", channel,
                    "--cloner-url", config.get("cloner_url", DEFAULT_CLONER_URL),
                    "--result-file", str(result_file),
                ]
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
                ]
                stage = "mirroring_r2"
            else:
                job_type = "import"
                command = worker_command("export_history.py") + [
                    "--channel", channel,
                    "--cloner-url", config.get("cloner_url", DEFAULT_CLONER_URL),
                    "--progress-file", str(progress_file),
                ]
                stage = "reading_history"

            if job_type != "v5_mirror":
                api(config, "job-progress", {
                    "job_id": job_id,
                    "progress_stage": stage,
                    "progress_detail": "Đang đối chiếu lịch sử kênh" if job_type == "reconcile" else "Đang đọc lịch sử kênh Telegram",
                })
            if status_callback:
                status_callback("Đang sao lưu media V5" if job_type == "v5_mirror" else "Đang xử lý nguồn Telegram")

            popen_kwargs = {}
            if os.name == "nt":
                popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

            worker_started = time.monotonic()
            first_progress_ms = None
            process = subprocess.Popen(command, env=env, **popen_kwargs)
            last_heartbeat = 0
            while process.poll() is None:
                if stop_event.is_set():
                    process.terminate()
                    break
                now_ts = time.time()
                heartbeat_interval = 2.5 if job_type == "v5_mirror" else 10
                if now_ts - last_heartbeat >= heartbeat_interval:
                    if job_type == "v5_mirror":
                        progress = progress_info(progress_file)
                        if first_progress_ms is None and progress.get("stage"):
                            first_progress_ms = int((time.monotonic() - worker_started) * 1000)
                        payload = {"job_id": job_id}
                        if progress.get("current") is not None:
                            payload["progress_current"] = progress["current"]
                        if progress.get("total") is not None:
                            payload["progress_total"] = progress["total"]
                        api(config, "v5-mirror-heartbeat", payload, timeout=20)
                        if status_callback:
                            detail = progress_detail(progress)
                            status_callback(stage_description(progress.get("stage")) + (f" · {detail}" if detail else ""))
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
                            status_callback(f"Đang nhập {current} bài từ Telegram")
                    last_heartbeat = time.time()
                time.sleep(1 if job_type == "v5_mirror" else 2)

            code = process.wait()
            worker_elapsed_ms = int((time.monotonic() - worker_started) * 1000)
            result = worker_result(result_file)
            current, total = progress_value(progress_file)

        if job_type == "v5_mirror":
            ok = code == 0 and result.get("ok") is True
            error = None if ok else str(result.get("error") or f"v5_mirror_exit_{code}")[:2000]
            if not ok and error and any(
                term in error.lower()
                for term in ("access_denied", "channelprivate", "chatadminrequired", "authkey", "userdeactivated", "session")
            ):
                invalidate_source_access_cache(source_id, channel, profile_id)

            completion = {
                "job_id": job_id,
                "ok": ok,
                "error": error,
                "telemetry": merge_manager_telemetry(result, worker_elapsed_ms, first_progress_ms),
            }
            if ok:
                completion["object_key"] = str(result.get("object_key") or job.get("object_key") or "")
                bytes_value = result.get("bytes")
                if isinstance(bytes_value, int) and not isinstance(bytes_value, bool) and bytes_value >= 0:
                    completion["bytes"] = bytes_value
                completion["etag"] = str(result.get("etag") or "")[:300]
            api(config, "v5-mirror-finish", completion)
        else:
            ok = code == 0
            error = None if ok else f"{job_type}_exit_{code}"
            message_count = current if job_type == "import" and current is not None else result.get("indexed_message_count")
            completion = {"job_id": job_id, "ok": ok, "error": error}
            if isinstance(message_count, int) and message_count >= 0:
                completion["message_count"] = message_count
            deleted_count = result.get("deleted_count")
            if isinstance(deleted_count, int) and deleted_count >= 0:
                completion["deleted_count"] = deleted_count
            api(config, "finish-job", completion)

        if not ok:
            raise RuntimeError(error if job_type == "v5_mirror" else f"{job_type}_exit_{code}")
        return True
    finally:
        if profile_acquired:
            release_profile_usage(config, profile_id)


def claim_generic_job(config):
    capabilities = reader_capabilities(config)
    return api(config, "claim", {"capabilities": capabilities}, timeout=30).get("job")


def claim_v5_job(config):
    capabilities = reader_capabilities(config)
    if V5_MIRROR_CAPABILITY not in capabilities:
        return None
    return api(config, "v5-mirror-claim", {"capabilities": capabilities}, timeout=30).get("job")


def claim_next_job(config):
    """Compatibility helper: preserve generic priority when no mirrors are active."""
    job = claim_generic_job(config)
    return job if job else claim_v5_job(config)


def active_mirror_count():
    with _ACTIVE_MIRRORS_LOCK:
        return len(_ACTIVE_MIRRORS)


def record_last_success():
    with _CONFIG_WRITE_LOCK:
        config = load_config()
        config["last_success_at"] = int(time.time())
        save_config(config)


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


def effective_mirror_concurrency(config):
    configured = mirror_concurrency(config)
    now = time.time()
    with _BACKOFF_LOCK:
        if now < _MIRROR_BACKOFF_UNTIL:
            return 0
        if now < _MIRROR_DEGRADED_UNTIL:
            return 1
    return configured


def mirror_backoff_remaining():
    with _BACKOFF_LOCK:
        return max(0, int(_MIRROR_BACKOFF_UNTIL - time.time()))


def mirror_worker(config, job, stop_event, status_callback=None):
    job_id = str(job.get("id") or "")
    try:
        run_job(config, job, stop_event, status_callback)
        record_last_success()
    except Exception as exc:
        limited = apply_mirror_backpressure(exc)
        if status_callback:
            if limited:
                status_callback("Telegram đang giới hạn tạm thời · Reader tự giảm tốc")
            else:
                status_callback(f"Mirror tạm lỗi: {str(exc)[:160]}")
    finally:
        with _ACTIVE_MIRRORS_LOCK:
            _ACTIVE_MIRRORS.pop(job_id, None)


def start_mirror_job(config, job, stop_event, status_callback=None):
    job_id = str(job.get("id") or "")
    if not job_id:
        raise RuntimeError("reader_job_missing_identity")
    thread = threading.Thread(
        target=mirror_worker,
        args=(config, job, stop_event, status_callback),
        daemon=True,
        name=f"v5-mirror-{job_id[:8]}",
    )
    with _ACTIVE_MIRRORS_LOCK:
        if job_id in _ACTIVE_MIRRORS:
            raise RuntimeError("v5_mirror_job_already_active")
        _ACTIVE_MIRRORS[job_id] = thread
    thread.start()
    return thread


def start_mirror_batch(config, stop_event, status_callback=None):
    limit = effective_mirror_concurrency(config)
    if limit <= 0:
        return 0
    started = 0
    for _ in range(limit):
        if stop_event.is_set():
            break
        job = claim_v5_job(config)
        if not job:
            break
        start_mirror_job(config, job, stop_event, status_callback)
        started += 1
    return started


def sync_remote_profiles(config):
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
    return config


def agent_loop(stop_event, status_callback=None):
    while not stop_event.is_set():
        try:
            config = load_config()
            if not config.get("agent_token"):
                stop_event.wait(5)
                continue

            config = sync_remote_profiles(config)
            active = active_mirror_count()
            if active > 0:
                if status_callback:
                    status_callback(f"Đang mirror V5 · {active}/{mirror_concurrency(config)} job")
                stop_event.wait(2)
                continue

            backoff = mirror_backoff_remaining()
            if backoff > 0:
                if status_callback:
                    status_callback(f"Telegram đang nghỉ an toàn · còn khoảng {backoff}s")
                stop_event.wait(min(10, max(1, backoff)))
                continue

            # Generic import/reconcile remains exclusive and always has priority
            # between mirror batches. It never overlaps V5 mirror workers.
            job = claim_generic_job(config)
            if job:
                run_job(config, job, stop_event, status_callback)
                record_last_success()
                continue

            started = start_mirror_batch(config, stop_event, status_callback)
            if started:
                if status_callback:
                    status_callback(f"Đã bắt đầu {started} mirror job V5")
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


def start_background(status_callback=None):
    stop_event = threading.Event()
    thread = threading.Thread(target=agent_loop, args=(stop_event, status_callback), daemon=True)
    thread.start()
    return stop_event, thread
