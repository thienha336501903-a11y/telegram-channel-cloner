import { db, select } from './supabase.js';
import { TABLES } from './tables.js';
import { logEvent } from './repository.js';

const MAX_RECONCILE_ROWS = 100_000;

function safeMessageId(value, { allowZero = false } = {}) {
  const n = Number(value);
  const min = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(n) || n < min) return null;
  return n;
}

async function getSource(sourceId) {
  const id = String(sourceId || '').trim();
  if (!id) throw new Error('source_id_required');
  const rows = await select(
    TABLES.sources,
    `select=id,chat_id,title,indexed_at,indexed_message_count,last_reconciled_at&id=eq.${encodeURIComponent(id)}&limit=1`
  );
  const source = rows?.[0];
  if (!source) throw new Error('source_not_found');
  if (!source.indexed_at) throw new Error('source_not_indexed');
  return source;
}

export async function createReconcilePlan(sourceId) {
  const source = await getSource(sourceId);
  const rows = await select(
    TABLES.sourceMessages,
    `select=source_message_id&source_id=eq.${encodeURIComponent(source.id)}&order=source_message_id.desc&limit=1`
  );
  const upperBound = safeMessageId(rows?.[0]?.source_message_id, { allowZero: true }) ?? 0;
  return {
    source_id: source.id,
    chat_id: String(source.chat_id || ''),
    upper_bound_message_id: upperBound
  };
}

export async function applyReconcileSnapshot({
  sourceId,
  telegramChatId,
  upperBoundMessageId,
  presentMessageIds
}) {
  const source = await getSource(sourceId);
  const telegramChat = String(telegramChatId || '').trim();
  if (!telegramChat || telegramChat !== String(source.chat_id || '').trim()) {
    throw new Error('reconcile_source_identity_mismatch');
  }

  const upperBound = safeMessageId(upperBoundMessageId, { allowZero: true });
  if (upperBound === null) throw new Error('reconcile_upper_bound_invalid');
  if (!Array.isArray(presentMessageIds)) throw new Error('reconcile_present_ids_required');
  if (presentMessageIds.length > MAX_RECONCILE_ROWS) throw new Error('reconcile_snapshot_too_large');

  const present = new Set();
  for (const raw of presentMessageIds) {
    const id = safeMessageId(raw);
    if (id === null) throw new Error('reconcile_message_id_invalid');
    if (id <= upperBound) present.add(id);
  }

  const rows = await db('rpc/tgcloner_apply_reconcile_snapshot', {
    method: 'POST',
    body: {
      p_source_id: source.id,
      p_telegram_chat_id: telegramChat,
      p_upper_bound_message_id: upperBound,
      p_present_message_ids: [...present]
    }
  });
  const applied = Array.isArray(rows) ? rows[0] : rows;
  if (!applied || !Number.isFinite(Number(applied.deleted_count)) || !Number.isFinite(Number(applied.indexed_message_count))) {
    throw new Error('reconcile_atomic_result_invalid');
  }

  const result = {
    source_id: source.id,
    upper_bound_message_id: upperBound,
    observed_message_ids: present.size,
    indexed_rows_scanned: Math.max(0, Number(applied.indexed_rows_scanned) || 0),
    deleted_count: Math.max(0, Number(applied.deleted_count) || 0),
    indexed_message_count: Math.max(0, Number(applied.indexed_message_count) || 0),
    reconciled_at: applied.reconciled_at || new Date().toISOString()
  };

  // Operational logging is intentionally non-blocking after the atomic apply.
  // A telemetry failure must not make the Reader retry an already-committed snapshot.
  try {
    await logEvent({
      source_id: source.id,
      event_type: 'reader_reconcile',
      payload: {
        upper_bound_message_id: upperBound,
        observed_message_ids: result.observed_message_ids,
        indexed_rows_scanned: result.indexed_rows_scanned,
        deleted_count: result.deleted_count
      }
    });
  } catch (error) {
    console.warn('[reader-reconcile] telemetry failed after atomic apply:', error?.message || error);
  }

  return result;
}
