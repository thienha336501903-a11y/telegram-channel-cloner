import { select } from './supabase.js';
import { TABLES } from './tables.js';
import { getMapping, getMappings, getSourceMessage } from './repository.js';
import { extractInternalEntityLinks, extractInternalLinks, rewriteTextAndEntities } from './links.js';
import {
  armDistributorWork,
  blockDistributorDependency,
  finishDistributorCopy,
  finishDistributorEdit,
  finishDistributorPin,
  finishDistributorRewrite,
  finishDistributorVerify,
  finishDistributorWork,
  prepareDistributorCatchup,
  prepareDistributorFidelity,
  prepareDistributorVerification
} from './distributor-repository.js';
import {
  copyManySafely,
  copyOneSafely,
  editCaptionSafely,
  editTextSafely,
  getChatSafely,
  isKnownTelegramFailure,
  pinMessageSafely,
  unpinAllMessagesSafely
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
  for (const sourceMessageId of ids) mappings.push(await deps.getMapping(ctx.source.id, sourceMessageId, ctx.destination.id));
  if (mappings.every((row) => row?.status === 'copied' && Number(row.destination_message_id) > 0)) return mappings.map((row) => Number(row.destination_message_id));
  if (mappings.some((row) => row?.destination_message_id)) return null;
  return [];
}

function errorText(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 1800);
}

async function markAmbiguous(work, workerId, deps, error, result = {}) {
  try {
    return await deps.finishWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), outcome: 'ambiguous', retryable: false, errorCode: error?.reason || error?.code || 'ambiguous_external_result', error: errorText(error), result });
  } catch (markError) {
    return { ambiguous_mark_failed: true, error: errorText(markError) };
  }
}

async function finishKnownFailure(work, workerId, deps, error, { safeRetry = false } = {}) {
  const retryable = safeRetry || error?.errorCode === 429 || error?.retryAfter != null;
  return deps.finishWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), outcome: 'known_failure', retryable, retryAfterSeconds: error?.retryAfter ?? 30, errorCode: error?.errorCode ? `telegram_${error.errorCode}` : 'telegram_known_failure', error: errorText(error), result: { telegram_method: error?.method || null } });
}

async function processCopy(work, ctx, workerId, deps) {
  const sourceIds = Array.isArray(work.manifest_message_ids) ? work.manifest_message_ids.map(Number) : [];
  if (!sourceIds.length) throw new Error('distributor_copy_source_ids_missing');
  const existing = await existingDestinationIds(work, ctx, deps);
  if (existing === null) {
    await deps.armWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation) });
    return { ok: false, ambiguous: true, work: await markAmbiguous(work, workerId, deps, new Error('partial_mapping_exists_before_copy')) };
  }
  if (existing.length === sourceIds.length && existing.length > 0) {
    await deps.armWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation) });
    const finished = await deps.finishCopy({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), destinationMessageIds: existing, result: { idempotent_mapping_recovery: true } });
    return { ok: true, idempotent: true, work: finished };
  }
  await deps.armWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation) });
  let copied;
  try {
    copied = sourceIds.length > 1
      ? await deps.copyMany({ sourceChatId: ctx.source.chat_id, sourceMessageIds: sourceIds, destinationChatId: ctx.destination.chat_id })
      : await deps.copyOne({ sourceChatId: ctx.source.chat_id, sourceMessageId: sourceIds[0], destinationChatId: ctx.destination.chat_id });
  } catch (error) {
    if (isKnownTelegramFailure(error)) return { ok: false, knownFailure: true, retryable: error.errorCode === 429 || error.retryAfter != null, work: await finishKnownFailure(work, workerId, deps, error) };
    return { ok: false, ambiguous: true, work: await markAmbiguous(work, workerId, deps, error, { telegram_method: error?.method || null, partial_result: error?.partialResult || null }) };
  }
  try {
    const finished = await deps.finishCopy({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), destinationMessageIds: copied.destinationMessageIds, result: { destination_message_ids: copied.destinationMessageIds, album: sourceIds.length > 1 } });
    return { ok: true, work: finished };
  } catch (error) {
    return { ok: false, ambiguous: true, postCopyCommitFailure: true, work: await markAmbiguous(work, workerId, deps, error, { telegram_copy_succeeded: true, destination_message_ids: copied.destinationMessageIds }) };
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
    if (message.text) await deps.editText({ chatId: ctx.destination.chat_id, messageId: Number(mapping.destination_message_id), text: message.text, entities: message.text_entities || [] });
    else await deps.editCaption({ chatId: ctx.destination.chat_id, messageId: Number(mapping.destination_message_id), caption: message.caption, captionEntities: message.caption_entities || [] });
  } catch (error) {
    if (isKnownTelegramFailure(error)) return { ok: false, knownFailure: true, work: await finishKnownFailure(work, workerId, deps, error) };
    return { ok: false, ambiguous: true, work: await markAmbiguous(work, workerId, deps, error, { telegram_method: error?.method || null, partial_result: error?.partialResult || null }) };
  }
  try {
    const finished = await deps.finishEdit({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), result: { destination_message_id: Number(mapping.destination_message_id) } });
    return { ok: true, work: finished };
  } catch (error) {
    return { ok: false, ambiguous: true, postEditCommitFailure: true, work: await markAmbiguous(work, workerId, deps, error, { telegram_edit_succeeded: true, destination_message_id: Number(mapping.destination_message_id) }) };
  }
}

function entityLinkSignatures(entities) {
  return (Array.isArray(entities) ? entities : []).filter((entity) => entity?.type === 'text_link').map((entity) => `${Number(entity.offset)}:${Number(entity.length)}:${String(entity.url || '')}`).sort();
}

function verifyRewriteResult({ actual, expectedText, expectedEntities, isCaption, source }) {
  if (!actual || typeof actual !== 'object') return { ok: false, reason: 'rewrite_response_not_message' };
  const actualText = isCaption ? (actual.caption ?? '') : (actual.text ?? '');
  const actualEntities = isCaption ? (actual.caption_entities || []) : (actual.entities || []);
  if (actualText !== expectedText) return { ok: false, reason: 'rewrite_text_mismatch' };
  if (extractInternalLinks(actualText, source).length) return { ok: false, reason: 'source_literal_link_remains' };
  if (extractInternalEntityLinks(actualEntities, source).length) return { ok: false, reason: 'source_text_link_remains' };
  if (JSON.stringify(entityLinkSignatures(expectedEntities)) !== JSON.stringify(entityLinkSignatures(actualEntities))) return { ok: false, reason: 'rewrite_text_link_entity_mismatch' };
  return { ok: true };
}

async function processRewrite(work, ctx, workerId, deps) {
  const sourceMessageId = Number(work.source_message_id);
  const message = await deps.getSourceMessage(ctx.source.id, sourceMessageId);
  const mapping = await deps.getMapping(ctx.source.id, sourceMessageId, ctx.destination.id);
  if (!message || !mapping?.destination_message_id) throw new Error('distributor_rewrite_source_or_mapping_missing');
  const mappings = await deps.getMappings(ctx.destination.id);
  const sourceShape = { private_link_id: ctx.source.private_link_id, username: ctx.source.username };
  const destinationShape = { chat_id: ctx.destination.chat_id, username: ctx.destination.username };
  const isCaption = !message.text && message.caption != null;
  const originalText = message.text ?? message.caption;
  const originalEntities = message.text ? (message.text_entities || []) : (message.caption_entities || []);
  if (originalText == null) return { ok: false, dependency: true, work: await deps.blockDependency({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), errorCode: 'rewrite_content_missing', error: 'Internal-link message has no editable text/caption.', result: {} }) };
  const rewritten = rewriteTextAndEntities(originalText, originalEntities, { source: sourceShape, destination: destinationShape, mappings });
  if (rewritten.unresolved.length) return { ok: false, dependency: true, work: await deps.blockDependency({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), errorCode: 'rewrite_mapping_unresolved', error: `Unresolved source targets: ${rewritten.unresolved.join(',')}`, result: { unresolved_source_message_ids: rewritten.unresolved } }) };
  if (rewritten.rewritten < 1) return { ok: false, dependency: true, work: await deps.blockDependency({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), errorCode: 'rewrite_expected_link_missing', error: 'Message is flagged internal but no source-channel link was found.', result: {} }) };

  await deps.armWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation) });
  let actual;
  try {
    actual = isCaption
      ? await deps.editCaption({ chatId: ctx.destination.chat_id, messageId: Number(mapping.destination_message_id), caption: rewritten.text, captionEntities: rewritten.entities })
      : await deps.editText({ chatId: ctx.destination.chat_id, messageId: Number(mapping.destination_message_id), text: rewritten.text, entities: rewritten.entities });
  } catch (error) {
    if (isKnownTelegramFailure(error)) return { ok: false, knownFailure: true, work: await finishKnownFailure(work, workerId, deps, error) };
    return { ok: false, ambiguous: true, work: await markAmbiguous(work, workerId, deps, error) };
  }
  const verification = verifyRewriteResult({ actual, expectedText: rewritten.text, expectedEntities: rewritten.entities, isCaption, source: sourceShape });
  if (!verification.ok) {
    const error = new Error(verification.reason); error.code = verification.reason;
    return { ok: false, ambiguous: true, work: await markAmbiguous(work, workerId, deps, error, { telegram_rewrite_succeeded: true }) };
  }
  try {
    const finished = await deps.finishRewrite({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), result: { destination_message_id: Number(mapping.destination_message_id), rewritten_links: rewritten.rewritten, actual_verified: true } });
    return { ok: true, work: finished };
  } catch (error) {
    return { ok: false, ambiguous: true, postRewriteCommitFailure: true, work: await markAmbiguous(work, workerId, deps, error, { telegram_rewrite_succeeded: true }) };
  }
}

async function processPin(work, ctx, workerId, deps) {
  let destinationMessageId = null;
  if (work.operation_kind === 'pin_set') {
    const mapping = await deps.getMapping(ctx.source.id, Number(work.source_message_id), ctx.destination.id);
    destinationMessageId = Number(mapping?.destination_message_id || 0) || null;
    if (!destinationMessageId) return { ok: false, dependency: true, work: await deps.blockDependency({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), errorCode: 'pin_mapping_missing', error: 'Pinned source message has no destination mapping.', result: {} }) };
  }
  await deps.armWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation) });
  try {
    if (work.operation_kind === 'pin_set') await deps.pinMessage({ chatId: ctx.destination.chat_id, messageId: destinationMessageId });
    else await deps.unpinAll({ chatId: ctx.destination.chat_id });
  } catch (error) {
    if (isKnownTelegramFailure(error)) return { ok: false, knownFailure: true, work: await finishKnownFailure(work, workerId, deps, error) };
    return { ok: false, ambiguous: true, work: await markAmbiguous(work, workerId, deps, error) };
  }
  try {
    return { ok: true, work: await deps.finishPin({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), result: { destination_message_id: destinationMessageId, cleared: work.operation_kind === 'pin_clear' } }) };
  } catch (error) {
    return { ok: false, ambiguous: true, postPinCommitFailure: true, work: await markAmbiguous(work, workerId, deps, error, { telegram_pin_succeeded: true }) };
  }
}

async function processVerify(work, ctx, workerId, deps) {
  let sourceChat;
  let destinationChat;
  try {
    sourceChat = await deps.getChat({ chatId: ctx.source.chat_id });
    destinationChat = await deps.getChat({ chatId: ctx.destination.chat_id });
  } catch (error) {
    if (isKnownTelegramFailure(error)) return { ok: false, knownFailure: true, work: await finishKnownFailure(work, workerId, deps, error, { safeRetry: true }) };
    const wrapped = error instanceof Error ? error : new Error(String(error));
    return { ok: false, knownFailure: true, work: await deps.finishWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), outcome: 'known_failure', retryable: true, retryAfterSeconds: 30, errorCode: 'telegram_verify_read_failure', error: errorText(wrapped), result: {} }) };
  }

  const actualSourcePinned = Number(sourceChat?.pinned_message?.message_id || 0) || null;
  const expectedSourcePinned = Number(ctx.run.desired_pin_source_message_id || 0) || null;
  if (actualSourcePinned !== expectedSourcePinned) {
    return { ok: false, dependency: true, work: await deps.blockDependency({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), errorCode: 'source_pin_changed_during_verify', error: `Source pin changed from ${expectedSourcePinned ?? 'none'} to ${actualSourcePinned ?? 'none'} during verification.`, result: { expected_source_pinned_message_id: expectedSourcePinned, actual_source_pinned_message_id: actualSourcePinned } }) };
  }

  const actualPinned = Number(destinationChat?.pinned_message?.message_id || 0) || null;
  try {
    const run = await deps.finishVerify({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), actualPinnedDestinationMessageId: actualPinned, summary: { source_chat_id: String(ctx.source.chat_id), source_pin_verified: true, destination_chat_id: String(ctx.destination.chat_id), destination_chat_verified: true } });
    return { ok: true, run, work: { id: work.id, status: run.phase === 'ready_for_new' ? 'done' : 'skipped' } };
  } catch (error) {
    return { ok: false, dependency: true, work: await deps.blockDependency({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), errorCode: 'final_verification_failed', error: errorText(error), result: { actual_pinned_destination_message_id: actualPinned } }) };
  }
}

export const defaultDistributorEngineDeps = Object.freeze({
  getRun: (id) => one(TABLES.cloneRuns, `select=*&id=eq.${encodeURIComponent(id)}&limit=1`),
  getSource: (id) => one(TABLES.sources, `select=*&id=eq.${encodeURIComponent(id)}&limit=1`),
  getDestination: (id) => one(TABLES.destinations, `select=*&id=eq.${encodeURIComponent(id)}&limit=1`),
  getSourceMessage,
  getMapping,
  getMappings,
  armWork: armDistributorWork,
  finishWork: finishDistributorWork,
  finishCopy: finishDistributorCopy,
  finishEdit: finishDistributorEdit,
  finishRewrite: finishDistributorRewrite,
  finishPin: finishDistributorPin,
  finishVerify: finishDistributorVerify,
  blockDependency: blockDistributorDependency,
  prepareCatchup: prepareDistributorCatchup,
  prepareFidelity: prepareDistributorFidelity,
  prepareVerification: prepareDistributorVerification,
  copyOne: copyOneSafely,
  copyMany: copyManySafely,
  editText: editTextSafely,
  editCaption: editCaptionSafely,
  pinMessage: pinMessageSafely,
  unpinAll: unpinAllMessagesSafely,
  getChat: getChatSafely
});

export async function advanceDistributorRun(runId, { deps = defaultDistributorEngineDeps } = {}) {
  let run = await deps.getRun(runId);
  if (!run || run.status !== 'active') return run;
  if (['backfilling','catching_up'].includes(run.phase)) run = await deps.prepareCatchup({ runId });
  if (!run || run.status !== 'active') return run;
  if (run.phase === 'rewriting') {
    const source = await deps.getSource(run.source_id);
    if (!source) throw new Error('distributor_source_missing_for_fidelity');
    const sourceChat = await deps.getChat({ chatId: source.chat_id });
    const pinnedSourceMessageId = Number(sourceChat?.pinned_message?.message_id || 0) || null;
    run = await deps.prepareFidelity({ runId, pinnedSourceMessageId });
    run = await deps.prepareVerification({ runId });
  }
  return run;
}

export async function processDistributorWork(work, { workerId, deps = defaultDistributorEngineDeps } = {}) {
  if (!work?.id || !work?.run_id) throw new Error('distributor_work_required');
  if (!workerId) throw new Error('distributor_worker_id_required');
  const ctx = await loadContext(work, deps);
  try {
    let result;
    if (work.operation_kind === 'copy' && ['copy','catchup'].includes(work.phase)) result = await processCopy(work, ctx, workerId, deps);
    else if (work.operation_kind === 'edit' && work.phase === 'catchup') result = await processEdit(work, ctx, workerId, deps);
    else if (work.operation_kind === 'rewrite' && work.phase === 'rewrite') result = await processRewrite(work, ctx, workerId, deps);
    else if (['pin_set','pin_clear'].includes(work.operation_kind) && work.phase === 'pin') result = await processPin(work, ctx, workerId, deps);
    else if (work.operation_kind === 'verify' && work.phase === 'verify') result = await processVerify(work, ctx, workerId, deps);
    else throw new Error(`distributor_work_operation_unsupported:${work.phase}/${work.operation_kind}`);
    if (result.ok) {
      try {
        if (['copy','catchup'].includes(work.phase)) await advanceDistributorRun(work.run_id, { deps });
        else if (['rewrite','pin'].includes(work.phase)) await deps.prepareVerification({ runId: work.run_id });
      } catch {}
    }
    return result;
  } catch (error) {
    const beforeSideEffect = work.side_effect_state !== 'armed';
    if (beforeSideEffect) {
      try {
        const finished = await deps.finishWork({ workId: work.id, workerId, leaseGeneration: Number(work.lease_generation), outcome: 'known_failure', retryable: false, errorCode: 'distributor_preflight_failure', error: errorText(error), result: {} });
        return { ok: false, knownFailure: true, retryable: false, work: finished, error };
      } catch {}
    }
    return { ok: false, error };
  }
}
