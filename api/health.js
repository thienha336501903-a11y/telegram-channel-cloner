import { json } from '../lib/http.js';
import { select } from '../lib/supabase.js';

export default async function handler(req, res) {
  let database = false;
  let databaseError = null;
  try {
    await select('tgcloner_sources', 'select=id&limit=1');
    database = true;
  } catch (err) {
    databaseError = err?.details?.code || err?.message || 'db_unavailable';
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
    }
  });
}
