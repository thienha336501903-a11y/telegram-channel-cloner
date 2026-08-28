-- Bound Reader reconcile apply work inside one atomic, set-based database call.
-- If the operation cannot finish within the local statement timeout, Postgres
-- rolls the transaction back instead of leaving a partially-applied snapshot.

create or replace function public.tgcloner_apply_reconcile_snapshot(
  p_source_id uuid,
  p_telegram_chat_id text,
  p_upper_bound_message_id bigint,
  p_present_message_ids bigint[]
)
returns table(
  deleted_count integer,
  indexed_rows_scanned integer,
  indexed_message_count integer,
  reconciled_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_source_chat_id text;
  v_indexed_at timestamptz;
  v_deleted bigint := 0;
  v_scanned bigint := 0;
  v_indexed_count bigint := 0;
  v_now timestamptz := clock_timestamp();
  v_present bigint[] := coalesce(p_present_message_ids, array[]::bigint[]);
begin
  perform set_config('statement_timeout', '20000', true);

  if p_source_id is null then
    raise exception 'source_id_required';
  end if;
  if p_upper_bound_message_id is null or p_upper_bound_message_id < 0 then
    raise exception 'reconcile_upper_bound_invalid';
  end if;
  if cardinality(v_present) > 100000 then
    raise exception 'reconcile_snapshot_too_large';
  end if;
  if exists (select 1 from unnest(v_present) as value where value is null or value < 1) then
    raise exception 'reconcile_message_id_invalid';
  end if;

  select s.chat_id, s.indexed_at
    into v_source_chat_id, v_indexed_at
  from public.tgcloner_sources s
  where s.id = p_source_id
  for update;

  if not found then
    raise exception 'source_not_found';
  end if;
  if v_indexed_at is null then
    raise exception 'source_not_indexed';
  end if;
  if nullif(btrim(coalesce(p_telegram_chat_id, '')), '') is null
     or btrim(p_telegram_chat_id) <> btrim(coalesce(v_source_chat_id, '')) then
    raise exception 'reconcile_source_identity_mismatch';
  end if;

  select count(*) into v_scanned
  from public.tgcloner_source_messages m
  where m.source_id = p_source_id
    and m.source_message_id <= p_upper_bound_message_id;

  delete from public.tgcloner_source_messages m
  where m.source_id = p_source_id
    and m.source_message_id <= p_upper_bound_message_id
    and not (m.source_message_id = any(v_present));
  get diagnostics v_deleted = row_count;

  select count(*) into v_indexed_count
  from public.tgcloner_source_messages m
  where m.source_id = p_source_id;

  update public.tgcloner_sources
  set indexed_message_count = v_indexed_count::integer,
      last_reconciled_at = v_now,
      updated_at = v_now
  where id = p_source_id;

  return query
    select v_deleted::integer, v_scanned::integer, v_indexed_count::integer, v_now;
end;
$$;

revoke all on function public.tgcloner_apply_reconcile_snapshot(uuid, text, bigint, bigint[]) from public;
revoke all on function public.tgcloner_apply_reconcile_snapshot(uuid, text, bigint, bigint[]) from anon;
revoke all on function public.tgcloner_apply_reconcile_snapshot(uuid, text, bigint, bigint[]) from authenticated;
grant execute on function public.tgcloner_apply_reconcile_snapshot(uuid, text, bigint, bigint[]) to service_role;
