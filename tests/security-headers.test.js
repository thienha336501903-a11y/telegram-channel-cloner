import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const config = JSON.parse(read('vercel.json'));

test('all Telegram clone responses receive the structural security baseline', () => {
  const rule = config.headers.find(item => item.source === '/(.*)');
  assert.ok(rule);
  const headers = Object.fromEntries(rule.headers.map(item => [item.key, item.value]));
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.match(headers['Strict-Transport-Security'], /max-age=31536000/);
  assert.match(headers['Content-Security-Policy'], /object-src 'none'/);
  assert.match(headers['Content-Security-Policy'], /form-action 'self'/);
  assert.match(headers['Content-Security-Policy'], /upgrade-insecure-requests/);
});

test('logout is POST-only and keeps the hardened session cookie clear', () => {
  const logout = read('api/auth/logout.js');
  const auth = read('lib/auth.js');
  assert.match(logout, /method\(req, res, \['POST'\]\)/);
  assert.match(auth, /HttpOnly; Secure; SameSite=Strict; Max-Age=0/);
});
