// Read-only Bot API preflight for the isolated 1→2 TEST channels. This gate
// runs before local DB setup, TEST webhook change, or Telegram copy.
import { pathToFileURL } from 'node:url';

const SOURCE = '-1004320185488';
const DESTINATIONS = ['-1003933578709', '-1004492904064'];
const TEST_BOT_ID = '8656010848';
const OWNER_ID = '6699534762';
const SYSTEM_C_BOT_ID = '8754108695';

export async function verifyTwoTestBotAccess({ token, source = SOURCE, destinations = DESTINATIONS, fetchImpl = fetch }) {
  if (!token || source !== SOURCE || !Array.isArray(destinations) || destinations.length !== 2 ||
      [...destinations].sort().join(',') !== [...DESTINATIONS].sort().join(',')) {
    throw new Error('Isolated 1to2 TEST bot preflight identity mismatch');
  }

  async function call(method, body = {}) {
    let response;
    let payload;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000)
      });
      payload = await response.json();
    } catch {
      // Never include a request URL in an error: the Bot API URL contains the token.
      throw new Error(`TEST bot ${method} read failed; no TEST destination write started`);
    }
    if (!response.ok || payload?.ok !== true) {
      throw new Error(`TEST bot ${method} rejected; no TEST destination write started`);
    }
    return payload.result;
  }

  const bot = await call('getMe');
  if (String(bot?.username || '').toLowerCase() !== 'yeubep_distributor_test_bot' ||
      String(bot?.id || '') !== TEST_BOT_ID) {
    throw new Error('Dedicated TEST bot identity mismatch');
  }

  for (const chatId of [SOURCE, ...DESTINATIONS]) {
    const member = await call('getChatMember', { chat_id: chatId, user_id: bot.id });
    if (!['administrator', 'creator'].includes(member?.status)) {
      throw new Error(`TEST bot is not an administrator of ${chatId}`);
    }
    if (chatId !== SOURCE && (!member.can_post_messages || !member.can_edit_messages)) {
      throw new Error(`TEST bot needs channel post/edit/pin rights in ${chatId}`);
    }
    console.log(`E2E_1TO2_TEST_BOT_ADMIN_PASS ${chatId}`);
  }

  for (const chatId of DESTINATIONS) {
    // Bot API 10.0 omits other bots by default. Without return_bots=true this
    // preflight could miss the System C bot already found in both channels.
    const admins = await call('getChatAdministrators', { chat_id: chatId, return_bots: true });
    const systemC = await call('getChatMember', { chat_id: chatId, user_id: Number(SYSTEM_C_BOT_ID) });
    if (!systemC || systemC.status === 'creator' ||
        (systemC.status === 'administrator' && systemC.can_post_messages !== false)) {
      throw new Error(`System C bot can still post or its permission is unknown in ${chatId}; no copy started`);
    }
    if (!Array.isArray(admins) || !admins.some((row) =>
      String(row?.user?.id || '') === TEST_BOT_ID && row.can_post_messages === true) ||
      !admins.some((row) => String(row?.user?.id || '') === OWNER_ID && row.status === 'creator')) {
      throw new Error(`TEST destination administrator inventory incomplete: ${chatId}`);
    }
    const otherPublishers = admins.filter((row) =>
      ![TEST_BOT_ID, OWNER_ID].includes(String(row?.user?.id || '')) &&
      (row?.status === 'creator' || row?.can_post_messages !== false));
    if (otherPublishers.length) {
      throw new Error(`TEST destination ${chatId} still has another publishing administrator; no copy started`);
    }
    console.log(`E2E_1TO2_WRITER_ACCESS_PASS ${chatId} bot=${TEST_BOT_ID} owner=${OWNER_ID}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyTwoTestBotAccess({
    token: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    source: process.env.E2E_SOURCE_CHAT_ID,
    destinations: String(process.env.E2E_DESTINATION_CHAT_IDS || '').split(',')
  });
}
