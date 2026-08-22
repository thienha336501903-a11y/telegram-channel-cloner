import assert from 'node:assert/strict';
import fs from 'node:fs';

const doc = fs.readFileSync(new URL('../README_RECONCILE.md', import.meta.url), 'utf8');
assert.match(doc, /upper_bound_message_id/);
assert.match(doc, /cannot be deleted by that reconcile run/);
assert.match(doc, /session, OTP, 2FA password, API hash and reader secret stay on the Windows reader PC/);
