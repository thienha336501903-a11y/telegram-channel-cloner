import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ['test','token'].join('-');

import { processDistributorWork } from '../lib/distributor-engine.js';

function harness(overrides = {}) {
  const calls = [];
  const ctx = {
    run: {
      id: 'run-1', source_id: 'source-1', destination_id: 'dest-1',
      phase: 'rewriting', status: 'active', desired_pin_source_message_id: 20,
      desired_pin_destination_message_id: 9020
    },
    source: { id: 'source-1', chat_id: '-100111', private_link_id: '111', username: null },
    destination: { id: 'dest-1', source_id: 'source-1', chat_id: '-100222', username: null }
  };
  const message = {
    source_message_id: 10,
    text: 'Mục lục: https://t.me/c/111/20',
    text_entities: [], caption: null, caption_entities: [], has_internal_links: true
  };
  const deps = {
    getRun: async () => ctx.run,
    getSource: async () => ctx.source,
    getDestination: async () => ctx.destination,
    getSourceMessage: async () => message,
    getMapping: async (_source, sourceMessageId) => ({ status: 'copied', source_message_id: sourceMessageId, destination_message_id: sourceMessageId === 20 ? 9020 : 9010 }),
    getMappings: async () => new Map([[10,9010],[20,9020]]),
    armWork: async (args) => { calls.push(['arm', args]); return { id: args.workId }; },
    finishWork: async (args) => { calls.push(['finishWork', args]); return { id: args.workId, status: args.outcome }; },
    finishRewrite: async (args) => { calls.push(['finishRewrite', args]); return { id: args.workId, status: 'done' }; },
    finishPin: async (args) => { calls.push(['finishPin', args]); return { id: args.workId, status: 'done' }; },
    finishVerify: async (args) => { calls.push(['finishVerify', args]); return { ...ctx.run, phase: 'ready_for_new' }; },
    blockDependency: async (args) => { calls.push(['blockDependency', args]); return { id: args.workId, status: 'blocked_dependency' }; },
    prepareVerification: async (args) => { calls.push(['prepareVerification', args]); return ctx.run; },
    editText: async (args) => { calls.push(['editText', args]); return { message_id: args.messageId, text: args.text, entities: args.entities || [] }; },
    editCaption: async (args) => { calls.push(['editCaption', args]); return { message_id: args.messageId, caption: args.caption, caption_entities: args.captionEntities || [] }; },
    pinMessage: async (args) => { calls.push(['pinMessage', args]); return true; },
    unpinAll: async (args) => { calls.push(['unpinAll', args]); return true; },
    getChat: async ({ chatId }) => String(chatId) === ctx.source.chat_id
      ? { id: chatId, pinned_message: { message_id: 20 } }
      : { id: chatId, pinned_message: { message_id: 9020 } },
    ...overrides
  };
  return { deps, calls, ctx, message };
}

function work(kind, phase = 'rewrite', extra = {}) {
  return {
    id: `work-${kind}`, run_id: 'run-1', phase, operation_kind: kind,
    source_message_id: 10, manifest_message_ids: [10], lease_generation: 2,
    side_effect_state: phase === 'verify' ? 'not_applicable' : 'not_started',
    source_fingerprint: 'fp-current', ...extra
  };
}

test('rewrite changes a literal TOC link to the mapped destination and verifies Telegram response', async () => {
  const { deps, calls } = harness();
  const result = await processDistributorWork(work('rewrite'), { workerId: 'worker-r', deps });
  assert.equal(result.ok, true);
  const edit = calls.find((x) => x[0] === 'editText')[1];
  assert.equal(edit.text, 'Mục lục: https://t.me/c/222/9020');
  const finish = calls.find((x) => x[0] === 'finishRewrite')[1];
  assert.equal(finish.result.actual_verified, true);
  assert.equal(finish.result.rewritten_links, 1);
});

test('rewrite changes hidden text_link URL while preserving visible label', async () => {
  const hidden = {
    source_message_id: 10, text: 'Bài 1',
    text_entities: [{ type: 'text_link', offset: 0, length: 5, url: 'https://t.me/c/111/20' }],
    caption: null, caption_entities: [], has_internal_links: true
  };
  const { deps, calls } = harness({ getSourceMessage: async () => hidden });
  const result = await processDistributorWork(work('rewrite'), { workerId: 'worker-hidden', deps });
  assert.equal(result.ok, true);
  const edit = calls.find((x) => x[0] === 'editText')[1];
  assert.equal(edit.text, 'Bài 1');
  assert.equal(edit.entities[0].url, 'https://t.me/c/222/9020');
});

test('unresolved TOC target blocks before any Telegram side effect is armed', async () => {
  const { deps, calls } = harness({ getMappings: async () => new Map([[10,9010]]) });
  const result = await processDistributorWork(work('rewrite'), { workerId: 'worker-block', deps });
  assert.equal(result.dependency, true);
  assert.equal(calls.some((x) => x[0] === 'arm'), false);
  assert.equal(calls.find((x) => x[0] === 'blockDependency')[1].errorCode, 'rewrite_mapping_unresolved');
});

test('rewrite response that still exposes an Original link is quarantined ambiguous', async () => {
  const { deps, calls } = harness({
    editText: async (args) => ({ message_id: args.messageId, text: 'Mục lục: https://t.me/c/111/20', entities: [] })
  });
  const result = await processDistributorWork(work('rewrite'), { workerId: 'worker-bad-response', deps });
  assert.equal(result.ambiguous, true);
  assert.equal(calls.some((x) => x[0] === 'finishRewrite'), false);
  assert.equal(calls.find((x) => x[0] === 'finishWork')[1].outcome, 'ambiguous');
});

test('pin fidelity pins the mapped destination message', async () => {
  const { deps, calls } = harness();
  const pinWork = work('pin_set', 'pin', { source_message_id: 20, manifest_message_ids: [20] });
  const result = await processDistributorWork(pinWork, { workerId: 'worker-pin', deps });
  assert.equal(result.ok, true);
  assert.equal(calls.find((x) => x[0] === 'pinMessage')[1].messageId, 9020);
  assert.ok(calls.some((x) => x[0] === 'finishPin'));
});

test('final verify reads both source and destination pin before READY_FOR_NEW', async () => {
  const { deps, calls, ctx } = harness();
  ctx.run.phase = 'verifying';
  const result = await processDistributorWork(work('verify', 'verify'), { workerId: 'worker-v', deps });
  assert.equal(result.ok, true);
  const finish = calls.find((x) => x[0] === 'finishVerify')[1];
  assert.equal(finish.actualPinnedDestinationMessageId, 9020);
  assert.equal(finish.summary.source_pin_verified, true);
});

test('final verify blocks if Original pin changed after fidelity preparation', async () => {
  const { deps, calls, ctx } = harness({
    getChat: async ({ chatId }) => String(chatId) === '-100111'
      ? { id: chatId, pinned_message: { message_id: 21 } }
      : { id: chatId, pinned_message: { message_id: 9020 } }
  });
  ctx.run.phase = 'verifying';
  const result = await processDistributorWork(work('verify', 'verify'), { workerId: 'worker-pin-drift', deps });
  assert.equal(result.dependency, true);
  assert.equal(calls.some((x) => x[0] === 'finishVerify'), false);
  assert.equal(calls.find((x) => x[0] === 'blockDependency')[1].errorCode, 'source_pin_changed_during_verify');
});
