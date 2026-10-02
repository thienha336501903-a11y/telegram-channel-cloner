import { verifyTestBot } from './test-bot-identity.mjs';

const username = await verifyTestBot({
  token: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  expectedUsername: process.env.E2E_EXPECTED_TEST_BOT_USERNAME
});
console.log(`E2E_TEST_BOT_VERIFIED @${username}`);
