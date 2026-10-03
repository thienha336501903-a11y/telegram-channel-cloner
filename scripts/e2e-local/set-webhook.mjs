const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const publicUrl = String(process.env.E2E_PUBLIC_URL || '').replace(/\/$/, '');
const deleting = process.argv.includes('--delete');
const assertingUnset = process.argv.includes('--assert-unset');

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (deleting && assertingUnset) throw new Error('Choose one webhook operation');
if (!deleting && !assertingUnset && (!secret || !publicUrl)) throw new Error('TELEGRAM_WEBHOOK_SECRET and E2E_PUBLIC_URL are required');

if (assertingUnset) {
  const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) throw new Error('Could not inspect TEST bot webhook');
  if (payload.result?.url) throw new Error('TEST bot already has a webhook; do not replace it');
  console.log('E2E_TEST_WEBHOOK_UNSET');
  process.exit(0);
}

if (deleting && process.env.E2E_TWO_DESTINATION_PILOT === 'true') {
  const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) throw new Error('Could not inspect TEST webhook before cleanup');
  const expected = `${publicUrl}/api/telegram/webhook`;
  if (payload.result?.url !== expected) {
    throw new Error('TEST webhook changed during the run; preserve it for manual reconciliation');
  }
}

const method = deleting ? 'deleteWebhook' : 'setWebhook';
const body = deleting
  ? { drop_pending_updates: false }
  : {
      url: `${publicUrl}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ['channel_post', 'edited_channel_post'],
      drop_pending_updates: true
    };

const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const payload = await response.json();
if (!response.ok || payload?.ok !== true) throw new Error(`${method} failed: ${JSON.stringify(payload)}`);
console.log(deleting ? 'E2E_TEST_WEBHOOK_DELETED' : `E2E_TEST_WEBHOOK_SET ${body.url}`);
