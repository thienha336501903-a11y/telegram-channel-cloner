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

test('V4 playback allows current System B LMS previews owned by the known Vercel teams', () => {
  assert.equal(
    isConfiguredV4Origin('https://yeunauan-lms-v4-test-9r4yq3md5-thienha336501903-a11ys-projects.vercel.app', {}),
    true
  );
  assert.equal(
    isConfiguredV4Origin('https://yeunauan-lms-v4-test-git-345a2b-thienha336501903-a11ys-projects.vercel.app', {}),
    true
  );
  assert.equal(
    isConfiguredV4Origin('https://yeunauan-lms-clone-abc123-thienha100022653824678-stacks-projects.vercel.app', {}),
    true
  );
  assert.equal(
    isConfiguredV4Origin('https://yeunauan-lms-git-feature123-thienha100022653824678-stacks-projects.vercel.app', {}),
    true
  );
});

test('V4 playback rejects look-alike Vercel hosts outside the owned teams', () => {
  assert.equal(isConfiguredV4Origin('https://yeunauan-lms-v4-test-attacker.vercel.app', {}), false);
  assert.equal(isConfiguredV4Origin('https://yeunauan-lms-clone-attacker-team.vercel.app', {}), false);
  assert.equal(
    isConfiguredV4Origin('https://yeunauan-lms-v4-test-abc-attacker-projects.vercel.app', {}),
    false
  );
});
