import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTwoTestBotAccess } from '../scripts/e2e-local/verify-two-test-bot-access.mjs';

const destinations = ['-1003933578709', '-1004492904064'];
const testBot = { id: 8656010848, username: 'yeubep_distributor_test_bot', is_bot: true };
const owner = { id: 6699534762, username: 'bepbanhsunny', is_bot: false };
const systemC = { id: 8754108695, username: 'daubepnho_system_c_bot', is_bot: true };

function botApi({ systemCCanPost = false, omitSystemC = false, otherAdmin = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    const body = JSON.parse(options.body);
    requests.push({ method, body });
    let result;
    if (method === 'getMe') result = testBot;
    else if (method === 'getChatMember') {
      result = Number(body.user_id) === systemC.id
        ? omitSystemC ? { status: 'member' } : { status: 'administrator', can_post_messages: systemCCanPost }
        : { status: 'administrator', can_post_messages: true, can_edit_messages: true };
    } else if (method === 'getChatAdministrators') {
      assert.equal(body.return_bots, true, 'include other bots in the administrator list');
      result = [
        { user: testBot, status: 'administrator', can_post_messages: true },
        { user: owner, status: 'creator' },
        ...(omitSystemC ? [] : [{ user: systemC, status: 'administrator', can_post_messages: systemCCanPost }]),
        ...(otherAdmin ? [{ user: { id: 12345678, is_bot: true }, status: 'administrator', can_post_messages: true }] : [])
      ];
    } else throw new Error(`Unexpected Bot API method ${method}`);
    return { ok: true, json: async () => ({ ok: true, result }) };
  };
  return { requests, fetchImpl };
}

test('blocks a second posting bot before any TEST write', async () => {
  const { fetchImpl, requests } = botApi({ systemCCanPost: true });
  await assert.rejects(
    verifyTwoTestBotAccess({ token: 'test-fixture', fetchImpl }),
    /System C bot can still post/
  );
  assert.equal(requests.filter((row) => row.method === 'getChatAdministrators').length, 1);
});

test('accepts both TEST destinations after the other bot loses posting rights', async () => {
  const { fetchImpl, requests } = botApi();
  await verifyTwoTestBotAccess({ token: 'test-fixture', fetchImpl });
  assert.deepEqual(
    requests.filter((row) => row.method === 'getChatAdministrators').map((row) => row.body.chat_id),
    destinations
  );
  assert.equal(requests.filter((row) => row.method === 'getChatMember').length, 5);
});

test('accepts removal of the other bot but blocks an identity mismatch', async () => {
  await verifyTwoTestBotAccess({ token: 'test-fixture', fetchImpl: botApi({ omitSystemC: true }).fetchImpl });
  await assert.rejects(
    verifyTwoTestBotAccess({ token: 'test-fixture', source: '-1000000000000', fetchImpl: botApi().fetchImpl }),
    /identity mismatch/
  );
});

test('rejects an unknown publishing administrator even if System C was disabled', async () => {
  await assert.rejects(
    verifyTwoTestBotAccess({ token: 'test-fixture', fetchImpl: botApi({ otherAdmin: true }).fetchImpl }),
    /another publishing administrator/
  );
});
