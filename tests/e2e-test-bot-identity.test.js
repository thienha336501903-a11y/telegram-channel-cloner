import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyTestBot } from '../scripts/e2e-local/test-bot-identity.mjs';

test('existing-history copy accepts only the dedicated TEST bot before copying', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, result: { username: 'yeubep_distributor_test_bot' } }) });
  assert.equal(await verifyTestBot({ token: 'local-fixture', expectedUsername: '@yeubep_distributor_test_bot', fetchImpl }), 'yeubep_distributor_test_bot');
  await assert.rejects(
    verifyTestBot({ token: 'local-fixture', expectedUsername: 'another_bot', fetchImpl }),
    /Refusing E2E/
  );
});
