import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ['test','token'].join('-');

import {
  DistributorTelegramKnownFailure,
  DistributorTelegramAmbiguousFailure,
  copyManySafely,
  copyOneSafely
} from '../lib/distributor-telegram.js';
import { processDistributorWork } from '../lib/distributor-engine.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload)
  };
}

function baseContext() {
  return {
    run: { id: 'run-1', source_id: 'source-1', destination_id: 'dest-1', phase: 'backfilling', status: 'active' },
    source: { id: 'source-1', chat_id: '-100111' },
    destination: { id: 'dest-1', source_id: 'source-1', chat_id: '-100222' }
  };
}

function depsHarness(overrides = {}) {
  const calls = [];
  const ctx = baseContext();
  const deps = {
    getRun: async () => ctx.run,
    getSource: async () => ctx.source,
    getDestination: async () => ctx.destination,
    getSourceMessage: async () => ({
      source_message_id: 10,
      text: 'updated lesson',
      text_entities: [],
      caption: null,
      caption_entities: [],
      has_internal_links: false
    }),
    getMapping: async () => null,
    armWork: async (args) => { calls.push(['arm', args]); return { id: args.workId, side_effect_state: 'armed' }; },
    finishWork: async (args) => { calls.push(['finishWork', args]); return { id: args.workId, outcome: args.outcome }; },
    finishCopy: async (args) => { calls.push(['finishCopy', args]); return { id: args.workId, status: 'done' }; },
    finishEdit: async (args) => { calls.push(['finishEdit', args]); return { id: args.workId, status: 'done' }; },
    prepareCatchup: async (args) => { calls.push(['prepareCatchup', args]); return { id: args.runId }; },
    copyOne: async () => ({ destinationMessageIds: [9001] }),
    copyMany: async () => ({ destinationMessageIds: [9001, 9002] }),
    editText: async (args) => { calls.push(['editText', args]); return {}; },
    editCaption: async (args) => { calls.push(['editCaption', args]); return {}; },
    ...overrides
  };
  return { deps, calls, ctx };
}

function copyWork(ids = [10]) {
  return {
    id: 'work-1',
    run_id: 'run-1',
    phase: 'copy',
    operation_kind: 'copy',
    manifest_message_ids: ids,
    source_message_id: ids[0],
    lease_generation: 3,
    side_effect_state: 'not_started'
  };
}

test('safe copy classifies a structured Telegram 429 as known failure with retry_after', async () => {
  await assert.rejects(
    copyOneSafely({ sourceChatId: '-1001', sourceMessageId: 1, destinationChatId: '-1002' }, {
      fetchImpl: async () => response({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 17 } }, 429)
    }),
    (error) => {
      assert.ok(error instanceof DistributorTelegramKnownFailure);
      assert.equal(error.errorCode, 429);
      assert.equal(error.retryAfter, 17);
      return true;
    }
  );
});

test('safe copy treats transport loss as ambiguous instead of retryable failure', async () => {
  await assert.rejects(
    copyOneSafely({ sourceChatId: '-1001', sourceMessageId: 1, destinationChatId: '-1002' }, {
      fetchImpl: async () => { throw new Error('socket reset'); }
    }),
    (error) => error instanceof DistributorTelegramAmbiguousFailure && error.reason === 'transport_error'
  );
});

test('safe album copy quarantines partial copyMessages results', async () => {
  await assert.rejects(
    copyManySafely({ sourceChatId: '-1001', sourceMessageIds: [1,2,3], destinationChatId: '-1002' }, {
      fetchImpl: async () => response({ ok: true, result: [{ message_id: 101 }, { message_id: 102 }] })
    }),
    (error) => {
      assert.ok(error instanceof DistributorTelegramAmbiguousFailure);
      assert.equal(error.reason, 'partial_or_malformed_album_result');
      assert.deepEqual(error.partialResult.destinationMessageIds, [101,102]);
      return true;
    }
  );
});

test('copy worker arms before Telegram and commits mapping/work through finishCopy', async () => {
  const { deps, calls } = depsHarness();
  const result = await processDistributorWork(copyWork(), { workerId: 'worker-a', deps });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((x) => x[0]), ['arm','finishCopy','prepareCatchup']);
  assert.deepEqual(calls[1][1].destinationMessageIds, [9001]);
  assert.equal(calls[1][1].leaseGeneration, 3);
});

test('known Telegram 429 becomes retry_wait contract, never ambiguous', async () => {
  const known = new DistributorTelegramKnownFailure('copyMessage', {
    error_code: 429,
    description: 'Too Many Requests',
    parameters: { retry_after: 9 }
  }, 429);
  const { deps, calls } = depsHarness({ copyOne: async () => { throw known; } });
  const result = await processDistributorWork(copyWork(), { workerId: 'worker-a', deps });
  assert.equal(result.ok, false);
  assert.equal(result.knownFailure, true);
  const finish = calls.find((x) => x[0] === 'finishWork')[1];
  assert.equal(finish.outcome, 'known_failure');
  assert.equal(finish.retryable, true);
  assert.equal(finish.retryAfterSeconds, 9);
});

test('ambiguous Telegram transport result is quarantined and never blind retried', async () => {
  const ambiguous = new DistributorTelegramAmbiguousFailure('copyMessage', 'transport_error');
  const { deps, calls } = depsHarness({ copyOne: async () => { throw ambiguous; } });
  const result = await processDistributorWork(copyWork(), { workerId: 'worker-a', deps });
  assert.equal(result.ambiguous, true);
  const finish = calls.find((x) => x[0] === 'finishWork')[1];
  assert.equal(finish.outcome, 'ambiguous');
  assert.equal(finish.retryable, false);
});

test('Telegram success followed by mapping commit failure is marked ambiguous with observed destination ids', async () => {
  const { deps, calls } = depsHarness({
    finishCopy: async () => { throw new Error('database connection lost after copy'); }
  });
  const result = await processDistributorWork(copyWork(), { workerId: 'worker-a', deps });
  assert.equal(result.postCopyCommitFailure, true);
  assert.equal(result.ambiguous, true);
  const finish = calls.find((x) => x[0] === 'finishWork')[1];
  assert.equal(finish.outcome, 'ambiguous');
  assert.deepEqual(finish.result.destination_message_ids, [9001]);
});

test('existing complete mapping is recovered without another Telegram copy', async () => {
  let copyCalls = 0;
  const { deps, calls } = depsHarness({
    getMapping: async () => ({ status: 'copied', destination_message_id: 777 }),
    copyOne: async () => { copyCalls += 1; return { destinationMessageIds: [999] }; }
  });
  const result = await processDistributorWork(copyWork(), { workerId: 'worker-a', deps });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
  assert.equal(copyCalls, 0);
  assert.deepEqual(calls.find((x) => x[0] === 'finishCopy')[1].destinationMessageIds, [777]);
});

test('plain text catch-up edit uses mapped destination then atomically advances mapping fingerprint', async () => {
  const { deps, calls } = depsHarness({
    getMapping: async () => ({ status: 'copied', destination_message_id: 7001 })
  });
  const work = {
    id: 'work-edit', run_id: 'run-1', phase: 'catchup', operation_kind: 'edit',
    source_message_id: 10, manifest_message_ids: [10], lease_generation: 4,
    side_effect_state: 'not_started', source_fingerprint: 'fp-new'
  };
  const result = await processDistributorWork(work, { workerId: 'worker-e', deps });
  assert.equal(result.ok, true);
  assert.equal(calls.find((x) => x[0] === 'editText')[1].messageId, 7001);
  assert.ok(calls.some((x) => x[0] === 'finishEdit'));
});
