import crypto from 'crypto';
import { requireEnv } from '../lib/env.js';
import { patch } from '../lib/supabase.js';
import { telegram } from '../lib/telegram.js';
import { TABLES } from '../lib/tables.js';

if (process.env.VERCEL_ENV !== 'preview') process.exit(0);

const secret = requireEnv('TELEGRAM_WEBHOOK_SECRET');
const hash = crypto.createHash('sha256').update(secret).digest('hex');
const webhookUrl = 'https://yyiavtiwtekkocqpephr.supabase.co/functions/v1/tgcloner-telegram-webhook';

await patch(TABLES.settings, 'singleton=eq.true', {
  webhook_secret_sha256: hash,
  updated_at: new Date().toISOString()
});

await telegram('setWebhook', {
  url: webhookUrl,
  secret_token: secret,
  allowed_updates: ['channel_post', 'edited_channel_post'],
  drop_pending_updates: false
});

const info = await telegram('getWebhookInfo');
console.log('[edge-webhook-config]', JSON.stringify({
  ok: true,
  url: info?.url || null,
  pendingUpdateCount: Number(info?.pending_update_count || 0),
  lastErrorMessage: info?.last_error_message || null,
  lastErrorDate: info?.last_error_date || null
}));
