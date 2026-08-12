import { isAuthenticated } from '../../lib/auth.js';
import { requireEnv } from '../../lib/env.js';
import { json, method } from '../../lib/http.js';
import { telegram } from '../../lib/telegram.js';

function webhookSecret() {
  const value = requireEnv('TELEGRAM_WEBHOOK_SECRET');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(value)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16-256 chars using only A-Z, a-z, 0-9, _ or -');
  }
  return value;
}

function currentOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host || !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) throw new Error('Unable to determine safe deployment host');
  return `https://${host}`;
}

export default async function handler(req, res) {
  if (!isAuthenticated(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (!method(req, res, ['GET', 'POST'])) return;

  if (req.method === 'GET') {
    const info = await telegram('getWebhookInfo');
    return json(res, 200, { ok: true, webhook: info });
  }

  const url = `${currentOrigin(req)}/api/telegram/webhook`;
  const result = await telegram('setWebhook', {
    url,
    secret_token: webhookSecret(),
    allowed_updates: ['channel_post', 'edited_channel_post'],
    drop_pending_updates: false,
    max_connections: 5
  });
  const info = await telegram('getWebhookInfo');
  json(res, 200, { ok: Boolean(result), url, webhook: info });
}
