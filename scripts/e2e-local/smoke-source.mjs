import { patch } from '../../lib/supabase.js';
import { TABLES } from '../../lib/tables.js';
import { verifyTestBot } from './test-bot-identity.mjs';

const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const sourceChatId = String(process.env.E2E_SOURCE_CHAT_ID || '').trim();
const ingestSecret = String(process.env.READER_INGEST_SECRET || '').trim();
const webhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const expectedUsername = String(process.env.E2E_EXPECTED_TEST_BOT_USERNAME || 'yeubep_distributor_test_bot').replace(/^@/, '').trim().toLowerCase();
const localBase = String(process.env.E2E_LOCAL_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

if (!botToken || !sourceChatId || !ingestSecret || !webhookSecret) {
  throw new Error('Smoke E2E requires TELEGRAM_BOT_TOKEN, E2E_SOURCE_CHAT_ID, READER_INGEST_SECRET and TELEGRAM_WEBHOOK_SECRET');
}

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data?.ok) throw new Error(`Telegram ${method} failed: ${data?.description || response.status}`);
  return data.result;
}

async function localPost(path, headers, payload) {
  const response = await fetch(`${localBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!response.ok || data?.ok === false) throw new Error(`${path} failed: HTTP ${response.status}: ${text.slice(0, 500)}`);
  return data;
}

const actualUsername = await verifyTestBot({ token: botToken, expectedUsername });
console.log(`E2E_TEST_BOT_VERIFIED @${actualUsername}`);

await patch(TABLES.settings, 'singleton=eq.true', { distributor_v2_enabled: true, scheduler_enabled: false }, { returning: false });
await localPost('/api/reader/register-source', { Authorization: `Bearer ${ingestSecret}` }, { chat_id: sourceChatId });

// Dedicated TEST bot only. Clear stale updates so the next captured post belongs to this smoke run.
await telegram('deleteWebhook', { drop_pending_updates: true });
console.log('E2E_POST_SMOKE_MESSAGE_NOW');
console.log('Đăng đúng 1 bài TEXT mới vào kênh Nguồn TEST. Không gửi album/video ở vòng smoke này.');

let offset = 0;
let captured = null;
for (let cycle = 0; cycle < 12 && !captured; cycle += 1) {
  const updates = await telegram('getUpdates', {
    offset,
    timeout: 20,
    allowed_updates: ['channel_post']
  });
  for (const update of updates || []) {
    offset = Math.max(offset, Number(update.update_id || 0) + 1);
    const post = update.channel_post;
    if (!post) continue;
    if (String(post.chat?.id || '') !== sourceChatId) continue;
    if (typeof post.text !== 'string' || !post.text.trim()) {
      console.log('Ignored non-text source post during smoke run; post one plain text message.');
      continue;
    }
    captured = update;
    break;
  }
}
if (!captured) throw new Error('Timed out waiting for a new plain-text channel_post from the smoke source');

await localPost('/api/telegram/webhook', { 'x-telegram-bot-api-secret-token': webhookSecret }, captured);
console.log(`E2E_SMOKE_SOURCE_CAPTURED source=${sourceChatId} message_id=${captured.channel_post.message_id}`);
