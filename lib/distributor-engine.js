import { select } from './supabase.js';
import { TABLES } from './tables.js';
import { getMapping, getSourceMessage } from './repository.js';
import {
  armDistributorWork,
  finishDistributorCopy,
  finishDistributorEdit,
  finishDistributorWork,
  prepareDistributorCatchup
} from './distributor-repository.js';
import {
  copyManySafely,
  copyOneSafely,
  editCaptionSafely,
  editTextSafely,
  isAmbiguousTelegramFailure,
  isKnownTelegramFailure
} from './distributor-telegram.js';

async function one(table, query) {
  const rows = await select(table, query);
  return rows?.[0] || null;
}

async function loadContext(work, deps) {
  const run = await deps.getRun(work.run_id);
  if (!run) throw new Error('distributor_run_not_found');
  const source = await deps.getSource(run.source_id);
  const destination = await deps.getDestination(run.destination_id);
  if (!source || !destination) throw new Error('distributor_source_or_destination_missing');
  if (String(destination.source_id) !== String(source.id)) throw new Error('distributor_destination_source_mismatch');
  return { run, source, destination };
}

async function existingDestinationIds(work, ctx, deps) {
  const ids = Array.isArray(work.manifest_message_ids) ? work.manifest_message_ids.map(Number) : [];
  const mappings = [];
  for (const sourceMessageId of ids) {
    mappings.push(await deps.getMapping(ctx.source.id, sourceMessageId, ctx.destination.id));
  }
  if (mappings.every((row) => row?.status === 'copied' && Number(row.destination_message_id) > 0)) {
    return mappings.map((row) => Number(row.destination_message_id));
  }
  if (mappings.some((row) => row?.destination_message_id)) return null;
  return [];
}

function errorText(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 1800);
}

async function markAmbiguous(work, workerId, deps, error, result = {}) {
  try {
    return await deps.finishWork({
      workId: work.id,
      workerId,
      leaseGeneration: Number(work.lease_generation),
      outcome: 'ambiguous',
      retryable: false,
      errorCode: error?.reason || error?.code || 'ambiguous_external_result',
      error: errorText(error),
      result
    });
  } catch (markError) {
    return { ambiguous_mark_failed: true, error: errorText(markError) };
  }
}

async function processCopy(work, ctx, workerId, deps) {
  const sourceIds = Array.isArray(work.manifest_message_ids) ? work.manifest_message_ids.map(Number) : [];
  if (!sourceIds.length) throw new Error('distributor_copy_source_ids_missing');

  const existing = await existingDestinationIds(work, ctx, deps);
  if (existing === null) {
    await deps.armWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation) });
    return {
      ok: false,
      ambiguous: true,
      work: await markAmbiguous(work, workerId, deps, new Error('partial_mapping_exists_before_copy'))
    };
  }
  if (existing.length === sourceIds.length && existing.length > 0) {
    await deps.armWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation) });
    const finished = await deps.finishCopy({
      workId: work.id,
      workerId,
      leaseGeneration: Number(work.lease_generation),
      destinationMessageIds: existing,
      result: { idempotent_mapping_recovery: true }
    });
    return { ok: true, idempotent: true, work: finished };
  }

  await deps.armWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation) });
  let copied;
  try {
    copied = sourceIds.length > 1
      ? await deps.copyMany({ sourceChatId: ctx.source.chat_id, sourceMessageIds: sourceIds, destinationChatId: ctx.destination.chat_id })
      : await deps.copyOne({ sourceChatId: ctx.source.chat_id, sourceMessageId: sourceIds[0], destinationChatId: ctx.destination.chat_id });
  } catch (error) {
    if (isKnownTelegramFailure(error)) {
      const retryable = error.errorCode === 429 || error.retryAfter != null;
      const finished = await deps.finishWork({
        workId: work.id,
        workerId,
        leaseGeneration: Number(work.lease_generation),
        outcome: 'known_failure',
        retryable,
        retryAfterSeconds: error.retryAfter ?? 30,
        errorCode: error.errorCode ? `telegram_${error.errorCode}` : 'telegram_known_failure',
        error: errorText(error),
        result: { telegram_method: error.method || null }
      });
      return { ok: false, knownFailure: true, retryable, work: finished };
    }
    if (isAmbiguousTelegramFailure(error)) {
      const finished = await markAmbiguous(work, workerId, deps, error, {
        telegram_method: error.method || null,
        partial_result: error.partialResult || null
      });
      return { ok: false, ambiguous: true, work: finished };
    }
    const finished = await markAmbiguous(work, workerId, deps, error);
    return { ok: false, ambiguous: true, work: finished };
  }

  try {
    const finished = await deps.finishCopy({
      workId: work.id,
      workerId,
      leaseGeneration: Number(work.lease_generation),
      destinationMessageIds: copied.destinationMessageIds,
      result: {
        destination_message_ids: copied.destinationMessageIds,
        album: sourceIds.length > 1
      }
    });
    return { ok: true, work: finished };
  } catch (error) {
    const marked = await markAmbiguous(work, workerId, deps, error, {
      telegram_copy_succeeded: true,
      destination_message_ids: copied.destinationMessageIds
    });
    return { ok: false, ambiguous: true, postCopyCommitFailure: true, work: marked };
  }
}

async function processEdit(work, ctx, workerId, deps) {
  const sourceMessageId = Number(work.source_message_id);
  const message = await deps.getSourceMessage(ctx.source.id, sourceMessageId);
  const mapping = await deps.getMapping(ctx.source.id, sourceMessageId, ctx.destination.id);
  if (!message || !mapping?.destination_message_id) throw new Error('distributor_edit_source_or_mapping_missing');
  if (message.has_internal_links) throw new Error('distributor_edit_requires_link_rewrite');
  if (!message.text && !message.caption) throw new Error('distributor_edit_requires_fidelity_handler');

  await deps.armWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation) });
  try {
    if (message.text) {
      await deps.editText({
        chatId: ctx.destination.chat_id,
        messageId: Number(mapping.destination_message_id),
        text: message.text,
        entities: message.text_entities || []
      });
    } else {
      await deps.editCaption({
        chatId: ctx.destination.chat_id,
        messageId: Number(mapping.destination_message_id),
        caption: message.caption,
        captionEntities: message.caption_entities || []
      });
    }
  } catch (error) {
    if (isKnownTelegramFailure(error)) {
      const retryable = error.errorCode === 429 || error.retryAfter != null;
      const finished = await deps.finishWork({
        workId: work.id,
        workerId,
        leaseGeneration: Number(work.lease_generation),
        outcome: 'known_failure',
        retryable,
        retryAfterSeconds: error.retryAfter ?? 30,
        errorCode: error.errorCode ? `telegram_${error.errorCode}` : 'telegram_known_failure',
        error: errorText(error),
        result: { telegram_method: error.method || null }
      });
      return { ok: false, knownFailure: true, retryable, work: finished };
    }
    const finished = await markAmbiguous(work, workerId, deps, error, {
      telegram_method: error?.method || null,
      partial_result: error?.partialResult || null
    });
    return { ok: false, ambiguous: true, work: finished };
  }

  try {
    const finished = await deps.finishEdit({
      workId: work.id,
      workerId,
      leaseGeneration: Number(work.lease_generation),
      result: { destination_message_id: Number(mapping.destination_message_id) }
    });
    return { ok: true, work: finished };
  } catch (error) {
    const marked = await markAmbiguous(work, workerId, deps, error, {
      telegram_edit_succeeded: true,
      destination_message_id: Number(mapping.destination_message_id)
    });
    return { ok: false, ambiguous: true, postEditCommitFailure: true, work: marked };
  }
}

export const defaultDistributorEngineDeps = Object.freeze({
  getRun: (id) => one(TABLES.cloneRuns, `select=*&id=eq.${encodeURIComponent(id)}&limit=1`),
  getSource: (id) => one(TABLES.sources, `select=*&id=eq.${encodeURIComponent(id)}&limit=1`),
  getDestination: (id) => one(TABLES.destinations, `select=*&id=eq.${encodeURIComponent(id)}&limit=1`),
  getSourceMessage,
  getMapping,
  armWork: armDistributorWork,
  finishWork: finishDistributorWork,
  finishCopy: finishDistributorCopy,
  finishEdit: finishDistributorEdit,
  prepareCatchup: prepareDistributorCatchup,
  copyOne: copyOneSafely,
  copyMany: copyManySafely,
  editText: editTextSafely,
  editCaption: editCaptionSafely
});

export async function processDistributorWork(work, { workerId, deps = defaultDistributorEngineDeps } = {}) {
  if (!work?.id || !work?.run_id) throw new Error('distributor_work_required');
  if (!workerId) throw new Error('distributor_worker_id_required');
  const ctx = await loadContext(work, deps);
  try {
    let result;
    if (work.operation_kind === 'copy' && ['copy','catchup'].includes(work.phase)) {
      result = await processCopy(work, ctx, workerId, deps);
    } else if (work.operation_kind === 'edit' && work.phase === 'catchup') {
      result = await processEdit(work, ctx, workerId, deps);
    } else {
      throw new Error(`distributor_work_operation_unsupported:${work.phase}/${work.operation_kind}`);
    }

    if (result.ok && ['copy','catchup'].includes(work.phase)) {
      try { await deps.prepareCatchup({ runId: work.run_id }); } catch {}
    }
    return result;
  } catch (error) {
    const beforeSideEffect = work.side_effect_state !== 'armed';
    if (beforeSideEffect) {
      try {
        const finished = await deps.finishWork({
          workId: work.id,
          workerId,
          leaseGeneration: Number(work.lease_generation),
          outcome: 'known_failure',
          retryable: false,
          errorCode: 'distributor_preflight_failure',
          error: errorText(error),
          result: {}
        });
        return { ok: false, knownFailure: true, retryable: false, work: finished, error };
      } catch {}
    }
    return { ok: false, error };
  }
}
