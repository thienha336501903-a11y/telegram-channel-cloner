import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('admin renders webhook state from Telegram instead of a remembered click', () => {
  assert.match(page, /api\('\/api\/admin\/webhook'\)/);
  assert.match(page, /actual===expected/);
  assert.match(page, /✓ Đã kết nối Webhook/);
  assert.match(page, /Kết nối Webhook/);
});

test('connected webhook is visually distinct and cannot be needlessly submitted', () => {
  assert.match(page, /button\.disabled=connected/);
  assert.match(page, /classList\.toggle\('connected',connected\)/);
  assert.match(page, /aria-live="polite"/);
});
