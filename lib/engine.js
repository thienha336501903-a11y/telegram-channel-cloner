import { cloneSafetyConfig } from './env.js';
import { editCaption, editText, copyOne, copyMany, pin, retryAfterSeconds } from './telegram.js';
import { rewriteTextAndEntities } from './links.js';
import { finishItem, getMappings, getSourceMessage, listDestinations, listSources, logEvent, upsertMapping, updateJobStatus } from './repository.js';
import { select } from './supabase.js';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function loadContext(item) {
  const job = item.clone_jobs;
  const sources = await listSources();
  const source = sources.find((s) => s.id === job.source_id);
  const destinations = await listDestinations();
  const destination = destinations.find((d) => d.id === job.destination_id);
  if (!source || !destination) throw new Error('Source or destination not found');
  const message = await getSourceMessage(source.id, item.source_message_id);
  if (!message) throw new Error(`Source message ${item.source_message_id} not indexed`);
  return { job, source, destination, message };
}

async function mappingFor(sourceId, sourceMessageId, destinationId) {
  const rows = await select('message_mappings', `select=*&source_id=eq.${sourceId}&source_message_id=eq.${sourceMessageId}&destination_id=eq.${destinationId}&limit=1`);
  return rows?.[0] || null;
}

async function processCopy(item, ctx) {
  const ids = Array.isArray(item.source_message_ids) && item.source_message_ids.length
    ? item.source_message_ids.map(Number)
    : [Number(ctx.message.source_message_id)];

  const existingRows = [];
  for (const sourceMessageId of ids) {
    existingRows.push(await mappingFor(ctx.source.id, sourceMessageId, ctx.destination.id));
  }
  if (existingRows.every((m) => m?.status === 'copied' && m.destination_message_id)) {
    await finishItem(item.id, { status: 'done', result: { idempotent: true, destination_message_ids: existingRows.map((m) => m.destination_message_id) } });
    return;
  }

  if (ids.length > 1) {
    const result = await copyMany({ sourceChatId: ctx.source.chat_id, sourceMessageIds: ids, destinationChatId: ctx.destination.chat_id });
    const destIds = (result || []).map((x) => Number(x.message_id));
    if (destIds.length !== ids.length) throw new Error(`Album copy count mismatch: source=${ids.length} destination=${destIds.length}`);
    for (let i = 0; i < ids.length; i++) {
      await upsertMapping({ source_id: ctx.source.id, source_message_id: ids[i], destination_id: ctx.destination.id, destination_message_id: destIds[i], status: 'copied' });
    }
    await finishItem(item.id, { status: 'done', result: { destination_message_ids: destIds, album: true } });
    return;
  }

  const result = await copyOne({ sourceChatId: ctx.source.chat_id, sourceMessageId: ids[0], destinationChatId: ctx.destination.chat_id });
  const destinationMessageId = Number(result.message_id);
  await upsertMapping({ source_id: ctx.source.id, source_message_id: ids[0], destination_id: ctx.destination.id, destination_message_id: destinationMessageId, status: 'copied' });
  await finishItem(item.id, { status: 'done', result: { destination_message_id: destinationMessageId } });
}

async function processRewrite(item, ctx) {
  const mapping = await mappingFor(ctx.source.id, ctx.message.source_message_id, ctx.destination.id);
  if (!mapping?.destination_message_id) throw new Error('Destination mapping is missing');
  const mappings = await getMappings(ctx.destination.id);
  const sourceShape = { private_link_id: ctx.source.private_link_id, username: ctx.source.username };
  const destinationShape = { chat_id: ctx.destination.chat_id, username: ctx.destination.username };

  if (ctx.message.text) {
    const result = rewriteTextAndEntities(ctx.message.text, ctx.message.text_entities || [], { source: sourceShape, destination: destinationShape, mappings });
    if (result.unresolved.length) {
      await finishItem(item.id, { status: 'queued', retry_after: new Date(Date.now() + 30_000).toISOString(), last_error: `Waiting for mappings: ${result.unresolved.join(',')}` });
      return;
    }
    await editText({ chatId: ctx.destination.chat_id, messageId: mapping.destination_message_id, text: result.text, entities: result.entities });
  } else if (ctx.message.caption) {
    const result = rewriteTextAndEntities(ctx.message.caption, ctx.message.caption_entities || [], { source: sourceShape, destination: destinationShape, mappings });
    if (result.unresolved.length) {
      await finishItem(item.id, { status: 'queued', retry_after: new Date(Date.now() + 30_000).toISOString(), last_error: `Waiting for mappings: ${result.unresolved.join(',')}` });
      return;
    }
    await editCaption({ chatId: ctx.destination.chat_id, messageId: mapping.destination_message_id, caption: result.text, captionEntities: result.entities });
  }
  await finishItem(item.id, { status: 'done', last_error: null });
}

async function processPin(item, ctx) {
  const mapping = await mappingFor(ctx.source.id, ctx.message.source_message_id, ctx.destination.id);
  if (!mapping?.destination_message_id) {
    await finishItem(item.id, { status: 'queued', retry_after: new Date(Date.now() + 30_000).toISOString(), last_error: 'Waiting for destination mapping before pin' });
    return;
  }
  await pin({ chatId: ctx.destination.chat_id, messageId: mapping.destination_message_id });
  await finishItem(item.id, { status: 'done', last_error: null, result: { pinned_message_id: mapping.destination_message_id } });
}

export async function processItem(item) {
  const ctx = await loadContext(item);
  try {
    if (item.phase === 'copy') await processCopy(item, ctx);
    else if (item.phase === 'rewrite') await processRewrite(item, ctx);
    else if (item.phase === 'pin') await processPin(item, ctx);
    else throw new Error(`Unsupported phase: ${item.phase}`);
    await updateJobStatus(ctx.job.id);
    await logEvent({ source_id: ctx.source.id, destination_id: ctx.destination.id, source_message_id: ctx.message.source_message_id, event_type: `item_${item.phase}_ok`, payload: {} });
    return { ok: true };
  } catch (error) {
    const retry = retryAfterSeconds(error);
    const attempts = Number(item.attempts || 0);
    const canRetry = retry != null || attempts < 5;
    await finishItem(item.id, {
      status: canRetry ? 'queued' : 'failed',
      last_error: String(error.message || error),
      retry_after: retry ? new Date(Date.now() + (retry + 2) * 1000).toISOString() : null
    });
    await updateJobStatus(ctx.job.id);
    await logEvent({ source_id: ctx.source.id, destination_id: ctx.destination.id, source_message_id: ctx.message.source_message_id, event_type: 'item_error', payload: { error: String(error.message || error), retry_after: retry } });
    return { ok: false, retryAfter: retry, error };
  }
}

export async function runTick(claimFn) {
  const cfg = cloneSafetyConfig();
  const items = await claimFn(cfg.maxWritesPerTick);
  const results = [];
  const touchedDestinations = new Set();
  for (const item of items) {
    const destinationId = item.clone_jobs?.destination_id;
    if (destinationId && !touchedDestinations.has(destinationId) && touchedDestinations.size >= cfg.maxDestinationsPerTick) break;
    if (destinationId) touchedDestinations.add(destinationId);
    results.push(await processItem(item));
    await sleep(cfg.minDestinationDelayMs);
  }
  return { config: cfg, processed: results.length, results: results.map((r) => ({ ok: r.ok, retryAfter: r.retryAfter || null })) };
}
