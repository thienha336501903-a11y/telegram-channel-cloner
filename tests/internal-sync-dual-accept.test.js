import test from 'node:test';
import assert from 'node:assert/strict';
import { isInternalSyncAuthorized } from '../lib/auth.js';

const CUR = 'c'.repeat(40), NEXT = 'n'.repeat(40);
const req = (secret) => ({ headers: secret === undefined ? {} : { 'x-sync-secret': secret } });

function withEnv(env, fn) {
  const saved = { a: process.env.INTERNAL_SYNC_SECRET, b: process.env.INTERNAL_SYNC_SECRET_NEXT };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fn(); } finally {
    for (const [k, v] of [['INTERNAL_SYNC_SECRET', saved.a], ['INTERNAL_SYNC_SECRET_NEXT', saved.b]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('without NEXT only the current value is accepted (unchanged behaviour)', () => withEnv({ INTERNAL_SYNC_SECRET: CUR, INTERNAL_SYNC_SECRET_NEXT: undefined }, () => {
  assert.equal(isInternalSyncAuthorized(req(CUR)), true);
  assert.equal(isInternalSyncAuthorized(req(NEXT)), false);
  assert.equal(isInternalSyncAuthorized(req('')), false);
  assert.equal(isInternalSyncAuthorized(req(undefined)), false);
}));

test('during K-ISS both the current and the next value are accepted, nothing else', () => withEnv({ INTERNAL_SYNC_SECRET: CUR, INTERNAL_SYNC_SECRET_NEXT: NEXT }, () => {
  assert.equal(isInternalSyncAuthorized(req(CUR)), true);
  assert.equal(isInternalSyncAuthorized(req(NEXT)), true);
  assert.equal(isInternalSyncAuthorized(req('x'.repeat(40))), false);
  assert.equal(isInternalSyncAuthorized(req(CUR.slice(1))), false);
}));

test('empty settings never authorize an empty header', () => withEnv({ INTERNAL_SYNC_SECRET: undefined, INTERNAL_SYNC_SECRET_NEXT: '' }, () => {
  assert.equal(isInternalSyncAuthorized(req('')), false);
  assert.equal(isInternalSyncAuthorized(req(NEXT)), false);
}));
