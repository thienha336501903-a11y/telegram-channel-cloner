import { json } from '../lib/http.js';

export default async function handler(req, res) {
  json(res, 200, {
    ok: true,
    service: 'telegram-channel-cloner',
    version: '0.1.0',
    time: new Date().toISOString(),
    configured: {
      supabase: Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)),
      telegramBot: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      readerIngest: Boolean(process.env.READER_INGEST_SECRET)
    }
  });
}
