import { json } from '../lib/http.js';
import { select } from '../lib/supabase.js';
import { TABLES } from '../lib/tables.js';
import { getMe, telegram } from '../lib/telegram.js';
import { probeMediaTicket } from './telegram/media.js';

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== 'preview') {
    return json(res, 404, { ok: false, error: 'not_found' });
  }

  const ticketProbe = String(req.query?.ticket_probe || '').trim();
  if (ticketProbe) {
    try {
      return json(res, 200, await probeMediaTicket(ticketProbe));
    } catch (error) {
      return json(res, Number(error?.status || 500), {
        ok: false,
        error: error?.code || error?.message || 'ticket_probe_failed'
      });
    }
  }

  const checks = {
    supabase: { ok: false },
    telegram: { ok: false },
    webhook: { ok: false }
  };

  try {
    const rows = await select(TABLES.settings, 'select=singleton,scheduler_enabled&limit=1');
    checks.supabase = {
      ok: Array.isArray(rows),
      settingsRows: Array.isArray(rows) ? rows.length : null,
      schedulerEnabled: Array.isArray(rows) && rows[0] ? Boolean(rows[0].scheduler_enabled) : false
    };
  } catch (error) {
    checks.supabase = { ok: false, error: error?.message || 'supabase_check_failed' };
  }

  try {
    const me = await getMe();
    checks.telegram = {
      ok: true,
      id: me?.id ?? null,
      username: me?.username ?? null,
      canJoinGroups: Boolean(me?.can_join_groups),
      supportsInlineQueries: Boolean(me?.supports_inline_queries)
    };
  } catch (error) {
    checks.telegram = { ok: false, error: error?.message || 'telegram_check_failed' };
  }

  try {
    const info = await telegram('getWebhookInfo');
    checks.webhook = {
      ok: true,
      configured: Boolean(info?.url),
      pendingUpdateCount: Number(info?.pending_update_count || 0),
      lastErrorDate: info?.last_error_date || null,
      lastErrorMessage: info?.last_error_message || null
    };
  } catch (error) {
    checks.webhook = { ok: false, error: error?.message || 'webhook_check_failed' };
  }

  const ok = checks.supabase.ok && checks.telegram.ok && checks.webhook.ok;
  return json(res, ok ? 200 : 503, { ok, checks });
}
