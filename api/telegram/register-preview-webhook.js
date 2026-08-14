import { json } from '../../lib/http.js';
import { requireEnv } from '../../lib/env.js';
import { telegram } from '../../lib/telegram.js';

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') return json(res, 404, { ok: false, error: 'not_found' });
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  const host = String(req.headers.host || '').trim();
  if (!host || !host.endsWith('.vercel.app')) return json(res, 400, { ok: false, error: 'invalid_host' });

  const secretToken = requireEnv('TELEGRAM_WEBHOOK_SECRET');
  const url = `https://${host}/api/telegram/webhook`;
  const result = await telegram('setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['channel_post', 'edited_channel_post'],
    drop_pending_updates: false
  });

  return json(res, 200, { ok: Boolean(result), webhookUrl: url });
}
