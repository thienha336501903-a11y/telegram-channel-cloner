// Preflight only: no Telegram send/edit/pin and no webhook mutation.
const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const ids = ['-1004320185488', '-1003933578709', '-1004492904064'];
if (!token || process.env.E2E_SOURCE_CHAT_ID !== ids[0] ||
    [...String(process.env.E2E_DESTINATION_CHAT_IDS || '').split(',')].sort().join(',') !== ids.slice(1).sort().join(',')) {
  throw new Error('Isolated 1to2 TEST bot preflight identity mismatch');
}

async function call(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) throw new Error(`TEST bot ${method} failed; check its channel membership`);
  return payload.result;
}

const bot = await call('getMe');
if (String(bot.username || '').toLowerCase() !== 'yeubep_distributor_test_bot') {
  throw new Error('Dedicated TEST bot identity mismatch');
}
for (const chatId of ids) {
  const member = await call('getChatMember', { chat_id: chatId, user_id: bot.id });
  if (!['administrator', 'creator'].includes(member?.status)) {
    throw new Error(`TEST bot is not an administrator of ${chatId}`);
  }
  if (chatId !== ids[0] && (!member.can_post_messages || !member.can_edit_messages)) {
    throw new Error(`TEST bot needs channel post/edit/pin rights in ${chatId}`);
  }
  console.log(`E2E_1TO2_TEST_BOT_ADMIN_PASS ${chatId}`);
}
