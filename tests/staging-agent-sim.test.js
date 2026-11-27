import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStagingBase, assertStagingHealth, toAgentMessage } from '../scripts/staging/reader-agent-sim.mjs';
import { hasUsableReaderMtprotoMedia } from '../lib/reader-media.js';

test('simulator refuses Production and non-staging hosts', () => {
  assert.throws(() => assertStagingBase('https://reader.yeubep.shop'), /refused_production_host/);
  assert.throws(() => assertStagingBase('https://telegram-channel-cloner-h5oknut9f.vercel.app'), /refused_non_staging_host/);
  assert.throws(() => assertStagingBase('http://telegram-channel-cloner-git-staging-x.vercel.app'), /https/);
  assert.equal(assertStagingBase('https://telegram-channel-cloner-git-staging-team.vercel.app/x'), 'https://telegram-channel-cloner-git-staging-team.vercel.app');
});

test('simulator refuses a production or multi-channel deployment', () => {
  const ok = { ok: true, environment: 'preview', checks: { database: true }, channelAllowlist: { enabled: true, entries: 1 } };
  assert.doesNotThrow(() => assertStagingHealth(ok));
  assert.throws(() => assertStagingHealth({ ...ok, environment: 'production' }), /production/);
  assert.throws(() => assertStagingHealth({ ...ok, channelAllowlist: { enabled: true, entries: 11 } }), /exactly_1/);
});

test('fixture entries map to the Agent shape; voice and no_descriptor take the server skip path', () => {
  assert.equal(hasUsableReaderMtprotoMedia(toAgentMessage({ id: 5, type: 'photo' })), true);
  assert.equal(hasUsableReaderMtprotoMedia(toAgentMessage({ id: 6, type: 'video' })), true);
  assert.equal(hasUsableReaderMtprotoMedia(toAgentMessage({ id: 11, type: 'voice' })), false);
  assert.equal(hasUsableReaderMtprotoMedia(toAgentMessage({ id: 12, type: 'photo', no_descriptor: true })), false);
  const t = toAgentMessage({ id: 10, type: 'text', text: 'a https://t.me/c/1/4', pinned: true, album: 'a1' });
  assert.equal(t.text, 'a https://t.me/c/1/4');
  assert.equal(t.caption, null);
  assert.equal(t.is_pinned, true);
  assert.equal(t.media_group_id, 'a1');
  assert.throws(() => toAgentMessage({ id: 0 }), /fixture_bad_id/);
});
