import { json } from '../lib/http.js';
import { select } from '../lib/supabase.js';
import { telegram } from '../lib/telegram.js';

export default async function handler(req, res) {
  let database = false;
  let databaseError = null;
  try {
    await select('tgcloner_sources', 'select=id&limit=1');
    database = true;
  } catch (err) {
    databaseError = err?.details?.code || err?.message || 'db_unavailable';
  }

  let bot = null;
  let botError = null;
  if (String(req.query?.bot || '') === '1') {
    try {
      const me = await telegram('getMe');
      bot = {
        id: Number(me?.id || 0) || null,
        username: me?.username || null,
        first_name: me?.first_name || null,
        can_join_groups: Boolean(me?.can_join_groups),
        can_read_all_group_messages: Boolean(me?.can_read_all_group_messages),
        supports_inline_queries: Boolean(me?.supports_inline_queries)
      };
    } catch (err) {
      botError = err?.message || 'telegram_get_me_failed';
    }
  }

  json(res, database ? 200 : 503, {
    ok: database,
    service: 'telegram-channel-cloner',
    version: '0.2.0-preview',
    environment: process.env.VERCEL_ENV || 'unknown',
    time: new Date().toISOString(),
    checks: {
      database,
      databaseError
    },
    configured: {
      supabase: Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)),
      telegramBot: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      telegramWebhook: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      readerIngest: Boolean(process.env.READER_INGEST_SECRET),
      adminAuth: Boolean(process.env.ADMIN_PASSWORD && process.env.SESSION_SECRET),
      cron: Boolean(process.env.CRON_SECRET)
    },
    ...(String(req.query?.bot || '') === '1' ? { bot, botError } : {})
  });
}
