import { patch, remove, select } from './supabase.js';
import { TABLES } from './tables.js';
import { logEvent, syncSourceIndexedMessageCount } from './repository.js';

const MAX_RECONCILE_ROWS = 100_000;
const DELETE_CHUNK_SIZE = 200;

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

  let indexedRows = [];
  if (upperBound > 0) {
    indexedRows = await select(
      TABLES.sourceMessages,
      `select=id,source_message_id&source_id=eq.${encodeURIComponent(source.id)}&source_message_id=lte.${upperBound}&order=source_message_id.asc&limit=${MAX_RECONCILE_ROWS + 1}`
    );
    if ((indexedRows || []).length > MAX_RECONCILE_ROWS) {
      throw new Error('reconcile_index_scope_too_large');
    }
  }

  const staleRows = (indexedRows || []).filter(row => {
    const id = safeMessageId(row.source_message_id);
    return id !== null && !present.has(id);
  });

  for (let i = 0; i < staleRows.length; i += DELETE_CHUNK_SIZE) {
    const chunk = staleRows.slice(i, i + DELETE_CHUNK_SIZE);
    const ids = chunk.map(row => String(row.id || '').trim()).filter(Boolean);
    if (!ids.length) continue;
    await remove(
      TABLES.sourceMessages,
      `source_id=eq.${encodeURIComponent(source.id)}&id=in.(${ids.join(',')})`
    );
  }

  const now = new Date().toISOString();
  await patch(
    TABLES.sources,
    `id=eq.${encodeURIComponent(source.id)}`,
    { last_reconciled_at: now, updated_at: now },
    { returning: false }
  );
  const synced = await syncSourceIndexedMessageCount(source.id);

  await logEvent({
    source_id: source.id,
    event_type: 'reader_reconcile',
    payload: {
      upper_bound_message_id: upperBound,
      observed_message_ids: present.size,
      indexed_rows_scanned: (indexedRows || []).length,
      deleted_count: staleRows.length
    }
  });

  return {
    source_id: source.id,
    upper_bound_message_id: upperBound,
    observed_message_ids: present.size,
    indexed_rows_scanned: (indexedRows || []).length,
    deleted_count: staleRows.length,
    indexed_message_count: Number(synced?.indexed_message_count ?? 0),
    reconciled_at: now
  };
}
