import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneConfig, isConfiguredV4Origin } from '../lib/clone-config.js';

test('Clone Factory defaults preserve the current System B production URLs', () => {
  const config = cloneConfig({});
  assert.equal(config.systemId, 'system-b');
  assert.equal(config.clonerPublicUrl, 'https://reader.yeubep.shop');
  assert.equal(config.lmsPublicUrl, 'https://hoc.yeubep.shop');
  assert.equal(config.v4PublicUrl, 'https://v4.daubepnho.store');
});

test('Clone Factory accepts an isolated System C URL set', () => {
  const env = {
    SYSTEM_ID: 'system-c',
    CLONER_PUBLIC_URL: 'reader.example.com',
    LMS_PUBLIC_URL: 'learn.example.com',
    V4_PUBLIC_URL: 'player.example.com'
  };
  const config = cloneConfig(env);
  assert.equal(config.systemId, 'system-c');
  assert.equal(config.clonerPublicUrl, 'https://reader.example.com');
  assert.equal(config.lmsPublicUrl, 'https://learn.example.com');
  assert.equal(config.v4PublicUrl, 'https://player.example.com');
  assert.equal(isConfiguredV4Origin('https://player.example.com', env), true);
});

test('Clone Factory rejects a non-HTTPS origin', () => {
  assert.throws(() => cloneConfig({ LMS_PUBLIC_URL: 'http://learn.example.com' }), /clone_config_invalid_https_origin/);
});
