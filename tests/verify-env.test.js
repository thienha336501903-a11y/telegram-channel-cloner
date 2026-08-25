import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const requiredEnv = Object.freeze({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'placeholder',
  ADMIN_PASSWORD: 'placeholder-admin',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuv',
  TELEGRAM_WEBHOOK_SECRET: '0123456789abcdef0123456789abcdef',
  READER_INGEST_SECRET: '0123456789abcdef0123456789abcdef',
  CRON_SECRET: '0123456789abcdef0123456789abcdef',
  INTERNAL_SYNC_SECRET: '0123456789abcdef0123456789abcdef'
});

function verify(extraEnv = {}) {
  return spawnSync(process.execPath, ['scripts/verify-env.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...requiredEnv, ...extraEnv },
    encoding: 'utf8'
  });
}

test('System B remains build-compatible when Clone Factory URL variables are absent', () => {
  const result = verify({
    CLONER_PUBLIC_URL: '',
    LMS_PUBLIC_URL: '',
    V4_PUBLIC_URL: ''
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runtime environment validation passed/);
});

test('configured System C Clone Factory URLs must be HTTPS origins', () => {
  const result = verify({
    CLONER_PUBLIC_URL: 'https://reader.example.com',
    LMS_PUBLIC_URL: 'http://learn.example.com',
    V4_PUBLIC_URL: 'https://player.example.com'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LMS_PUBLIC_URL: must be an HTTPS origin without a path/);
});
