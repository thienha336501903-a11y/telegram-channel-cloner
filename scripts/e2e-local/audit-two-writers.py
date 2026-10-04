#!/usr/bin/env python3
"""Read-only forensic snapshot of the retained 1→2 TEST ledger and channels.

No Bot API token, source message text, or Reader credential is printed.
"""

import asyncio
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "reader-manager"))
sys.path.insert(0, str(ROOT / "reader-cli"))

from reader_manager_storage import load_config  # noqa: E402
from export_history import resolve_channel  # noqa: E402
from course_full import scan_course, validate_snapshot  # noqa: E402
from telethon import TelegramClient  # noqa: E402
from telethon.tl.types import InputMessagesFilterPinned  # noqa: E402

SOURCE = "-1004320185488"
DESTINATIONS = ("-1003933578709", "-1004492904064")
CONTAINER = "tgcloner-e2e-1to2-db"
VERIFIED_SOURCE_SHA256 = "2903f3050010c9106866be85f11e08506785e618e3f7f222b75d4fddcb7fa7bd"

SQL = """
with s as (
  select id, chat_id, active from public.tgcloner_sources
  where chat_id = '-1004320185488'
), d as (
  select id, source_id, chat_id, active from public.tgcloner_destinations
  where chat_id in ('-1003933578709', '-1004492904064')
)
select json_build_object(
  'sources', (select json_agg(row_to_json(s)) from s),
  'source_count', (select count(*) from public.tgcloner_source_messages m join s on s.id=m.source_id),
  'source_h', (select max(m.source_message_id) from public.tgcloner_source_messages m join s on s.id=m.source_id),
  'source_ids', (select json_agg(m.source_message_id order by m.source_message_id)
    from public.tgcloner_source_messages m join s on s.id=m.source_id),
  'destinations', (select json_agg(json_build_object(
    'id', d.id, 'source_id', d.source_id, 'chat_id', d.chat_id, 'active', d.active,
    'runs', (select json_agg(json_build_object(
      'id', r.id, 'status', r.status, 'phase', r.phase,
      'snapshot_h', r.snapshot_high_watermark,
      'manifest', (select count(*) from public.tgcloner_clone_manifest mf where mf.run_id=r.id),
      'copy_units', (select count(*) from public.tgcloner_clone_work w where w.run_id=r.id and w.phase='copy'),
      'copy_retried', (select count(*) from public.tgcloner_clone_work w where w.run_id=r.id and w.phase='copy' and w.attempt_count > 1),
      'copy_max_attempts', (select max(w.attempt_count) from public.tgcloner_clone_work w where w.run_id=r.id and w.phase='copy'),
      'copy_ambiguous', (select count(*) from public.tgcloner_clone_work w where w.run_id=r.id and w.phase='copy' and (w.side_effect_state='ambiguous' or w.status='blocked_ambiguous')),
      'copy_first_update', (select min(w.updated_at) from public.tgcloner_clone_work w where w.run_id=r.id and w.phase='copy'),
      'copy_last_update', (select max(w.updated_at) from public.tgcloner_clone_work w where w.run_id=r.id and w.phase='copy')
    )) from public.tgcloner_clone_runs r where r.destination_id=d.id),
    'mappings', (select json_agg(json_build_object(
      'source', m.source_message_id, 'destination', m.destination_message_id,
      'status', m.status) order by m.source_message_id)
      from public.tgcloner_message_mappings m where m.destination_id=d.id)
  ) order by d.chat_id) from d)
)::text;
"""


def snapshot():
    output = subprocess.check_output([
        "docker", "exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
        "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", SQL,
    ], text=True, timeout=30).strip()
    return json.loads(output)


def visible(message):
    return not getattr(message, "action", None) and bool(
        (getattr(message, "raw_text", "") or "").strip() or getattr(message, "media", None)
    )


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-clean", action="store_true")
    parser.add_argument("--after-one", action="store_true")
    args = parser.parse_args()
    if args.after_one and not args.require_clean:
        parser.error("--after-one requires --require-clean")
    data = snapshot()
    sources = data.get("sources") or []
    destinations = data.get("destinations") or []
    if (len(sources) != 1 or sources[0]["chat_id"] != SOURCE
            or sources[0]["active"] is not False
            or len(destinations) != 2
            or {d["chat_id"] for d in destinations} != set(DESTINATIONS)):
        raise RuntimeError("Retained 1to2 TEST database identity changed")
    print(f"AUDIT_SOURCE count={data['source_count']} H={data['source_h']}")
    expected_count = 61 if args.after_one else 60
    expected_h = 62 if args.after_one else 61
    if args.require_clean and (int(data["source_count"]) != expected_count or int(data["source_h"]) != expected_h):
        raise RuntimeError("TEST source changed since the verified 60-post run")

    config = load_config()
    clean = True
    async with TelegramClient(
        "telegram-cloner-e2e-reader", int(config["telegram_api_id"]),
        config["telegram_api_hash"]
    ) as client:
        source_entity = await resolve_channel(client, SOURCE)
        source_messages, source_pinned, source_info = await scan_course(client, source_entity)
        live_source_ids = {int(message.id) for message in source_messages}
        if args.require_clean and {int(value) for value in data.get("source_ids") or []} != live_source_ids:
            raise RuntimeError("TEST source rows differ between the retained DB and Telegram")
        print(f"AUDIT_LIVE_SOURCE count={source_info['count']} H={source_info['high_watermark']} sha256={source_info['sha256']}")
        verified_prefix = args.after_one and validate_snapshot(source_messages[:-1], source_entity, source_pinned)
        if args.require_clean and (source_info["count"] != expected_count or source_info["high_watermark"] != expected_h
                                   or (args.after_one and (verified_prefix["sha256"] != VERIFIED_SOURCE_SHA256
                                                           or int(source_messages[-1].id) != 62
                                                           or getattr(source_messages[-1], "media", None)
                                                           or not str(getattr(source_messages[-1], "raw_text", "") or "").strip()))
                                   or (not args.after_one and source_info["sha256"] != VERIFIED_SOURCE_SHA256)):
            raise RuntimeError("Live TEST source changed since the verified 1to2 inventory")
        for destination in destinations:
            chat_id = destination["chat_id"]
            if destination["source_id"] != sources[0]["id"] or destination["active"] is not False:
                raise RuntimeError(f"Destination identity or activation changed: {chat_id}")
            runs = destination.get("runs") or []
            mappings = destination.get("mappings") or []
            if len(runs) != 1:
                raise RuntimeError(f"Unexpected number of TEST runs: {chat_id}")
            mapped = {
                int(row["destination"]) for row in mappings
                if row["status"] == "copied" and row["destination"] is not None
            }
            mapped_source = {int(row["source"]) for row in mappings}
            if len(mapped) != len(mappings) or len(mapped_source) != len(mappings):
                raise RuntimeError(f"Incomplete or duplicate local mappings: {chat_id}")
            entity = await resolve_channel(client, chat_id)
            live = {int(m.id) async for m in client.iter_messages(entity) if visible(m)}
            pinned = [int(m.id) async for m in client.iter_messages(
                entity, filter=InputMessagesFilterPinned
            )]
            run = runs[0]
            print(
                f"AUDIT_DEST chat={chat_id} run={run['id']} phase={run['phase']} "
                f"manifest={run['manifest']} copy_units={run['copy_units']} "
                f"copy_retried={run['copy_retried']} copy_max_attempts={run['copy_max_attempts']} "
                f"copy_ambiguous={run['copy_ambiguous']} "
                f"copy_window_utc={run['copy_first_update']}..{run['copy_last_update']} "
                f"mapped={len(mapped)} visible={len(live)} "
                f"extra_visible={sorted(live - mapped)} "
                f"mapped_missing={sorted(mapped - live)} pinned={pinned}"
            )
            clean = clean and (run["status"] == "active" and run["phase"] == "ready_for_new"
                               and int(run["manifest"]) == 59 and len(mapped) == expected_count
                               and mapped_source == live_source_ids
                               and live == mapped and not pinned and not run["copy_ambiguous"])
    if args.require_clean and not clean:
        raise RuntimeError("TEST destinations no longer match the verified clean 1to2 ledger")
    print("AUDIT_READONLY_COMPLETE no_source_or_destination_write=true")


if __name__ == "__main__":
    asyncio.run(main())
